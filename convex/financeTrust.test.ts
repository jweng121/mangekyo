/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAccountBundle } from "@mangekyo/contracts";
import { lawFirmBundle } from "@mangekyo/finance-core/fixtures/law-firm";
import { PARTIAL_RETAINER_POLICY } from "@mangekyo/finance-core/policy";
import { api } from "./_generated/api";
import { importBundle } from "./financeIntake";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const accountId = "demo:account:pool-001";
const sam = { role: "approver" as const, name: "sam" };
const riley = { role: "requester" as const, name: "riley" };
type T = ReturnType<typeof convexTest>;
async function drain(t: T) { for (let i = 0; i < 8; i++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); } }
const view = (t: T) => t.query(api.financeIntake.getAccountOverview, { accountId });
const runs = (t: T, name: string) => t.query(api.financeInvestigations.getTaskInvestigation, { taskId: `intake:${accountId}:deposit:demo:bank:txn:${name}` });
async function feed(t: T, steps: number) { await t.mutation(api.financeIntake.startFreshDemoRun, {}); for (let i = 0; i < steps; i++) { await t.mutation(api.financeIntake.feedNext, { accountId }); await drain(t); } }
async function post(t: T, proposalId: string) {
  expect((await t.mutation(api.financeProposals.approveProposal, { proposalId, dev: sam })).proposal.status).toBe("approved");
  expect((await t.mutation(api.financeProposals.postProposal, { proposalId, dev: sam })).proposal.status).toBe("posted");
}

/** A new client with an engagement letter and a deposit smaller than the retainer: the same pattern as Okafor. */
function retainerDeposit(key: string, name: string, payer: string, retainerCents: number, amountCents: number): NormalizedAccountBundle {
  const base = lawFirmBundle();
  const ownerSource = `demo:owner-record:${key}`;
  const doc = `demo:document:${key}-engagement:v1`;
  return { ...base, owners: [{ sourceId: ownerSource, ownerId: `demo:owner:${key}`, accountId, subAccount: "IOLTA", name, raw: { system: "demo", recordType: "owner", rawId: key, datasetVersion: "law-firm-demo-v1" } }],
    documents: [{ sourceId: doc, accountId, documentType: "Engagement letter", title: `${name} engagement letter`, text: `New client ${name}. Estate matter. Retainer: $${(retainerCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}.`, excerpt: `${name} retainer`, version: "v1", namedOwnerSourceIds: [ownerSource], raw: { system: "demo", recordType: "document", rawId: `${key}-engagement`, datasetVersion: "law-firm-demo-v1" } }],
    bankTransactions: [{ sourceId: `demo:bank:txn:${key}-retainer`, accountId, subAccount: "IOLTA", direction: "inflow", amountCents, currency: "USD", bookedAt: Date.now(), clearing: "cleared", reference: "Estate retainer", counterparty: payer, ownerHintSourceId: null, documentSourceIds: [doc], duplicateOfSourceId: null, raw: { system: "demo", recordType: "bank-transaction", rawId: `${key}-retainer`, datasetVersion: "law-firm-demo-v1" } }],
    obligations: [], statementBalances: [], openingBalances: [], reconcilingItems: [] };
}

describe("trust rules in the lock (Convex)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("L10: disputed funds are held at approval, and released once a different person records the resolution", async () => {
    const t = convexTest(schema, modules);
    await feed(t, 0);
    const payment = await t.mutation(api.financeProposals.requestPayment, { accountId, ownerId: "demo:owner:westbrook", amountCents: 5_000_000, purpose: "Westbrook HOA repairs", evidenceSourceIds: ["demo:document:westbrook-settlement:v1"], dev: riley });
    expect(payment.proposal.status).toBe("pending_approval");
    const dispute = await t.mutation(api.financeTrust.recordDispute, { accountId, ownerId: "demo:owner:westbrook", amountCents: 20_000_000, reason: "A board member disputes the repair invoice.", dev: riley });
    expect(dispute).toMatchObject({ disputeId: `${accountId}:dispute:001`, status: "open", recordedBy: "dev-unverified:riley" });
    const held = await t.mutation(api.financeProposals.approveProposal, { proposalId: payment.proposal.proposalId, dev: sam });
    expect(held.proposal.status).toBe("on_hold");
    expect(held.lock?.failures.map(f => f.rule)).toEqual(["L10"]);
    expect(held.proposal.hold?.message).toContain("disputed");
    expect(held.proposal.hold?.message).toContain("until a person records how the dispute was resolved");
    await expect(t.mutation(api.financeTrust.resolveDispute, { disputeId: dispute.disputeId, resolution: "Board approved the invoice.", dev: { ...sam, name: "riley" } })).rejects.toThrow("different person");
    await expect(t.mutation(api.financeTrust.resolveDispute, { disputeId: dispute.disputeId, resolution: "Board approved the invoice.", dev: riley })).rejects.toThrow("approver");
    const resolved = await t.mutation(api.financeTrust.resolveDispute, { disputeId: dispute.disputeId, resolution: "Board approved the invoice.", dev: sam });
    expect(resolved).toMatchObject({ status: "resolved", resolvedBy: "dev-unverified:sam" });
    // The automatic re-check marked the hold ready; a person still has to continue it. Nothing moved on its own.
    const afterResolve = (await view(t)).proposals.find(p => p.proposalId === payment.proposal.proposalId)!;
    expect(afterResolve).toMatchObject({ status: "on_hold", hold: { ready: true } });
    const resumed = await t.mutation(api.financeProposals.continueHeld, { proposalId: payment.proposal.proposalId, dev: sam });
    expect(resumed.proposal.status).toBe("approved");
    expect(resumed.lock?.failures).toEqual([]);
    expect(await t.query(api.financeTrust.listDisputes, { accountId })).toHaveLength(1);
    const events = await t.query(api.finance.listMoneyEvents, { accountId });
    expect(events.filter(e => e.type === "finance.money.hold_updated").map(e => e.payload.message)).toEqual(expect.arrayContaining([expect.stringContaining("recorded a $200,000.00 dispute"), expect.stringContaining("resolved dispute")]));
  });

  it("the disbursement agent asks a person when the signed statement doesn't add up, and proposes no line", async () => {
    const t = convexTest(schema, modules);
    await feed(t, 1);
    await t.run(async ctx => {
      const row = (await ctx.db.query("financeSourceDocuments").withIndex("by_sourceId", q => q.eq("sourceId", "demo:document:delgado-settlement-statement:v1")).unique())!;
      await ctx.db.patch("financeSourceDocuments", row._id, { lines: row.lines!.map(l => l.kind === "costs" ? { ...l, amountCents: 100_000 } : l) });
    });
    const started = await t.mutation(api.financeTrust.startDisbursement, { accountId, bankSourceId: "demo:bank:txn:harborline-delgado", dev: sam });
    await drain(t);
    const run = (await t.query(api.financeTrust.getDisbursement, { runId: started.runId }))!;
    expect(run.state).toBe("needs_person");
    expect(run.run.output).toMatchObject({ outcome: "needs_information", lines: [] });
    expect(run.run.output?.questions[0].question).toContain("lines total $85,050.00 but the deposit is $85,000.00");
    expect((await view(t)).proposals.filter(p => p.kind === "payment")).toEqual([]);
    expect((await t.query(api.financeAgentApi.getRunSteps, { runId: started.runId })).map(s => s.kind)).toEqual(["input_frozen", "output_validated", "claims_checked"]);
  });
});

describe("memory and improvement", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("a person's answer is reused on the next similar case, becomes a backtested policy, and is shown as used", async () => {
    const t = convexTest(schema, modules);
    await feed(t, 4);
    const q = (await runs(t, "okafor-retainer")).questions[0];
    await t.mutation(api.financeInvestigations.answerQuestion, { runId: q.runId, questionId: q.questionId, answer: "Yes, a partial retainer payment." }); await drain(t);
    const okafor = (await runs(t, "okafor-retainer")).runs[0];
    expect(okafor.providerInput?.humanClarifications.every(c => c.accountId === accountId)).toBe(true);
    expect(okafor.result?.candidatePolicies.map(p => p.statement)).toEqual([PARTIAL_RETAINER_POLICY]);
    await post(t, (await view(t)).proposals.find(p => p.bankSourceId === "demo:bank:txn:okafor-retainer")!.proposalId);
    // A second client pays part of her retainer. The agent sees Okafor's confirmation as memory and proposes without asking again.
    await t.run(async ctx => { await importBundle(ctx, retainerDeposit("priya-raman", "Priya Raman", "P RAMAN", 500_000, 250_000), "demo"); });
    await drain(t);
    const raman = (await runs(t, "priya-raman-retainer")).runs[0];
    expect(raman.status).toBe("review_required");
    expect(raman.result?.summary).toContain("From memory of an earlier answer");
    expect(raman.result?.findings[0].sourceRefs).toContain(`clarification:${q.questionId}:clarification`);
    expect(raman.claimCheck?.status).toBe("passed");
    expect(raman.providerInput?.humanClarifications.some(c => c.taskId !== raman.taskId)).toBe(true);
    const ramanProposal = (await view(t)).proposals.find(p => p.bankSourceId === "demo:bank:txn:priya-raman-retainer")!;
    expect(ramanProposal).toMatchObject({ status: "pending_approval", shares: [{ ownerId: "demo:owner:priya-raman", amountCents: 250_000 }] });
    // The repeatable pattern is a candidate policy, backtested against Okafor's posted decision, and approved by a person.
    const desk = await t.query(api.financeDesk.getDeskData, { accountId });
    const candidate = desk.policies.find(p => p.statement === PARTIAL_RETAINER_POLICY)!;
    expect(candidate.backtest).toMatchObject({ testable: true, handled: 1, agree: 1, disagree: 0, reasonRequired: false });
    const approved = await t.mutation(api.financeProposals.approvePolicy, { runId: candidate.runId, candidatePolicyId: candidate.policyId, dev: sam });
    expect(approved.policyId).toBe("P-1");
    const policies = await t.query(api.financeAgentApi.listPolicies, { accountId });
    expect(policies).toEqual([expect.objectContaining({ policyId: "P-1", usedLabel: "Used policy P-1, approved by dev-unverified:sam", backtest: expect.objectContaining({ agree: 1 }) })]);
    // The third similar deposit uses the policy and says so.
    await t.run(async ctx => { await importBundle(ctx, retainerDeposit("kemi-adeyemi", "Kemi Adeyemi", "K ADEYEMI", 400_000, 100_000), "demo"); });
    await drain(t);
    const kemi = (await runs(t, "kemi-adeyemi-retainer")).runs[0];
    expect(kemi.result?.summary).toMatch(/^Used policy P-1, approved by dev-unverified:sam\./);
    expect(kemi.result?.proposedAllocations[0].evidenceSourceIds).toContain(`policy:${accountId}:P-1@v1`);
    expect(kemi.result?.candidatePolicies).toEqual([]);
  });

  it("submitCorrection creates a linked attempt at a step, leaves the old run unchanged, and corrections and rejections replay as eval cases", async () => {
    const t = convexTest(schema, modules);
    await feed(t, 5);
    const nq = (await runs(t, "nguyen-zelle")).questions[0];
    const answered = await t.mutation(api.financeInvestigations.answerQuestion, { runId: nq.runId, questionId: nq.questionId, answer: "James" }); await drain(t);
    const rejected = (await runs(t, "nguyen-zelle")).runs.find(r => r.runId === answered.runId)!;
    expect(rejected.status).toBe("checker_rejected");
    const steps = await t.query(api.financeAgentApi.getRunSteps, { runId: rejected.runId });
    expect(steps.map(s => s.kind)).toEqual(["input_frozen", "output_validated", "claims_checked"]);
    const claims = (await t.query(api.financeAgentApi.getClaims, { runId: rejected.runId }))!;
    expect(claims).toMatchObject({ agent: "intake", status: "rejected", checkerMode: "mock" });
    await expect(t.mutation(api.financeAgentApi.submitCorrection, { runId: rejected.runId, stepIndex: 9, kind: "cite_clarification", payload: {}, reason: "", actor: sam })).rejects.toThrow("has no step 9");
    const correction = await t.mutation(api.financeAgentApi.submitCorrection, { runId: rejected.runId, stepIndex: 2, kind: "cite_clarification", payload: {}, reason: "The person's answer is the source.", actor: sam });
    await drain(t);
    expect((await runs(t, "nguyen-zelle")).runs.find(r => r.runId === rejected.runId)).toEqual(rejected);
    const corrected = (await runs(t, "nguyen-zelle")).runs.find(r => r.runId === correction.newRunId)!;
    expect(corrected).toMatchObject({ parentRunId: rejected.runId, status: "review_required", claimCheck: { status: "passed" } });
    expect(await t.query(api.financeAgentApi.listCorrections, { runId: rejected.runId })).toEqual([expect.objectContaining({ correctionId: correction.correctionId, kind: "cite_clarification", stepIndex: 2, newRunId: correction.newRunId, actor: "dev-unverified:sam", reason: "The person's answer is the source." })]);
    await expect(t.mutation(api.financeAgentApi.submitCorrection, { runId: rejected.runId, stepIndex: 2, kind: "checker_wrong", payload: { note: "no" }, reason: "x", actor: sam })).rejects.toThrow("A newer attempt exists");
    // correct_input_field: the new attempt's frozen input carries the corrected value and a note saying who changed it and why.
    const fieldFix = await t.mutation(api.financeAgentApi.submitCorrection, { runId: corrected.runId, stepIndex: 0, kind: "correct_input_field", payload: { path: "records.bankTransactions[0].counterparty", value: "JAMES NGUYEN" }, reason: "The bank truncated the payer name.", actor: sam });
    await drain(t);
    const fixed = (await runs(t, "nguyen-zelle")).runs.find(r => r.runId === fieldFix.newRunId)!;
    expect(fixed.providerInput?.records.bankTransactions?.[0].counterparty).toBe("JAMES NGUYEN");
    expect(fixed.providerInput?.records.missingEvidence.at(-1)).toContain("corrected records.bankTransactions[0].counterparty to \"JAMES NGUYEN\"");
    expect((await runs(t, "nguyen-zelle")).runs.find(r => r.runId === corrected.runId)?.providerInput?.records.bankTransactions?.[0].counterparty).toBe("J NGUYEN");
    await expect(t.mutation(api.financeAgentApi.submitCorrection, { runId: fixed.runId, stepIndex: 0, kind: "correct_input_field", payload: { path: "records.owners[0].name", value: "x" }, reason: "r", actor: sam })).rejects.toThrow("correct_input_field accepts");
    // Eval: the checker rejection and the corrections are cases; the mock replays them.
    const cases = await t.query(api.financeAgentApi.listEvalCases, { agent: "investigator" });
    expect(cases.map(c => c.kind).sort()).toEqual(["checker_rejection", "correction", "correction"]);
    // Replaying with the same instructions: the two corrections hold, and the rejection case fails because the unchanged agent repeats the claim.
    const report = await t.mutation(api.financeAgentApi.evaluateInstructions, { agent: "intake" });
    expect(report).toMatchObject({ agent: "intake", instructionVersion: "finance-investigator/v1", mode: "mock", total: 3, failed: 1 });
    expect(report.passed + report.changed).toBe(2);
    expect(report.results.find(r => r.verdict === "failed")?.detail).toContain("repeated the claim the checker rejected");
    expect((await t.query(api.financeAgentApi.listEvalRuns, { agent: "intake" }))[0].evalRunId).toBe(report.evalRunId);
    await expect(t.mutation(api.financeAgentApi.evaluateInstructions, { agent: "auditor" })).rejects.toThrow("none to replay");
  });
});

describe("snapshots for the visual audit", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("records one immutable snapshot per step with actor, model, mode, frozen input, output, verdicts and lock results, and emits finance.snapshot.captured", async () => {
    const t = convexTest(schema, modules);
    await feed(t, 3);
    const run = (await runs(t, "harborline-delgado")).runs[0];
    const steps = await t.query(api.financeAgentApi.getRunSteps, { runId: run.runId });
    expect(steps.map(s => [s.stepIndex, s.kind, s.actor.type, s.model, s.mode])).toEqual([[0, "input_frozen", "system", "mock", "mock"], [1, "output_validated", "agent", "mock", "mock"], [2, "claims_checked", "agent", "mock", "mock"], [3, "lock_evaluated", "code", "mock", "mock"]]);
    const frozen = (await t.query(api.financeAgentApi.getSnapshot, { snapshotId: steps[0].snapshotId }))!;
    expect(frozen.input).toEqual(run.providerInput);
    expect(frozen.finishedAt).toBeGreaterThanOrEqual(frozen.startedAt);
    const checked = (await t.query(api.financeAgentApi.getSnapshot, { snapshotId: steps[2].snapshotId }))!;
    expect(checked.checkerVerdicts).toEqual(run.claimCheck?.claims);
    expect(checked.actor.identity).toBe("agent:evidence-checker:mock");
    const locked = (await t.query(api.financeAgentApi.getSnapshot, { snapshotId: steps[3].snapshotId }))!;
    expect(locked.lockResults?.[0]).toMatchObject({ allowed: true, stage: "request" });
    const events = await t.query(api.finance.listTaskEvents, { taskId: run.taskId });
    expect(events.filter(e => e.type === "finance.snapshot.captured" && e.runId === run.runId).map(e => "payload" in e && "stepIndex" in e.payload ? [e.payload.stepIndex, e.payload.snapshotId] : null)).toEqual(steps.map(s => [s.stepIndex, s.snapshotId]));
    expect(await t.query(api.financeAgentApi.getSnapshot, { snapshotId: "nope" })).toBeNull();
    // The disbursement attempt from step 2 has its own steps, including the lock's decision on each line.
    const [disbursement] = await t.query(api.financeTrust.listDisbursements, { accountId });
    const dSteps = await t.query(api.financeAgentApi.getRunSteps, { runId: disbursement.runId });
    expect(dSteps.map(s => s.kind)).toEqual(["input_frozen", "output_validated", "claims_checked", "lock_evaluated"]);
    expect((await t.query(api.financeAgentApi.getSnapshot, { snapshotId: dSteps[3].snapshotId }))!.lockResults?.map(l => l.failures.map(f => f.rule))).toEqual([expect.arrayContaining(["L2"]), expect.arrayContaining(["L2"]), expect.arrayContaining(["L2"])]);
    expect((await t.query(api.finance.listMoneyEvents, { accountId })).some(e => e.type === "finance.money.snapshot_captured" && e.payload.sourceIds.includes(disbursement.runId))).toBe(true);
  });
});

describe("Trust Compliance Auditor", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 2, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("the drill plants four mistakes in posted history and the auditor catches all four with no false alarms, changing nothing", async () => {
    const t = convexTest(schema, modules);
    const drill = await t.mutation(api.financeAudit.runAuditorDrill, {});
    expect(drill.accountId).toBe("demo:account:pool-001");
    const card = (await t.query(api.financeAudit.getAuditorScorecard, { accountId: drill.accountId }))!;
    expect(card.line).toBe("Caught 4 of 4 · missed 0 · false alarms 0");
    expect(card.planted.map(p => [p.key, p.status])).toEqual([["self-approved", "caught"], ["payout-before-cleared", "caught"], ["fee-no-invoice", "caught"], ["unlinked-reversal", "caught"]]);
    const report = (await t.query(api.financeAudit.getAuditReport, { accountId: drill.accountId }))!;
    expect(report).toMatchObject({ reportId: drill.reportId, status: "findings", mode: "mock", model: "mock", agent: "auditor", generatedBy: "dev-unverified:sam" });
    expect(report.findings.filter(f => f.severity === "violation")).toHaveLength(4);
    expect(report.findings.find(f => f.ruleId === "A4_FEE_NOT_EARNED")?.message).toContain("$3,000.00 fee left Chen & Park Holdings's trust balance");
    const entries = await t.run(async ctx => (await ctx.db.query("financeLedgerEntries").collect()).length);
    await t.mutation(api.financeAudit.runAudit, { accountId: drill.accountId, from: 0, to: Date.now(), dev: sam });
    expect(await t.run(async ctx => (await ctx.db.query("financeLedgerEntries").collect()).length)).toBe(entries);
    expect(await t.query(api.financeAudit.listAuditReports, { accountId: drill.accountId })).toHaveLength(2);
    expect((await t.query(api.financeOrchestrator.getPipeline, { accountId: drill.accountId })).rows.filter(r => r.kind === "audit").every(r => r.state === "needs_person")).toBe(true);
    const steps = await t.query(api.financeAgentApi.getRunSteps, { runId: `audit:${drill.accountId}:0-${Date.now()}:audit:1` });
    expect(steps.map(s => s.kind)).toEqual(["input_frozen", "output_validated"]);
  });

  it("a clean account audits clean, and a month is signed off once by an approver after it ends", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.startFreshDemoRun, {});
    const audit = await t.mutation(api.financeAudit.runAudit, { accountId, from: Date.UTC(2026, 9, 1), to: Date.now(), dev: sam });
    const report = (await t.query(api.financeAudit.getAuditReport, { accountId, reportId: audit.reportId! }))!;
    expect(report.status).toBe("clean");
    expect(report.reviewed.owners).toBe(7);
    const unsigned = await t.query(api.financeAudit.monthlyReconciliationReport, { accountId, month: "2026-10" });
    expect(unsigned).toMatchObject({ signedOff: null, bookCents: 60_770_000, threeWay: { status: "matched" } });
    expect(unsigned.bank.adjustedCents).toBe(60_770_000);
    await expect(t.mutation(api.financeAudit.signOffMonthlyReconciliation, { accountId, month: "2026-10", dev: riley })).rejects.toThrow("approver");
    await expect(t.mutation(api.financeAudit.signOffMonthlyReconciliation, { accountId, month: "2026-11", dev: sam })).rejects.toThrow("only after it ends");
    const signed = await t.mutation(api.financeAudit.signOffMonthlyReconciliation, { accountId, month: "2026-10", note: "Reviewed against the bank statement.", dev: sam });
    expect(signed.signedOff).toMatchObject({ by: "dev-unverified:sam", note: "Reviewed against the bank statement." });
    await expect(t.mutation(api.financeAudit.signOffMonthlyReconciliation, { accountId, month: "2026-10", dev: sam })).rejects.toThrow("already signed off");
    expect((await t.query(api.financeAudit.monthlyReconciliationReport, { accountId, month: "2026-10" })).signedOff?.by).toBe("dev-unverified:sam");
    expect(await t.query(api.financeAudit.listMonthlyReconciliations, { accountId })).toHaveLength(1);
    // The next audit sees the signed month: no A7 warning for October.
    const again = await t.mutation(api.financeAudit.runAudit, { accountId, from: Date.UTC(2026, 9, 1), to: Date.now(), dev: sam });
    expect((await t.query(api.financeAudit.getAuditReport, { accountId, reportId: again.reportId! }))!.findings.filter(f => f.ruleId === "A7_MONTHLY_RECONCILIATION")).toEqual([]);
  });

  it("every agent reports its mode and model, keys stay out", async () => {
    const t = convexTest(schema, modules);
    const config = await t.query(api.financeOrchestrator.getConfiguration, { now: Date.now() });
    expect(config.agents.map(a => [a.agent, a.mode, a.model, a.plannedModel])).toEqual([["intake", "mock", "mock", "Claude Opus"], ["disbursement", "mock", "mock", "Claude Opus"], ["evidence_checker", "mock", "mock", "Gemini Pro"], ["reconciler", "mock", "mock", "Claude Opus"], ["auditor", "mock", "mock", "GPT"]]);
    expect(JSON.stringify(config)).not.toContain("capi_");
  });
});
