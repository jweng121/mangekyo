/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const accountId = "demo:account:pool-001";
const sam = { role: "approver" as const, name: "sam" };
const riley = { role: "requester" as const, name: "riley" };
type T = ReturnType<typeof convexTest>;
async function drain(t: T) { for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); } }
const view = (t: T) => t.query(api.financeIntake.getAccountOverview, { accountId });
const RETURNED = "demo:bank:txn:okafor-retainer:returned";
const KEY = `BANK_TXN_WITHOUT_LEDGER_ENTRY:${RETURNED}`;

/** Law-firm feed to Okafor's posted $2,500 allocation, then the bank returns the check (riley records it). */
async function bounced(t: T) {
  await t.mutation(api.financeIntake.startFreshDemoRun, {});
  for (let step = 1; step <= 4; step++) { await t.mutation(api.financeIntake.feedNext, { accountId }); await drain(t); }
  const allocation = (await view(t)).proposals.find(p => p.kind === "allocation" && p.bankSourceId === "demo:bank:txn:harborline-delgado")!;
  await t.mutation(api.financeProposals.approveProposal, { proposalId: allocation.proposalId, dev: sam });
  await t.mutation(api.financeProposals.postProposal, { proposalId: allocation.proposalId, dev: sam });
  const q = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId: `intake:${accountId}:deposit:demo:bank:txn:okafor-retainer` })).questions[0];
  await t.mutation(api.financeInvestigations.answerQuestion, { runId: q.runId, questionId: q.questionId, answer: "Yes, a partial retainer payment." }); await drain(t);
  const okafor = (await view(t)).proposals.find(p => p.bankSourceId === "demo:bank:txn:okafor-retainer")!;
  await t.mutation(api.financeProposals.approveProposal, { proposalId: okafor.proposalId, dev: sam });
  await t.mutation(api.financeProposals.postProposal, { proposalId: okafor.proposalId, dev: sam });
  await drain(t);
  expect((await view(t)).threeWay.status).toBe("matched");
  expect(await t.query(api.financeReconciliation.listCorrections, { accountId })).toEqual([]);
  await t.mutation(api.financeIntake.simulateClientBounce, { accountId, dev: riley });
  await drain(t);
}

describe("mismatch agent", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("starts on a failed three-way check, explains the bounced check and proposes the correcting entry for a person", async () => {
    const t = convexTest(schema, modules);
    await bounced(t);
    const timeline = (await t.query(api.financeOrchestrator.getTimeline, { taskId: `recon:${accountId}:${KEY}` }))!;
    expect(timeline.orchestration).toMatchObject({ kind: "reconciliation", state: "needs_person", reason: { code: "CORRECTION_PROPOSED" } });
    expect(timeline.events.filter(e => e.kind === "transition").map(e => e.to)).toEqual(["received", "investigating", "validating", "checking", "needs_person"]);
    expect(timeline.events[0]).toMatchObject({ trigger: "mismatch_found", actor: { type: "code" } });
    const [correction] = await t.query(api.financeReconciliation.listCorrections, { accountId });
    expect(correction).toMatchObject({ status: "proposed", stillMismatched: true, causeKey: KEY, entry: { kind: "record_bank_item", bankSourceId: RETURNED, ownerId: "demo:owner:daniel-okafor", amountCents: -250_000 } });
    expect(correction.explanation).toContain("bank returned D OKAFOR's $2,500.00 check");
    const run = (await t.query(api.financeReconciliation.getRunView, { runId: correction.runId }))!;
    expect(run.run.input.cause).toMatchObject({ code: "BANK_TXN_WITHOUT_LEDGER_ENTRY", sourceIds: [RETURNED] });
    expect(run.run.findingChecks.every(f => f.supported)).toBe(true);
    expect(run.run.dryRun).toMatchObject({ allowed: true, resolves: true });
    // Nothing is posted by the agent.
    expect((await view(t)).threeWay.status).toBe("mismatched");
  });

  it("the correction goes through the lock: the person who recorded the return can't approve it, a different approver can, once", async () => {
    const t = convexTest(schema, modules);
    await bounced(t);
    const [correction] = await t.query(api.financeReconciliation.listCorrections, { accountId });
    await expect(t.mutation(api.financeReconciliation.approveCorrection, { correctionId: correction.correctionId, dev: riley })).rejects.toThrow("approver role");
    const refused = await t.mutation(api.financeReconciliation.approveCorrection, { correctionId: correction.correctionId, dev: { ...sam, name: "riley" } });
    expect(refused).toMatchObject({ allowed: false, entryIds: [], failures: [expect.objectContaining({ rule: "L4", code: "SELF_APPROVAL" })] });
    expect((await view(t)).threeWay.status).toBe("mismatched");
    const approved = await t.mutation(api.financeReconciliation.approveCorrection, { correctionId: correction.correctionId, dev: sam });
    expect(approved).toMatchObject({ allowed: true, entryIds: [`correction:${correction.correctionId}`] });
    const after = await view(t);
    expect(after.threeWay.status).toBe("matched");
    expect(after.balances.find(b => b.ownerId === "demo:owner:daniel-okafor")?.postedCents).toBe(0);
    expect((await t.mutation(api.financeReconciliation.approveCorrection, { correctionId: correction.correctionId, dev: sam })).failures[0]).toMatchObject({ rule: "L7" });
    const [posted] = await t.query(api.financeReconciliation.listCorrections, { accountId });
    expect(posted).toMatchObject({ status: "posted", decidedBy: "dev-unverified:sam", stillMismatched: false });
    const events = await t.query(api.finance.listMoneyEvents, { accountId });
    expect(events.filter(e => e.runId === correction.correctionId).map(e => e.type)).toEqual(["finance.money.lock_checked", "finance.money.ledger_posted", "finance.money.lock_checked"]);
    // The old one-click fix refuses now: the bank item is already recorded.
    await expect(t.mutation(api.financeIntake.recordBankItem, { accountId, bankSourceId: RETURNED, dev: sam })).rejects.toThrow("already recorded");
    const timeline = (await t.query(api.financeOrchestrator.getTimeline, { taskId: `recon:${accountId}:${KEY}` }))!;
    expect(timeline.events.at(-1)).toMatchObject({ trigger: "person_approved_correction", actor: { type: "person", identity: "dev-unverified:sam" }, reason: { code: "CORRECTION_POSTED" } });
  });

  it("a rejection needs a reason and is recorded; one investigation per cause", async () => {
    const t = convexTest(schema, modules);
    await bounced(t);
    const [correction] = await t.query(api.financeReconciliation.listCorrections, { accountId });
    await expect(t.mutation(api.financeReconciliation.rejectCorrection, { correctionId: correction.correctionId, reason: " ", dev: sam })).rejects.toThrow("reason");
    await t.mutation(api.financeReconciliation.rejectCorrection, { correctionId: correction.correctionId, reason: "Okafor says a replacement check is coming.", dev: sam });
    expect((await t.query(api.financeReconciliation.listCorrections, { accountId }))[0]).toMatchObject({ status: "rejected", rejectionReason: "Okafor says a replacement check is coming." });
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, { accountId }); await drain(t);
    const recon = (await t.query(api.financeOrchestrator.getPipeline, { accountId })).rows.filter(r => r.kind === "reconciliation");
    expect(recon.map(r => r.subjectSourceId).sort()).toEqual([RETURNED, "demo:bank:txn:E-001"].sort());
  });

  it("does not start on its own while the intake agent is in a paid mode", async () => {
    const t = convexTest(schema, modules);
    await bounced(t);
    vi.stubEnv("FINANCE_AGENT_MODE", "creao");
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, { accountId }); await drain(t);
    expect((await t.query(api.financeOrchestrator.getPipeline, { accountId })).rows.filter(r => r.kind === "reconciliation")).toHaveLength(1);
  });

  it("asks one short question instead of recording an outflow the records don't explain", async () => {
    const t = convexTest(schema, modules);
    await bounced(t);
    // An outflow the bank attributes to Okafor, with no return marker and no document: the reconciler must not guess.
    const outflow = "demo:bank:txn:okafor-mystery";
    await t.run(async ctx => { await ctx.db.insert("financeBankTransactions", { sourceId: outflow, accountId, subAccount: "IOLTA", direction: "outflow", amountCents: 250_000, currency: "USD", bookedAt: Date.now(), clearing: "cleared", reference: "DEBIT 4471", counterparty: "BANK", ownerHintSourceId: "demo:owner-record:daniel-okafor", documentSourceIds: [], duplicateOfSourceId: null, raw: { system: "demo", recordType: "bank-transaction", rawId: "okafor-mystery", datasetVersion: "law-firm-demo-v1" } }); });
    await t.mutation(internal.financeReconciliation.autoStart, { accountId }); await drain(t);
    const run = await t.run(async ctx => (await ctx.db.query("financeReconciliationRuns").collect()).find(r => r.causeKey.endsWith(outflow)));
    expect(run?.status).toBe("needs_person");
    expect(run?.output).toMatchObject({ outcome: "needs_information", proposedEntry: null });
    expect(run?.output?.questions).toHaveLength(1);
    expect(run?.output?.questions[0].question).toBe("The bank is $2,500.00 short. Did Daniel Okafor's check bounce, or is this a bank fee?");
    expect((await t.query(api.financeReconciliation.listCorrections, { accountId })).filter(c => c.causeKey.endsWith(outflow))).toEqual([]);
  });
});
