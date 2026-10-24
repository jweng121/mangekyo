/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const sam = { role: "approver" as const, name: "sam" };
type T = ReturnType<typeof convexTest>;
async function drain(t: T, rounds = 12) { for (let i = 0; i < rounds; i++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); } }

describe("scorecard (mock mode)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("catches 6 of 6 planted mistakes in a fresh law-firm run, wrong 0, asking a person twice", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.startFreshDemoRun, {});
    const { accountId } = await t.mutation(api.financeScorecard.runPlanted, {});
    expect(accountId).toBe("demo:account:pool-002");
    const pending = await t.query(api.financeScorecard.getScorecard, { accountId });
    expect(pending?.kind === "planted" && pending.summary.pending).toBeGreaterThan(0);
    await drain(t);
    const card = await t.query(api.financeScorecard.getScorecard, { accountId });
    if (card?.kind !== "planted") throw new Error("expected a planted scorecard");
    expect(card.plants.map(p => [p.key, p.status, p.askedPerson])).toEqual([
      ["wrong-client", "caught", false], ["duplicate", "caught", true], ["uncleared-payout", "caught", false],
      ["overdraw", "caught", false], ["unsupported-claim", "caught", false], ["bounced-check", "caught", true],
    ]);
    expect(card.summary.line).toBe("Caught 6 of 6 · wrong 0 · asked a person 2");
    expect(card.plants.find(p => p.key === "bounced-check")?.link).toMatch(/^\/reconciliation\//);
    // The control deposit (the first Bayview wire) still reaches a person for sign-off.
    const pipeline = await t.query(api.financeOrchestrator.getPipeline, { accountId });
    expect(pipeline.rows.find(r => r.subjectSourceId?.endsWith("plant-bayview-first"))?.state).toBe("ready_for_approval");
    // Earlier runs are untouched.
    expect(await t.query(api.financeScorecard.getScorecard, { accountId: "demo:account:pool-001" })).toBeNull();
  });

  it("runs a batch of synthetic deposits and reports time, % handled without a person and % flagged", async () => {
    const t = convexTest(schema, modules);
    const { accountId, count } = await t.mutation(api.financeScorecard.runBatch, { count: 40 });
    // A bulk import starts its investigations 400 ms apart.
    for (let i = 0; i < 40; i++) { vi.advanceTimersByTime(500); await t.finishInProgressScheduledFunctions(); }
    await drain(t);
    const card = await t.query(api.financeScorecard.getScorecard, { accountId });
    if (card?.kind !== "batch") throw new Error("expected a batch scorecard");
    expect(card.summary).toMatchObject({ count, settled: count, matchedRightAnswer: count });
    expect(card.summary.pctHandled + card.summary.pctFlagged).toBeLessThanOrEqual(100);
    expect(card.summary.handledWithoutPerson).toBeGreaterThan(0);
    expect(card.summary.flagged).toBeGreaterThan(0);
    // Fake time: the 400 ms stagger dominates, so 40 deposits take about 16 s here.
    expect(card.summary.durationMs).toBeGreaterThanOrEqual(39 * 400);
    expect(card.summary.line).toMatch(/^40 deposits in [\d.]+ s · [\d.]+% handled without a person · [\d.]+% flagged · 40 of 40 matched the right answer$/);
    expect(Object.values(card.byState).reduce((a, b) => a + b, 0)).toBe(count);
  });

  it("refuses to run in CREAO mode", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "creao");
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.financeScorecard.runPlanted, {})).rejects.toThrow("only in mock mode");
    await expect(t.mutation(api.financeScorecard.runBatch, {})).rejects.toThrow("only in mock mode");
  });
});

describe("learning you can trust: a rule is backtested before approval", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  const accountId = "demo:account:pool-001";

  /** Law-firm feed to the proposed insurance policy (step 8), with Delgado's check decided by a person. */
  async function toPolicy(t: T) {
    await t.mutation(api.financeIntake.startFreshDemoRun, {});
    for (let step = 1; step <= 3; step++) { await t.mutation(api.financeIntake.feedNext, { accountId }); await drain(t); }
    const allocation = (await t.query(api.financeIntake.getAccountOverview, { accountId })).proposals.find(p => p.kind === "allocation")!;
    await t.mutation(api.financeProposals.approveProposal, { proposalId: allocation.proposalId, dev: sam });
    await t.mutation(api.financeProposals.postProposal, { proposalId: allocation.proposalId, dev: sam });
    for (let step = 4; step <= 8; step++) { await t.mutation(api.financeIntake.feedNext, { accountId }); await drain(t); }
    return (await t.query(api.financeDesk.getDeskData, { accountId })).policies[0];
  }

  it("shows the backtest on the desk and approves without a reason when every past decision agrees", async () => {
    const t = convexTest(schema, modules);
    const policy = await toPolicy(t);
    expect(policy.backtest).toMatchObject({ testable: true, handled: 1, agree: 1, disagree: 0, reasonRequired: false, summary: "Would have handled 1 past deposit: 1 agree with what people decided, 0 disagree." });
    const approved = await t.mutation(api.financeProposals.approvePolicy, { runId: policy.runId, candidatePolicyId: policy.policyId, dev: sam });
    expect(approved).toMatchObject({ policyId: "P-1", backtest: { agree: 1 } });
    expect(await t.run(async ctx => (await ctx.db.query("financePolicyBacktests").collect()).map(b => [b.policyId, b.reason, b.approvedBy]))).toEqual([["P-1", null, "dev-unverified:sam"]]);
  });

  it("a rule that disagrees with any past decision can't be approved without a written reason", async () => {
    const t = convexTest(schema, modules);
    const policy = await toPolicy(t);
    // A past Harborline claim check that a person allocated to a different client than the rule would.
    await t.run(async ctx => {
      const now = Date.now();
      const bank = "demo:bank:txn:past-claim";
      await ctx.db.insert("financeBankTransactions", { sourceId: bank, accountId, subAccount: "IOLTA", direction: "inflow", amountCents: 1_800_000, currency: "USD", bookedAt: now - 5000, clearing: "cleared", reference: "Claim HL-50210", counterparty: "Harborline Insurance", ownerHintSourceId: null, documentSourceIds: ["demo:document:westbrook-settlement:v1"], duplicateOfSourceId: null, raw: { system: "demo", recordType: "bank-transaction", rawId: "past-claim", datasetVersion: "law-firm-demo-v1" } });
      for (const [entryId, ownerId, amountCents, kind] of [["past:received", null, 1_800_000, "deposit_received"], ["past:out", null, -1_800_000, "allocation"], ["past:in", "demo:owner:chen-park", 1_800_000, "allocation"]] as const) {
        await ctx.db.insert("financeLedgerEntries", { entryId, accountId, ownerId, amountCents, currency: "USD", kind, status: "posted", sourceRefs: [bank], fundsSourceId: bank, memo: "Past decision (test)", effectiveAt: now - 5000, createdAt: now - 5000, createdBy: "dev-unverified:sam" });
      }
    });
    const desk = await t.query(api.financeDesk.getDeskData, { accountId });
    expect(desk.policies[0].backtest).toMatchObject({ handled: 2, agree: 1, disagree: 1, reasonRequired: true });
    await expect(t.mutation(api.financeProposals.approvePolicy, { runId: policy.runId, candidatePolicyId: policy.policyId, dev: sam })).rejects.toThrow("Would have handled 2 past deposits: 1 agree with what people decided, 1 disagree. Write the reason");
    expect(await t.run(async ctx => (await ctx.db.query("financeApprovedPolicies").collect()).length)).toBe(0);
    await t.mutation(api.financeProposals.approvePolicy, { runId: policy.runId, candidatePolicyId: policy.policyId, reason: "The Chen & Park check was a misfiled payment we corrected by hand.", dev: sam });
    const [saved] = await t.run(async ctx => await ctx.db.query("financePolicyBacktests").collect());
    expect(saved).toMatchObject({ disagree: 1, reason: "The Chen & Park check was a misfiled payment we corrected by hand." });
    const event = (await t.query(api.finance.listMoneyEvents, { accountId })).find(e => e.type === "finance.money.policy_approved");
    expect(event?.payload.message).toContain("1 disagree. Reason given: The Chen & Park check");
  });
});
