import { ConvexError, v } from "convex/values";
import type { MoneyProposalView, NormalizedAccountBundle, NormalizedBankTransaction } from "@mangekyo/contracts";
import { candidateOwnerSourceIds, depositCaseId, formatCents, normalizeErpState, type ErpState } from "@mangekyo/finance-core/intake";
import { activeAllocations, importLedgerEntries, ownerBalances } from "@mangekyo/finance-core/ledger";
import { supersededBlocked } from "@mangekyo/finance-core/gateway";
import { DEMO_ACCOUNT_ID, demoMoneyBundle, demoRunOf, demoSettlement, demoUnrecordedOutflow } from "@mangekyo/finance-core/fixtures/demo-money";
// Read-only use of the teammate's deterministic generator; his runtime state file is never touched.
import { createSeed } from "../apps/demo-erp/data/seed";
import { api, internal } from "./_generated/api";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { autoInvestigationSetting, providerMode } from "./financeInvestigations";
import { demoFeedStep, feedBundle, FEED_LENGTH, FEED_PAYMENT_PURPOSE } from "@mangekyo/finance-core/fixtures/demo-feed";
import { lawFirmBundle } from "@mangekyo/finance-core/fixtures/law-firm";
import { lawFirmFeedBundle, lawFirmSteps, lawId, LAW_FIRM_FEED_LENGTH, PARALEGAL, PARALEGAL_FEE_PURPOSE } from "@mangekyo/finance-core/fixtures/law-firm-feed";
import { demoAccountId } from "@mangekyo/finance-core/fixtures/demo-money";
import { nextProposalId, submitProposal } from "./lib/money";
import * as money from "./lib/moneyValidators";
import * as validators from "./lib/validators";
import { appendMoneyEvent, checkAccount, compact, LATEST, latestActivity, loadAccount, outstandingMaxDays, recheckHeldProposals, resolveActor, SYSTEM, getProposal, requireAccount, type LoadedAccount } from "./lib/money";
import { recordOnly } from "./lib/investigationRecords";

type SourceTable = "financeBankTransactions" | "financeAccountOwners" | "financeObligations" | "financeSourceDocuments" | "financeBankStatements" | "financeReconcilingItems";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Upsert keyed by sourceId: unchanged rows are not rewritten, so repeated imports create nothing. */
async function upsert(ctx: MutationCtx, table: SourceTable, row: { sourceId: string } & Record<string, unknown>): Promise<"inserted" | "updated" | "unchanged"> {
  const existing = await ctx.db.query(table).withIndex("by_sourceId", (q) => q.eq("sourceId", row.sourceId)).unique();
  if (!existing) { await ctx.db.insert(table, row as never); return "inserted"; }
  if (stable(recordOnly(existing)) === stable(row)) return "unchanged";
  await ctx.db.replace(table, existing._id, row as never);
  return "updated";
}

const importResult = v.object({ accountId: v.string(), inserted: v.number(), updated: v.number(), unchanged: v.number(), entriesInserted: v.number(), issues: v.array(money.issue) });

/** `automatic: false` imports without scheduling investigations or the reconciler (the smoke test's fresh accounts start nothing). */
export async function importBundle(ctx: MutationCtx, bundle: NormalizedAccountBundle, system: "erp" | "demo", options: { automatic?: boolean } = {}) {
  const now = Date.now();
  const accountId = bundle.account.accountId;
  const counts = { inserted: 0, updated: 0, unchanged: 0 };
  const groups: Array<[SourceTable, Array<{ sourceId: string } & object>]> = [
    ["financeAccountOwners", bundle.owners], ["financeBankTransactions", bundle.bankTransactions], ["financeObligations", bundle.obligations],
    ["financeSourceDocuments", bundle.documents], ["financeBankStatements", bundle.statementBalances], ["financeReconcilingItems", bundle.reconcilingItems],
  ];
  const newlyEligible = new Set<string>();
  for (const [table, rows] of groups) for (const row of rows) {
    const before = table === "financeBankTransactions" ? await ctx.db.query("financeBankTransactions").withIndex("by_sourceId", (q) => q.eq("sourceId", row.sourceId)).unique() : null;
    const result = await upsert(ctx, table, row as { sourceId: string });
    counts[result]++;
    if (before && before.clearing === "pending" && (row as NormalizedBankTransaction).clearing === "cleared") newlyEligible.add(row.sourceId);
  }
  const issues = [...bundle.issues];
  let entriesInserted = 0;
  for (const entry of importLedgerEntries(bundle, now, `import:${system}-adapter`)) {
    const existing = await ctx.db.query("financeLedgerEntries").withIndex("by_entryId", (q) => q.eq("entryId", entry.entryId)).unique();
    if (!existing) {
      await ctx.db.insert("financeLedgerEntries", compact(entry)); entriesInserted++;
      if (entry.kind === "deposit_received" && entry.fundsSourceId) newlyEligible.add(entry.fundsSourceId);
      continue;
    }
    // Ledger rows are never rewritten. A changed source value is reported, and the three-way check will show it.
    if (existing.amountCents !== entry.amountCents || existing.ownerId !== entry.ownerId) issues.push({ rawId: entry.entryId, reason: "Source value changed since the first import; the existing ledger entry was kept." });
  }
  const account = await ctx.db.query("financeAccounts").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).unique();
  const stored = { ...bundle.account, system, datasetVersion: bundle.account.raw.datasetVersion, importedAt: account?.importedAt ?? now, issues };
  if (!account) await ctx.db.insert("financeAccounts", stored);
  else if (stable({ ...recordOnly(account), importedAt: 0 }) !== stable({ ...stored, importedAt: 0 })) await ctx.db.replace("financeAccounts", account._id, stored);
  const loaded = await loadAccount(ctx, accountId);
  await appendMoneyEvent(ctx, { accountId, type: "finance.money.import_completed", actor: SYSTEM, operationId: `import:${accountId}:${now}`, stage: "import",
    message: `${system} import: ${counts.inserted} inserted, ${counts.updated} updated, ${counts.unchanged} unchanged source records; ${entriesInserted} new ledger entries; ${issues.length} issue(s).`,
    threeWay: checkAccount(loaded.state, now), sourceIds: issues.map(row => row.rawId) });
  if (options.automatic === false) return { accountId, ...counts, entriesInserted, issues };
  // A bulk import (more than 10 new deposits, e.g. the 200-deposit batch) starts its investigations a little apart: every settle reads the
  // whole account for the lock, so hundreds settling at once mostly conflict with each other.
  let order = 0;
  const stagger = newlyEligible.size > 10 ? AUTO_STAGGER_MS : 0;
  for (const bankSourceId of newlyEligible) await scheduleAutoInvestigation(ctx, loaded, bankSourceId, stagger * order++);
  await recheckHeldProposals(ctx, accountId);
  return { accountId, ...counts, entriesInserted, issues };
}

export const importErpSandbox = mutation({
  args: {}, returns: importResult,
  handler: async (ctx) => await importBundle(ctx, normalizeErpState(createSeed(42) as ErpState), "erp"),
});

export const loadDemoFixture = mutation({
  args: {}, returns: importResult,
  handler: async (ctx) => await importBundle(ctx, demoMoneyBundle(), "demo"),
});

/** The next DEMO pool number. Earlier accounts and their history are never reused or touched. */
export async function nextDemoRun(ctx: MutationCtx): Promise<number> {
  const accounts = await ctx.db.query("financeAccounts").take(500);
  const runs = accounts.map(a => demoRunOf(a.accountId)).filter((run): run is number => run !== null);
  return runs.length ? Math.max(...runs) + 1 : 1;
}

/** A new DEMO account (next pool number) with the fixture loaded clean. Earlier accounts and their history are untouched. */
export const startFreshDemoRun = mutation({
  args: { fixture: v.optional(v.literal("legacy")) }, returns: importResult,
  handler: async (ctx, args) => {
    const run = await nextDemoRun(ctx);
    return await importBundle(ctx, args.fixture === "legacy" ? demoMoneyBundle(run) : lawFirmBundle(demoAccountId(run)), "demo");
  },
});

async function insertDemoBankItem(ctx: MutationCtx, txn: NormalizedBankTransaction, message: string) {
  const existing = await ctx.db.query("financeBankTransactions").withIndex("by_sourceId", (q) => q.eq("sourceId", txn.sourceId)).unique();
  if (existing) return { sourceId: txn.sourceId, created: false };
  await ctx.db.insert("financeBankTransactions", txn);
  const loaded = await loadAccount(ctx, txn.accountId);
  await appendMoneyEvent(ctx, { accountId: txn.accountId, type: "finance.money.bank_item_recorded", actor: SYSTEM, operationId: txn.sourceId, stage: "bank_feed", message, threeWay: checkAccount(loaded.state, Date.now()), sourceIds: [txn.sourceId] });
  await recheckHeldProposals(ctx, txn.accountId);
  return { sourceId: txn.sourceId, created: true };
}

const simulated = v.object({ sourceId: v.string(), created: v.boolean() });

/** Mock bank return: the bank moved first. Books wait for a different person to record the return. */
export const simulateClientBounce = mutation({
  args: { accountId: v.string(), dev: money.devIdentity }, returns: simulated,
  handler: async (ctx, { accountId, dev }) => {
    const loaded = await loadAccount(ctx, accountId);
    if (providerMode() !== "mock" || loaded.account.datasetVersion !== "law-firm-demo-v1") throw new ConvexError("Client returns are simulated only in the mock law-firm demo.");
    const actor = await resolveActor(ctx, dev);
    if (actor.role !== "requester") throw new ConvexError("Switch to riley, requester, to simulate the return; sam can then approve the return entry.");
    const candidates = ["okafor-retainer", "nguyen-zelle"].map(key => loaded.state.bankTransactions.find(t => t.sourceId === lawId(accountId, `bank:txn:${key}`)));
    const original = candidates.find(t => t && activeAllocations(loaded.state.entries, t.sourceId).length > 0);
    if (!original) throw new ConvexError("First approve and post the Okafor or James Nguyen allocation.");
    const allocations = activeAllocations(loaded.state.entries, original.sourceId);
    if (allocations.length !== 1 || allocations[0].amountCents !== original.amountCents) throw new ConvexError("This demo return requires one complete owner allocation.");
    const owner = loaded.state.owners.find(o => o.ownerId === allocations[0].ownerId)!;
    const sourceId = `${original.sourceId}:returned`;
    const existing = await ctx.db.query("financeBankTransactions").withIndex("by_sourceId", q => q.eq("sourceId", sourceId)).unique();
    if (existing) return { sourceId, created: false };
    await ctx.db.insert("financeBankTransactions", { ...original, sourceId, direction: "outflow", clearing: "cleared", bookedAt: Date.now(), reference: `RETURN ${original.reference}`, ownerHintSourceId: owner.sourceId, duplicateOfSourceId: null, raw: { ...original.raw, recordType: "client-check-return", rawId: sourceId } });
    const after = await loadAccount(ctx, accountId);
    await appendMoneyEvent(ctx, { accountId, type: "finance.money.bank_item_recorded", actor, operationId: sourceId, stage: "bank_return",
      message: `Simulated bank return: ${formatCents(original.amountCents)} from ${original.counterparty} for ${owner.name}. A different person must approve the return entry.`, sourceIds: [sourceId, original.sourceId], threeWay: checkAccount(after.state, Date.now()) });
    await recheckHeldProposals(ctx, accountId);
    return { sourceId, created: true };
  },
});

/** A person's duplicate decision creates a refund-payable allocation through the ordinary gates. */
export const confirmDuplicate = mutation({
  args: { accountId: v.string(), bankSourceId: v.string(), dev: money.devIdentity }, returns: v.object({ proposalId: v.string() }),
  handler: async (ctx, args) => {
    const loaded = await loadAccount(ctx, args.accountId);
    if (providerMode() !== "mock" || loaded.account.datasetVersion !== "law-firm-demo-v1") throw new ConvexError("Duplicate decisions here are mock law-firm demo only.");
    const actor = await resolveActor(ctx, args.dev);
    const deposit = loaded.state.bankTransactions.find(t => t.sourceId === args.bankSourceId);
    if (!deposit?.duplicateOfSourceId || deposit.sourceId !== lawId(args.accountId, "bank:txn:bayview-second")) throw new ConvexError("Choose the second Bayview wire flagged as a possible duplicate.");
    const previous = loaded.proposals.find(p => p.bankSourceId === deposit.sourceId);
    if (previous) return { proposalId: previous.proposalId };
    const ownerId = lawId(args.accountId, "owner:bayview-refund");
    const sourceId = lawId(args.accountId, "document:bayview-duplicate-decision:v1");
    const text = `${actor.identity} confirmed the second $40,000.00 Bayview Title wire with reference ESC-2291 is a duplicate and must be returned to Bayview Title (refund payable).`;
    await ctx.db.insert("financeAccountOwners", { ownerId, sourceId: lawId(args.accountId, "owner-record:bayview-refund"), accountId: args.accountId, subAccount: "IOLTA", name: "Bayview Title (refund payable)", raw: { ...deposit.raw, recordType: "refund-payee", rawId: ownerId } });
    await ctx.db.insert("financeSourceDocuments", { sourceId, accountId: args.accountId, title: "Human duplicate and refund decision", documentType: "Human instruction", text, excerpt: text, version: "v1", namedOwnerSourceIds: [lawId(args.accountId, "owner-record:bayview-refund")], raw: { ...deposit.raw, recordType: "human-instruction", rawId: sourceId } });
    const taskId = depositTaskId(args.accountId, deposit.sourceId);
    const questions = await ctx.db.query("financeInvestigationQuestions").withIndex("by_taskId", q => q.eq("taskId", taskId)).take(100);
    for (const question of questions.filter(q => q.status === "open" && q.key === "duplicate-or-installment")) {
      const clarificationId = `${question.questionId}:clarification`;
      await ctx.db.insert("financeClarifications", { clarificationId, sourceId: `clarification:${clarificationId}`, questionId: question.questionId, question: question.question,
        answer: text, caseId: question.caseId, taskId, runId: question.runId, timestamp: Date.now(), respondent: { identity: actor.identity, authenticated: actor.authenticated }, evidenceRefs: [] });
      await ctx.db.patch(question._id, { status: "answered", clarificationId });
    }
    const now = Date.now();
    const proposalId = await nextProposalId(ctx, args.accountId, "allocation");
    await submitProposal(ctx, { proposalId, accountId: args.accountId, kind: "allocation", status: "proposed", currency: deposit.currency, requestedBy: actor.identity,
      origin: { type: "person" }, bankSourceId: deposit.sourceId, shares: [{ ownerId, amountCents: deposit.amountCents }], amountCents: deposit.amountCents,
      purpose: "Bayview duplicate refund payable", evidenceSourceIds: [deposit.sourceId, deposit.duplicateOfSourceId, sourceId], createdAt: now, updatedAt: now }, actor);
    await appendMoneyEvent(ctx, { accountId: args.accountId, type: "finance.money.bank_item_recorded", actor, operationId: proposalId, stage: "duplicate_decision", message: text, sourceIds: [sourceId, deposit.sourceId, deposit.duplicateOfSourceId] });
    return { proposalId };
  },
});

/** DEV ONLY, DEMO account only: a bank-feed outflow nobody recorded (scenario E). */
export const simulateUnrecordedOutflow = mutation({
  args: { accountId: v.optional(v.string()) }, returns: simulated,
  handler: async (ctx, args) => {
    const accountId = args.accountId ?? DEMO_ACCOUNT_ID;
    if (demoRunOf(accountId) === null) throw new ConvexError("Bank-feed items can only be simulated on DEMO accounts.");
    await requireAccount(ctx, accountId);
    return await insertDemoBankItem(ctx, demoUnrecordedOutflow(Date.now(), accountId), "DEMO bank feed: unrecorded outflow arrived (simulated).");
  },
});

/** DEV ONLY, DEMO account only: the bank feed confirms a posted payment. */
export const simulateSettlement = mutation({
  args: { proposalId: v.string() }, returns: simulated,
  handler: async (ctx, { proposalId }) => {
    const proposal = await getProposal(ctx, proposalId);
    if (demoRunOf(proposal.accountId) === null) throw new ConvexError("Bank settlement can only be simulated on the DEMO account; the ERP bank feed is the teammate's data.");
    if (proposal.kind !== "payment" || proposal.status !== "posted") throw new ConvexError("Only posted payments settle at the bank.");
    const loaded = await loadAccount(ctx, proposal.accountId);
    const ownerSourceId = loaded.state.owners.find(o => o.ownerId === proposal.ownerId)?.sourceId ?? null;
    return await insertDemoBankItem(ctx, demoSettlement(proposalId, proposal.amountCents, Date.now(), ownerSourceId, proposal.accountId), `DEMO bank feed: settlement of ${proposalId} arrived (simulated).`);
  },
});

export function depositTaskId(accountId: string, bankSourceId: string) {
  return `${depositCaseId(accountId)}:deposit:${bankSourceId}`;
}

/** Investigation moves no money. Pending deposits remain bank evidence, not allocatable transactions. */
function ineligibility(loaded: LoadedAccount, bankSourceId: string): { code: string; message: string } | null {
  const deposit = loaded.state.bankTransactions.find(t => t.sourceId === bankSourceId);
  if (!deposit || deposit.direction !== "inflow") return { code: "NOT_A_DEPOSIT", message: "Only bank deposits can be investigated." };
  if (!loaded.state.entries.some(e => e.kind === "deposit_received" && e.fundsSourceId === bankSourceId)) return { code: "NOT_RECORDED", message: "This deposit is not recorded in the ledger (it predates the cutover and is reflected in opening balances)." };
  if (activeAllocations(loaded.state.entries, bankSourceId).length > 0) return { code: "ALREADY_ALLOCATED", message: "This deposit is already allocated." };
  return null;
}

async function ensureTaskRow(ctx: MutationCtx, loaded: LoadedAccount, bankSourceId: string): Promise<{ taskId: string; created: boolean }> {
  const accountId = loaded.state.account.accountId;
  const taskId = depositTaskId(accountId, bankSourceId);
  const existing = await ctx.db.query("financeTasks").withIndex("by_taskId", (q) => q.eq("taskId", taskId)).unique();
  if (existing) return { taskId, created: false };
  const blocked = ineligibility(loaded, bankSourceId);
  if (blocked) throw new ConvexError(blocked.message);
  const deposit = loaded.state.bankTransactions.find(t => t.sourceId === bankSourceId)!;
  const candidates = candidateOwnerSourceIds({ deposit, documents: loaded.documents, obligations: loaded.obligations, state: loaded.state });
  const candidate = loaded.state.owners.find(o => o.sourceId === candidates[0]);
  const linked = loaded.documents.filter(d => deposit.documentSourceIds.includes(d.sourceId));
  await ctx.db.insert("financeTasks", {
    synthetic: true, caseId: depositCaseId(accountId), taskId, runId: `${taskId}:run:001`, transactionId: deposit.sourceId,
    candidateOwnerId: candidate?.ownerId ?? "unidentified", evidenceRefs: linked.map(d => ({ sourceId: d.sourceId, documentId: d.raw.rawId, excerpt: d.excerpt })),
    status: "awaiting_investigation", createdAt: Date.now(), accountId, bankSourceId,
  });
  return { taskId, created: true };
}

/** DEMO live feed, mock mode only: adds the next scripted step through the normal import path. Same order every time. */
export const feedNext = mutation({
  args: { accountId: v.string() },
  returns: v.object({ step: v.number(), total: v.number(), label: v.union(v.string(), v.null()), done: v.boolean() }),
  handler: async (ctx, { accountId }) => {
    if (providerMode() !== "mock") throw new ConvexError("The live feed runs only in mock mode. In CREAO mode every investigation costs money, so it never starts here.");
    await requireAccount(ctx, accountId);
    const loaded = await loadAccount(ctx, accountId);
    if (loaded.account.datasetVersion === "law-firm-demo-v1") return await advanceLawFirmFeed(ctx, loaded);
    for (let index = 0; index < FEED_LENGTH; index++) {
      const step = demoFeedStep(index, accountId, Date.now());
      if (!step) break;
      const done = step.kind === "payment" ? loaded.proposals.some(p => p.purpose === FEED_PAYMENT_PURPOSE) : loaded.state.bankTransactions.some(t => t.sourceId === step.marker);
      if (done) continue;
      if (step.kind === "import") await importBundle(ctx, feedBundle(step, accountId), "demo");
      else {
        const now = Date.now();
        await submitProposal(ctx, { proposalId: await nextProposalId(ctx, accountId, "payment"), accountId, kind: "payment", status: "proposed", currency: loaded.state.account.currency,
          requestedBy: "dev-unverified:riley", origin: { type: "person" }, evidenceSourceIds: step.evidenceSourceIds, ownerId: step.ownerId, amountCents: step.amountCents, purpose: step.purpose, createdAt: now, updatedAt: now },
          { identity: "dev-unverified:riley", authenticated: false, role: "requester" });
      }
      await appendMoneyEvent(ctx, { accountId, type: "finance.money.feed_step", actor: SYSTEM, operationId: `feed:${accountId}:${index + 1}`, stage: "feed", message: `Live feed step ${index + 1} of ${FEED_LENGTH}: ${step.label}.` });
      return { step: index + 1, total: FEED_LENGTH, label: step.label, done: index + 1 === FEED_LENGTH };
    }
    return { step: FEED_LENGTH, total: FEED_LENGTH, label: null, done: true };
  },
});

async function advanceLawFirmFeed(ctx: MutationCtx, loaded: LoadedAccount) {
  const accountId = loaded.account.accountId;
  const events = await ctx.db.query("financeEvents").withIndex("by_taskId_and_sequence", q => q.eq("taskId", `money:${accountId}`)).take(2000);
  const step = events.filter(e => e.type === "finance.money.feed_step").length + 1;
  const total = LAW_FIRM_FEED_LENGTH;
  if (step > total) return { step: total, total, label: null, done: true };
  const id = (suffix: string) => lawId(accountId, suffix);
  if ([1, 4, 5, 6, 9].includes(step)) await importBundle(ctx, lawFirmFeedBundle(step, accountId, Date.now()), "demo");
  // Step 2: the Disbursement agent prepares Delgado's three payout lines from the signed settlement statement before the check clears;
  // the lock blocks each line (L2: the funds haven't cleared). After clearing and allocation it runs again on its own.
  if (step === 2) await ctx.runMutation(internal.financeTrust.autoStartDisbursement, { accountId, bankSourceId: id("bank:txn:harborline-delgado"), trigger: "person_started" });
  if (step === 7) {
    const now = Date.now();
    await submitProposal(ctx, { proposalId: await nextProposalId(ctx, accountId, "payment"), accountId, kind: "payment", status: "proposed", currency: "USD",
      requestedBy: "dev-unverified:riley", origin: { type: "person" }, ownerId: id("owner:raymond-cho"), amountCents: 90_000_000, purpose: "Raymond Hayes expert witness",
      evidenceSourceIds: [id("document:cho-expert:v1")], createdAt: now, updatedAt: now },
      { identity: "dev-unverified:riley", authenticated: false, role: "requester" });
  }
  // Step 10: a paralegal moves $3,000.00 of Chen & Park fees to the firm with no approved invoice and no settlement statement: blocked by L9.
  if (step === 10) {
    const now = Date.now();
    await submitProposal(ctx, { proposalId: await nextProposalId(ctx, accountId, "payment"), accountId, kind: "payment", status: "proposed", currency: "USD",
      requestedBy: PARALEGAL, origin: { type: "person" }, ownerId: id("owner:chen-park"), payeeOwnerId: id("owner:firm"), payoutKind: "attorney_fee", amountCents: 300_000, purpose: PARALEGAL_FEE_PURPOSE,
      evidenceSourceIds: [id("owner-record:chen-park")], createdAt: now, updatedAt: now },
      { identity: PARALEGAL, authenticated: false, role: "requester" });
  }
  if (step === 3) await ctx.runMutation(api.financeIntake.simulateDepositCleared, { bankSourceId: id("bank:txn:harborline-delgado") });
  if (step === 8) {
    const bankSourceId = id("bank:txn:harborline-delgado");
    if (!activeAllocations(loaded.state.entries, bankSourceId).length) throw new ConvexError("Approve and post Maria Delgado's allocation before proposing the policy.");
    const taskId = depositTaskId(accountId, bankSourceId);
    await ctx.runMutation(internal.financeInvestigations.autoStartInvestigation, { taskId, scope: { kind: "deposit_investigation", accountId, currency: "USD", from: null }, trigger: "auto_start" });
  }
  const label = lawFirmSteps[step - 1];
  await appendMoneyEvent(ctx, { accountId, type: "finance.money.feed_step", actor: SYSTEM, operationId: `feed:${accountId}:${step}`, stage: "feed", message: `Live feed step ${step} of ${total}: ${label}.` });
  return { step, total, label, done: step === total };
}

/** DEV ONLY, DEMO accounts only: the bank feed reports a pending demo deposit as cleared. */
export const simulateDepositCleared = mutation({
  args: { bankSourceId: v.string() }, returns: v.object({ sourceId: v.string(), changed: v.boolean() }),
  handler: async (ctx, { bankSourceId }) => {
    const row = await ctx.db.query("financeBankTransactions").withIndex("by_sourceId", (q) => q.eq("sourceId", bankSourceId)).unique();
    if (!row || !row.accountId.startsWith("demo:account:")) throw new ConvexError("Only DEMO bank-feed deposits can be cleared by simulation.");
    if (row.direction !== "inflow" || row.clearing === "cleared") return { sourceId: bankSourceId, changed: false };
    await ctx.db.patch("financeBankTransactions", row._id, { clearing: "cleared" });
    const loaded = await loadAccount(ctx, row.accountId);
    await appendMoneyEvent(ctx, { accountId: row.accountId, type: "finance.money.bank_item_recorded", actor: SYSTEM, operationId: bankSourceId, stage: "bank_feed", message: `DEMO bank feed: ${bankSourceId} cleared (simulated).`, threeWay: checkAccount(loaded.state, Date.now()), sourceIds: [bankSourceId] });
    await recheckHeldProposals(ctx, row.accountId);
    await scheduleAutoInvestigation(ctx, loaded, bankSourceId);
    return { sourceId: bankSourceId, changed: true };
  },
});

/** A fix, not a payment: records in the ledger a bank-feed item that already happened. Approver only. */
export const recordBankItem = mutation({
  args: { accountId: v.string(), bankSourceId: v.string(), ownerId: v.optional(v.string()), dev: money.devIdentity },
  returns: v.object({ entryId: v.string() }),
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (actor.role !== "approver") throw new ConvexError("Switch to the approver role to record a bank item.");
    const loaded = await loadAccount(ctx, args.accountId);
    const txn = loaded.state.bankTransactions.find(t => t.sourceId === args.bankSourceId);
    if (!txn) throw new ConvexError("Unknown bank transaction for this account.");
    if (txn.raw.recordType === "client-check-return") {
      const events = await ctx.db.query("financeEvents").withIndex("by_taskId_and_sequence", q => q.eq("taskId", `money:${args.accountId}`)).take(2000);
      const decision = events.find(e => e.type === "finance.money.bank_item_recorded" && e.runId === txn.sourceId);
      if (!decision || decision.actor.type !== "human" || decision.actor.identity === actor.identity) throw new ConvexError("L4: a different person must approve the bank return entry.");
    }
    const linked = loaded.state.entries.some(e => e.sourceRefs.includes(txn.sourceId) || e.fundsSourceId === txn.sourceId || (!!e.bankReference && e.bankReference === txn.reference));
    if (linked) throw new ConvexError("This bank item is already recorded in the ledger.");
    const ownerId = args.ownerId ?? loaded.state.owners.find(o => o.sourceId === txn.ownerHintSourceId)?.ownerId;
    if (txn.direction === "outflow" && (!ownerId || !loaded.state.owners.some(o => o.ownerId === ownerId))) throw new ConvexError("Choose the owner this outflow belongs to.");
    const now = Date.now();
    const entryId = `record:${txn.sourceId}`;
    await ctx.db.insert("financeLedgerEntries", compact({
      entryId, accountId: args.accountId, ownerId: txn.direction === "outflow" ? ownerId! : null, amountCents: txn.direction === "outflow" ? -txn.amountCents : txn.amountCents,
      currency: txn.currency, kind: txn.direction === "outflow" ? "disbursement" as const : "deposit_received" as const, status: "posted" as const, sourceRefs: [txn.sourceId],
      fundsSourceId: txn.direction === "inflow" ? txn.sourceId : undefined, memo: `Recorded from bank feed (${txn.reference}) by ${actor.identity}`, effectiveAt: txn.bookedAt, createdAt: now, createdBy: actor.identity,
    }));
    const after = await loadAccount(ctx, args.accountId);
    await appendMoneyEvent(ctx, { accountId: args.accountId, type: "finance.money.bank_item_recorded", actor, operationId: txn.sourceId, stage: "record_bank_item", message: `Recorded ${txn.sourceId} in the ledger as ${txn.direction === "outflow" ? `a disbursement for ${ownerId}` : "an unallocated deposit"}.`, threeWay: checkAccount(after.state, now), sourceIds: [txn.sourceId], entryIds: [entryId] });
    await recheckHeldProposals(ctx, args.accountId);
    return { entryId };
  },
});

/** Creates (once) the investigation task for a cleared, recorded, unallocated deposit. */
export const ensureDepositTask = mutation({
  args: { accountId: v.string(), bankSourceId: v.string() }, returns: v.object({ taskId: v.string(), created: v.boolean() }),
  handler: async (ctx, { accountId, bankSourceId }) => await ensureTaskRow(ctx, await loadAccount(ctx, accountId), bankSourceId),
});

async function autoEvent(ctx: MutationCtx, accountId: string, bankSourceId: string, started: boolean, code: string, message: string, runId?: string) {
  await appendMoneyEvent(ctx, { accountId, type: "finance.money.auto_investigation", actor: SYSTEM, operationId: `auto:${bankSourceId}`, stage: "auto_investigation",
    message: `${started ? "Auto-investigation started" : "Auto-investigation skipped"} for ${bankSourceId}: ${message}${runId ? ` Run ${runId}.` : ""}`,
    lock: { allowed: started, stage: "request", failures: [], evaluated: [], facts: { autoInvestigation: code } }, sourceIds: [bankSourceId, ...(runId ? [runId] : [])] });
}

/** Import-time decision: schedule when the setting allows it, otherwise record the skip and its reason now. */
const AUTO_STAGGER_MS = 400;

async function scheduleAutoInvestigation(ctx: MutationCtx, loaded: LoadedAccount, bankSourceId: string, delayMs = 0) {
  const accountId = loaded.state.account.accountId;
  const setting = autoInvestigationSetting();
  if (!setting.enabled) return await autoEvent(ctx, accountId, bankSourceId, false, setting.code, setting.message);
  const blocked = ineligibility(loaded, bankSourceId);
  if (blocked) return await autoEvent(ctx, accountId, bankSourceId, false, blocked.code, blocked.message);
  await ctx.scheduler.runAfter(delayMs, internal.financeIntake.autoInvestigateDeposit, { accountId, bankSourceId });
}

/** One investigation per deposit: rechecks the setting and eligibility, and never starts a second run for a task. */
export const autoInvestigateDeposit = internalMutation({
  args: { accountId: v.string(), bankSourceId: v.string() }, returns: v.null(),
  handler: async (ctx, { accountId, bankSourceId }) => {
    const setting = autoInvestigationSetting();
    if (!setting.enabled) { await autoEvent(ctx, accountId, bankSourceId, false, setting.code, setting.message); return null; }
    const loaded = await loadAccount(ctx, accountId);
    const existing = await ctx.db.query("financeTasks").withIndex("by_taskId", (q) => q.eq("taskId", depositTaskId(accountId, bankSourceId))).unique();
    const prior = existing && await ctx.db.query("financeInvestigationRuns").withIndex("by_taskId_and_attempt", (q) => q.eq("taskId", existing.taskId)).order("desc").first();
    // Only the simulated clearance workflow gets a new automatic attempt. Never retry a paid run.
    const clearedAfterReview = providerMode() === "mock" && prior?.mode === "mock" && prior.status === "completed"
      && prior.result?.outcome === "findings" && prior.providerInput?.records.transactions.length === 0
      && prior.providerInput.records.bankTransactions?.some(t => t.sourceId === bankSourceId && t.clearing === "pending")
      && loaded.state.bankTransactions.some(t => t.sourceId === bankSourceId && t.clearing === "cleared");
    if (prior && !clearedAfterReview) { await autoEvent(ctx, accountId, bankSourceId, false, "ALREADY_INVESTIGATED", `Task already has investigation ${prior.runId}; no second run.`); return null; }
    const blocked = ineligibility(loaded, bankSourceId);
    if (blocked) { await autoEvent(ctx, accountId, bankSourceId, false, blocked.code, blocked.message); return null; }
    const { taskId } = await ensureTaskRow(ctx, loaded, bankSourceId);
    try {
      // Nested mutation: a failed start rolls back on its own while the skip is still recorded here.
      const started = await ctx.runMutation(internal.financeInvestigations.autoStartInvestigation, { taskId, scope: { kind: "deposit_investigation", accountId, currency: loaded.state.account.currency, from: null }, trigger: clearedAfterReview ? "deposit_cleared" : "auto_start" });
      if (started.refused) await autoEvent(ctx, accountId, bankSourceId, false, started.refused.code, started.refused.message);
      else await autoEvent(ctx, accountId, bankSourceId, started.created, started.created ? "AUTO_STARTED" : "ALREADY_INVESTIGATED", started.created ? "Proposals from this run still need a person to approve." : "An investigation is already active.", started.runId);
    } catch (error) {
      await autoEvent(ctx, accountId, bankSourceId, false, "START_FAILED", error instanceof ConvexError && typeof error.data === "string" ? error.data : "The investigation could not be started.");
    }
    return null;
  },
});

const depositRow = v.object({
  transaction: money.bankTransaction, status: v.union(v.literal("historical"), v.literal("awaiting_clearance"), v.literal("unallocated"), v.literal("proposed"), v.literal("posted")),
  taskId: v.union(v.string(), v.null()), allocatedTo: v.array(v.string()),
});

export const listAccounts = query({
  args: {}, returns: v.array(money.storedAccount),
  handler: async (ctx) => (await ctx.db.query("financeAccounts").order("desc").take(500)).map(recordOnly),
});

/** Everything the money panel shows for one account. Omit cutoff for the latest recorded state. */
export const getAccountOverview = query({
  // `now` ages outstanding items (queries cannot read the clock); the client passes its time, rounded to the minute.
  args: { accountId: v.string(), cutoff: v.optional(v.number()), now: v.optional(v.number()) },
  returns: v.object({
    outstandingMaxDays: v.number(), reconcilingItems: v.array(money.reconcilingItem),
    account: money.storedAccount, threeWay: money.threeWay, balances: v.array(money.ownerBalance), deposits: v.array(depositRow),
    owners: v.array(money.owner), documents: v.array(v.object({ sourceId: v.string(), title: v.string(), documentType: v.string(), excerpt: v.string() })),
    obligations: v.array(money.obligation), entries: v.array(money.ledgerEntry), proposals: v.array(money.proposalView),
  }),
  handler: async (ctx, { accountId, cutoff, now }) => {
    const loaded = await loadAccount(ctx, accountId);
    const at = cutoff ?? LATEST;
    const tasks = await ctx.db.query("financeTasks").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(200);
    const deposits = loaded.state.bankTransactions.filter(t => t.direction === "inflow").sort((a, b) => a.bookedAt - b.bookedAt).map(transaction => {
      const recorded = loaded.state.entries.some(e => e.kind === "deposit_received" && e.fundsSourceId === transaction.sourceId);
      const allocatedTo = activeAllocations(loaded.state.entries, transaction.sourceId).map(e => e.ownerId!);
      const proposed = loaded.proposals.some(p => p.kind === "allocation" && p.bankSourceId === transaction.sourceId && (p.status === "pending_approval" || p.status === "approved"));
      const status = allocatedTo.length ? "posted" as const : !recorded ? "historical" as const : transaction.clearing !== "cleared" ? "awaiting_clearance" as const : proposed ? "proposed" as const : "unallocated" as const;
      return { transaction, status, taskId: tasks.find(t => t.bankSourceId === transaction.sourceId)?.taskId ?? null, allocatedTo };
    });
    const { _id, _creationTime, ...account } = loaded.account;
    const superseded = supersededBlocked(loaded.proposals);
    return {
      outstandingMaxDays: outstandingMaxDays(), reconcilingItems: loaded.state.reconcilingItems,
      account, threeWay: checkAccount(loaded.state, at, now ?? latestActivity(loaded)), balances: ownerBalances(loaded.state, at), deposits,
      owners: loaded.state.owners, documents: loaded.documents.map(d => ({ sourceId: d.sourceId, title: d.title, documentType: d.documentType, excerpt: d.excerpt })),
      obligations: loaded.obligations,
      entries: [...loaded.state.entries].sort((a, b) => b.effectiveAt - a.effectiveAt || b.entryId.localeCompare(a.entryId)).slice(0, 200),
      proposals: [...loaded.proposals].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map((p): MoneyProposalView => superseded.has(p.proposalId) ? { ...p, superseded: superseded.get(p.proposalId)! } : p),
    };
  },
});

/** Task plus readable evidence text for the investigation view of an intake deposit. */
export const getDepositSubject = query({
  args: { taskId: v.string() },
  returns: v.union(v.null(), v.object({ task: validators.task, accountId: v.string(), currency: v.string(), evidence: v.array(v.object({ sourceId: v.string(), text: v.string() })) })),
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.query("financeTasks").withIndex("by_taskId", (q) => q.eq("taskId", taskId)).unique();
    if (!task?.accountId) return null;
    const loaded = await loadAccount(ctx, task.accountId);
    const evidence = [
      ...loaded.state.bankTransactions.map(t => ({ sourceId: t.sourceId, text: `${t.direction} ${formatCents(t.amountCents, t.currency)} · ${t.counterparty} · ${t.reference} · ${t.clearing}` })),
      ...loaded.documents.map(d => ({ sourceId: d.sourceId, text: `${d.title}: ${d.excerpt}` })),
      ...loaded.obligations.map(o => ({ sourceId: o.sourceId, text: o.excerpt })),
    ];
    return { task: recordOnly(task), accountId: task.accountId, currency: loaded.state.account.currency, evidence };
  },
});
