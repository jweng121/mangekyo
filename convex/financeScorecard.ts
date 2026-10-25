import { ConvexError, v } from "convex/values";
import type { MoneyProposal } from "@mangekyo/contracts";
import { demoAccountId } from "@mangekyo/finance-core/fixtures/demo-money";
import { lawFirmBundle } from "@mangekyo/finance-core/fixtures/law-firm";
import { lawId } from "@mangekyo/finance-core/fixtures/law-firm-feed";
import { formatCents } from "@mangekyo/finance-core/intake";
import { batchBundle, batchKindOf, OVERDRAW_PURPOSE, PLANTS, scorecardBundle, scorePlant, summarizeBatch, summarizePlants, UNCLEARED_PAYOUT_PURPOSE, type BatchRow } from "@mangekyo/finance-core/scorecard";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { depositTaskId, importBundle, nextDemoRun } from "./financeIntake";
import { providerMode } from "./financeInvestigations";
import { appendMoneyEvent, checkAccount, gatedStep, loadAccount, nextProposalId, recheckHeldProposals, submitProposal, type Actor } from "./lib/money";
import { recordOnly } from "./lib/investigationRecords";

/**
 * Measuring the agents in mock mode. Every run is a fresh DEMO account; nothing earlier is touched.
 * The harness acts as riley (requester) and sam (approver), exactly as the desk's dev role switcher would.
 */

const RILEY: Actor = { identity: "dev-unverified:riley", authenticated: false, role: "requester" };
const SAM: Actor = { identity: "dev-unverified:sam", authenticated: false, role: "approver" };

function requireMock() {
  if (providerMode() !== "mock") throw new ConvexError("The scorecard runs only in mock mode. In CREAO mode every investigation is a paid run, so it never starts here.");
}

async function payment(ctx: MutationCtx, accountId: string, ownerId: string, amountCents: number, purpose: string, evidence: string, fundingSourceId?: string) {
  const now = Date.now();
  await submitProposal(ctx, { proposalId: await nextProposalId(ctx, accountId, "payment"), accountId, kind: "payment", status: "proposed", currency: "USD", requestedBy: RILEY.identity, origin: { type: "person" },
    ownerId, amountCents, purpose, evidenceSourceIds: [evidence], ...(fundingSourceId ? { fundingSourceId } : {}), createdAt: now, updatedAt: now }, RILEY);
}

/** Six planted mistakes in a fresh law-firm run, each with a known right answer (see PLANTS). Investigations run on their own afterwards. */
export const runPlanted = mutation({
  args: {}, returns: v.object({ accountId: v.string(), scorecardId: v.string() }),
  handler: async (ctx) => {
    requireMock();
    const accountId = demoAccountId(await nextDemoRun(ctx));
    const id = (suffix: string) => lawId(accountId, suffix);
    await importBundle(ctx, lawFirmBundle(accountId), "demo");
    await importBundle(ctx, scorecardBundle(accountId, Date.now()), "demo");
    // Uncleared payout and overdraw: the lock decides at request time.
    await payment(ctx, accountId, id("owner:maria-delgado"), 5_600_000, UNCLEARED_PAYOUT_PURPOSE, id("document:delgado-settlement:v1"), id("bank:txn:plant-harborline-delgado"));
    await payment(ctx, accountId, id("owner:raymond-cho"), 90_000_000, OVERDRAW_PURPOSE, id("document:cho-expert:v1"));
    // Bounced check: riley allocates Okafor's check, sam approves and posts it, then the bank returns it.
    const deposit = id("bank:txn:plant-okafor");
    const now = Date.now();
    const draft: MoneyProposal = { proposalId: await nextProposalId(ctx, accountId, "allocation"), accountId, kind: "allocation", status: "proposed", currency: "USD", requestedBy: RILEY.identity, origin: { type: "person" },
      bankSourceId: deposit, shares: [{ ownerId: id("owner:daniel-okafor"), amountCents: 250_000 }], amountCents: 250_000, purpose: "Okafor retainer (scorecard)", evidenceSourceIds: [deposit, id("document:okafor-engagement:v1")], createdAt: now, updatedAt: now };
    const { proposal } = await submitProposal(ctx, draft, RILEY);
    const approved = await gatedStep(ctx, proposal, "approve", SAM);
    const posted = await gatedStep(ctx, approved.proposal, "post", SAM);
    if (posted.proposal.status !== "posted") throw new Error(`The Okafor allocation should post; it is ${posted.proposal.status}.`);
    const loaded = await loadAccount(ctx, accountId);
    const original = loaded.state.bankTransactions.find(t => t.sourceId === deposit)!;
    const returned = `${deposit}:returned`;
    await ctx.db.insert("financeBankTransactions", { ...original, sourceId: returned, direction: "outflow", clearing: "cleared", bookedAt: Date.now(), reference: `RETURN ${original.reference}`, ownerHintSourceId: id("owner-record:daniel-okafor"), duplicateOfSourceId: null, raw: { ...original.raw, recordType: "client-check-return", rawId: returned } });
    const after = await loadAccount(ctx, accountId);
    await appendMoneyEvent(ctx, { accountId, type: "finance.money.bank_item_recorded", actor: RILEY, operationId: returned, stage: "bank_return",
      message: `Scorecard: the bank returned ${formatCents(original.amountCents)} from ${original.counterparty} for Daniel Okafor.`, sourceIds: [returned, deposit], threeWay: checkAccount(after.state, Date.now()) });
    await recheckHeldProposals(ctx, accountId);
    const scorecardId = `${accountId}:scorecard:planted`;
    await ctx.db.insert("financeScorecards", { scorecardId, accountId, kind: "planted", count: PLANTS.length, startedAt: now });
    return { accountId, scorecardId };
  },
});

/** N synthetic deposits with known right answers on a fresh DEMO account. The ordinary pipeline investigates each one. */
export const runBatch = mutation({
  args: { count: v.optional(v.number()) }, returns: v.object({ accountId: v.string(), scorecardId: v.string(), count: v.number() }),
  handler: async (ctx, args) => {
    requireMock();
    const count = args.count ?? 200;
    if (!Number.isInteger(count) || count < 1 || count > 300) throw new ConvexError("A batch has 1–300 deposits.");
    const accountId = demoAccountId(await nextDemoRun(ctx));
    const now = Date.now();
    await importBundle(ctx, batchBundle(accountId, count, now), "demo");
    const scorecardId = `${accountId}:scorecard:batch`;
    await ctx.db.insert("financeScorecards", { scorecardId, accountId, kind: "batch", count, startedAt: now });
    return { accountId, scorecardId, count };
  },
});

const plantRow = v.object({ key: v.string(), label: v.string(), mistake: v.string(), rightAnswer: v.string(), catcher: v.string(), status: v.union(v.literal("caught"), v.literal("wrong"), v.literal("pending")), askedPerson: v.boolean(), detail: v.string(), link: v.union(v.string(), v.null()) });
const summary = v.object({ caught: v.number(), wrong: v.number(), askedPerson: v.number(), pending: v.number(), total: v.number(), line: v.string() });
const batchSummary = v.object({ count: v.number(), settled: v.number(), durationMs: v.union(v.number(), v.null()), handledWithoutPerson: v.number(), flagged: v.number(), waiting: v.number(), matchedRightAnswer: v.number(), pctHandled: v.number(), pctFlagged: v.number(), line: v.string() });

/** Scores the account's scorecard from saved state. Null when the account isn't a scorecard run. */
export const getScorecard = query({
  args: { accountId: v.string() },
  returns: v.union(v.null(),
    v.object({ kind: v.literal("planted"), scorecardId: v.string(), startedAt: v.number(), plants: v.array(plantRow), summary }),
    v.object({ kind: v.literal("batch"), scorecardId: v.string(), startedAt: v.number(), summary: batchSummary, byState: v.record(v.string(), v.number()) })),
  handler: async (ctx, { accountId }) => {
    const card = await ctx.db.query("financeScorecards").withIndex("by_accountId", q => q.eq("accountId", accountId)).first();
    if (!card) return null;
    const orchestrations = (await ctx.db.query("financeOrchestrations").withIndex("by_accountId", q => q.eq("accountId", accountId)).take(400)).map(recordOnly);
    const byTask = new Map(orchestrations.map(o => [o.taskId, o]));
    if (card.kind === "batch") {
      const bank = await ctx.db.query("financeBankTransactions").withIndex("by_accountId", q => q.eq("accountId", accountId)).take(400);
      const rows: BatchRow[] = bank.flatMap(t => {
        const kind = batchKindOf(t.raw.rawId);
        if (!kind || t.direction !== "inflow") return [];
        const o = byTask.get(depositTaskId(accountId, t.sourceId));
        const attempts = Number(/:investigation:(\d+)$/.exec(o?.lastRunId ?? "")?.[1] ?? 0);
        return [{ kind, state: o?.state ?? null, attempts, settledAt: o?.updatedAt ?? null }];
      });
      const byState: Record<string, number> = {};
      for (const r of rows) byState[r.state ?? "not_started"] = (byState[r.state ?? "not_started"] ?? 0) + 1;
      return { kind: "batch" as const, scorecardId: card.scorecardId, startedAt: card.startedAt, summary: summarizeBatch(rows, card.startedAt), byState };
    }
    const proposals = (await ctx.db.query("financeProposals").withIndex("by_accountId", q => q.eq("accountId", accountId)).take(500)).map(recordOnly);
    const corrections = (await ctx.db.query("financeCorrections").withIndex("by_accountId", q => q.eq("accountId", accountId)).take(50)).map(recordOnly);
    const id = (suffix: string) => lawId(accountId, suffix);
    const plants = PLANTS.map(plant => {
      const s = plant.subject;
      let link: string | null = null;
      let seen: Parameters<typeof scorePlant>[1];
      if (s.kind === "deposit") {
        const bank = id(s.bank);
        const o = byTask.get(depositTaskId(accountId, bank));
        link = o?.lastRunId ? `/runs/${encodeURIComponent(o.lastRunId)}` : null;
        seen = { state: o?.state ?? null, allocationReachedApproval: proposals.some(p => p.kind === "allocation" && p.bankSourceId === bank && ["pending_approval", "approved", "posted", "on_hold"].includes(p.status)) };
      } else if (s.kind === "payment") {
        const p = proposals.find(row => row.purpose === s.purpose);
        seen = { state: null, payment: p ? { status: p.status, rules: (p.blockedReasons ?? []).map(f => f.rule) } : null };
      } else {
        const key = `BANK_TXN_WITHOUT_LEDGER_ENTRY:${id(s.bank)}`;
        const o = byTask.get(`recon:${accountId}:${key}`);
        const c = corrections.find(row => row.causeKey === key);
        link = o?.lastRunId ? `/reconciliation/${encodeURIComponent(o.lastRunId)}` : null;
        seen = { state: o?.state ?? null, correction: c ? { ownerId: c.entry.ownerId, amountCents: c.entry.amountCents, status: c.status } : null };
      }
      const score = scorePlant(plant, seen, id);
      return { key: plant.key, label: plant.label, mistake: plant.mistake, rightAnswer: plant.rightAnswer, catcher: plant.catcher, status: score.status, askedPerson: score.askedPerson, detail: score.detail, link };
    });
    return { kind: "planted" as const, scorecardId: card.scorecardId, startedAt: card.startedAt, plants, summary: summarizePlants(plants.map(p => ({ key: p.key as never, status: p.status, askedPerson: p.askedPerson, detail: p.detail }))) };
  },
});

/** Scorecards across accounts, newest first, for the desk's "Measure" menu. */
export const listScorecards = query({
  args: {}, returns: v.array(v.object({ scorecardId: v.string(), accountId: v.string(), kind: v.union(v.literal("planted"), v.literal("batch"), v.literal("audit_drill")), count: v.number(), startedAt: v.number() })),
  handler: async (ctx) => (await ctx.db.query("financeScorecards").order("desc").take(20)).map(recordOnly),
});
