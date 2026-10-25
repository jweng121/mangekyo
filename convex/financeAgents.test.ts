/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const DEMO = "demo:account:pool-001";
const requester = { role: "requester" as const, name: "riley" };
const approver = { role: "approver" as const, name: "sam" };
type T = ReturnType<typeof convexTest>;

async function drain(t: T) { for (let round = 0; round < 6; round++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); } }
const taskOf = (bank: string) => `intake:${DEMO}:deposit:${bank}`;
const runs = (t: T, bank: string) => t.query(api.financeInvestigations.getTaskInvestigation, { taskId: taskOf(bank) });
const overview = (t: T) => t.query(api.financeIntake.getAccountOverview, { accountId: DEMO });

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.financeIntake.loadDemoFixture, {});
  await drain(t);
  return t;
}
/** B-001 is the vague $980 deposit; answering with an owner's name makes the mock mis-cite the memo on the rerun. */
async function rejectedRun(t: T) {
  const view = await runs(t, "demo:bank:txn:B-001");
  const q = view.questions[0];
  const resumed = await t.mutation(api.financeInvestigations.answerQuestion, { runId: q.runId, questionId: q.questionId, answer: "J Smith pays rent for DEMO Owner Y — Yankee Trust." });
  await drain(t);
  return { firstRunId: q.runId, rejectedRunId: resumed.runId };
}

describe("Agent 2: the claim checker", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("stores a verdict per claim with the run, and passes supported proposals on to approval", async () => {
    const t = await setup();
    const a = (await runs(t, "demo:bank:txn:A-001")).runs[0];
    expect(a.status).toBe("review_required");
    expect(a.claimCheck).toMatchObject({ status: "passed", agentMode: "mock", claims: [expect.objectContaining({ verdict: "supported", checkedBy: "code" })] });
    const events = await t.query(api.finance.listTaskEvents, { taskId: taskOf("demo:bank:txn:A-001") });
    expect(events.map(e => e.type)).toContain("finance.checker.completed");
    const snapshots = await t.query(api.finance.listTaskSnapshots, { taskId: taskOf("demo:bank:txn:A-001") });
    expect(snapshots.some(s => "claimCheck" in s.output && s.output.claimCheck?.status === "passed")).toBe(true);
    expect((await overview(t)).proposals.filter(p => p.bankSourceId === "demo:bank:txn:A-001").map(p => p.status)).toEqual(["pending_approval"]);
  });

  it("stops a run with an unsupported claim: checker_rejected, nothing reaches approval, a person sees it", async () => {
    const t = await setup();
    const { rejectedRunId } = await rejectedRun(t);
    const view = await runs(t, "demo:bank:txn:B-001");
    const run = view.runs.find(r => r.runId === rejectedRunId)!;
    expect(run.status).toBe("checker_rejected");
    expect(run.result?.outcome).toBe("proposal_ready");
    const bad = run.claimCheck!.claims.find(c => c.verdict === "not_supported")!;
    expect(bad).toMatchObject({ missing: ["DEMO Owner Y — Yankee Trust"], sourceRefs: ["demo:document:note-b-001:v1"] });
    expect(bad.sourceSays).toContain("TRANSFER 4471");
    expect((await overview(t)).proposals.filter(p => p.bankSourceId === "demo:bank:txn:B-001")).toEqual([]);
    expect(view.questions.filter(q => q.runId === rejectedRunId)).toEqual([]);
    const desk = await t.query(api.financeDesk.getDeskData, { accountId: DEMO });
    expect(desk.checkerStopped).toEqual([expect.objectContaining({ runId: rejectedRunId, claim: expect.stringContaining("names DEMO Owner Y") })]);
    const events = await t.query(api.finance.listTaskEvents, { taskId: taskOf("demo:bank:txn:B-001") });
    expect(events.filter(e => e.runId === rejectedRunId).map(e => e.type)).toEqual(expect.arrayContaining(["finance.checker.rejected"]));
  });

  it("the agent part is mock by default (CHECKER_MODE unset) and only judges what code can't", async () => {
    const t = await setup();
    const b = (await runs(t, "demo:bank:txn:B-001")).runs[0];
    expect(b.claimCheck?.agentMode).toBe("mock");
    expect(b.claimCheck?.claims.some(c => c.checkedBy === "agent")).toBe(true);
  });
});

describe("correct and rerun", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("citing the person's answer creates a parent-linked attempt that passes; the stopped run never changes", async () => {
    const t = await setup();
    const { rejectedRunId } = await rejectedRun(t);
    const before = (await runs(t, "demo:bank:txn:B-001")).runs.find(r => r.runId === rejectedRunId);
    const next = await t.mutation(api.financeInvestigations.correctAndRerun, { runId: rejectedRunId, choice: "cite_clarification", note: "", dev: approver });
    await drain(t);
    const view = await runs(t, "demo:bank:txn:B-001");
    expect(view.runs.find(r => r.runId === rejectedRunId)).toEqual(before);
    const rerun = view.runs.find(r => r.runId === next.runId)!;
    expect(rerun).toMatchObject({ parentRunId: rejectedRunId, status: "review_required", claimCheck: { status: "passed" } });
    expect(rerun.providerInput?.humanClarifications.map(c => c.questionId)).toContain(`${rejectedRunId}:correction`);
    expect(view.clarifications.find(c => c.questionId === `${rejectedRunId}:correction`)?.respondent.identity).toBe("dev-unverified:sam");
    expect((await overview(t)).proposals.find(p => p.bankSourceId === "demo:bank:txn:B-001")).toMatchObject({ status: "pending_approval", shares: [{ ownerId: "demo:owner:yankee", amountCents: 98_000 }] });
    await expect(t.mutation(api.financeInvestigations.correctAndRerun, { runId: rejectedRunId, choice: "cite_clarification", note: "", dev: approver })).rejects.toThrow("A newer attempt exists");
    await expect(t.mutation(api.financeInvestigations.correctAndRerun, { runId: next.runId, choice: "cite_clarification", note: "", dev: approver })).rejects.toThrow("Only a run the checker stopped");
  });

  it("disputing the checker needs a reason, is recorded, and can't override a code-found contradiction", async () => {
    const t = await setup();
    const { rejectedRunId } = await rejectedRun(t);
    await expect(t.mutation(api.financeInvestigations.correctAndRerun, { runId: rejectedRunId, choice: "checker_wrong", note: " ", dev: approver })).rejects.toThrow("reason");
    const next = await t.mutation(api.financeInvestigations.correctAndRerun, { runId: rejectedRunId, choice: "checker_wrong", note: "The memo is shorthand for Yankee.", dev: approver });
    await drain(t);
    const view = await runs(t, "demo:bank:txn:B-001");
    expect(view.runs.find(r => r.runId === next.runId)?.status).toBe("checker_rejected");
    expect(view.clarifications.find(c => c.questionId === `${rejectedRunId}:correction`)?.answer).toBe("The memo is shorthand for Yankee.");
  });

  it("adding a document reruns with it as cited evidence", async () => {
    const t = await setup();
    const { rejectedRunId } = await rejectedRun(t);
    const next = await t.mutation(api.financeInvestigations.correctAndRerun, { runId: rejectedRunId, choice: "add_document", note: "Lease: J Smith pays $980 monthly rent to DEMO Owner Y — Yankee Trust.", dev: approver });
    await drain(t);
    expect((await runs(t, "demo:bank:txn:B-001")).runs.find(r => r.runId === next.runId)).toMatchObject({ status: "review_required", claimCheck: { status: "passed" } });
  });
});

describe("live feed, policies and approve-all", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  async function feedAll(t: T) {
    const labels: Array<string | null> = [];
    for (let i = 0; i < 8; i++) { const r = await t.mutation(api.financeIntake.feedNext, { accountId: DEMO }); labels.push(r.label); await drain(t); if (r.done && r.label === null) break; }
    return labels;
  }

  it("runs the same seven steps in the same order and then stops", async () => {
    const t = await setup();
    const labels = await feedAll(t);
    expect(labels.slice(0, 8)).toEqual(["A clear deposit with a remittance naming its owner", "A partial payment of an open invoice", "A deposit matching an open invoice exactly", "Two deposits sharing one reference", "An unclear deposit with only a vague memo", "A second exact invoice match, where an approved policy applies", "A payment request the lock blocks", null]);
    const ov = await overview(t);
    expect(ov.proposals.find(p => p.purpose === "Live feed: scripted payment request")).toMatchObject({ status: "blocked", blockedReasons: [expect.objectContaining({ code: "OWNER_INSUFFICIENT_FUNDS" })] });
    expect(ov.threeWay.status).toBe("matched");
    expect(ov.threeWay.causes).toContainEqual(expect.objectContaining({ code: "DUPLICATE_POSTING", severity: "warning" }));
    const status = async (id: string) => (await runs(t, `demo:bank:txn:${id}`)).runs[0]?.result?.outcome;
    expect([await status("F-001"), await status("F-002"), await status("F-003"), await status("F-005"), await status("F-006"), await status("F-007")]).toEqual(["proposal_ready", "needs_information", "proposal_ready", "needs_information", "needs_information", "proposal_ready"]);
    expect((await t.query(api.financeDesk.getDeskData, { accountId: DEMO })).feed).toMatchObject({ mode: "mock", stepsDone: 7, total: 7 });
  });

  it("refuses CREAO mode and non-DEMO accounts", async () => {
    const t = await setup();
    await expect(t.mutation(api.financeIntake.feedNext, { accountId: "erp:account:trust-pool" })).rejects.toThrow();
    vi.stubEnv("FINANCE_AGENT_MODE", "creao"); vi.stubEnv("CREAO_APP_ID", "x"); vi.stubEnv("CREAO_API_KEY", "capi_x");
    await expect(t.mutation(api.financeIntake.feedNext, { accountId: DEMO })).rejects.toThrow("only in mock mode");
  });

  it("approving a proposed policy records who, flows into the next investigation, and is shown as used", async () => {
    const t = await setup();
    for (let i = 0; i < 3; i++) { await t.mutation(api.financeIntake.feedNext, { accountId: DEMO }); await drain(t); }
    const desk = await t.query(api.financeDesk.getDeskData, { accountId: DEMO });
    const candidate = desk.policies.find(p => p.policyId === "invoice-exact-match")!;
    await expect(t.mutation(api.financeProposals.approvePolicy, { runId: candidate.runId, candidatePolicyId: candidate.policyId, dev: requester })).rejects.toThrow("approver");
    expect(await t.mutation(api.financeProposals.approvePolicy, { runId: candidate.runId, candidatePolicyId: candidate.policyId, dev: approver })).toMatchObject({ policyId: "P-1", backtest: { testable: true, disagree: 0 } });
    await expect(t.mutation(api.financeProposals.approvePolicy, { runId: candidate.runId, candidatePolicyId: candidate.policyId, dev: approver })).rejects.toThrow("already approved");
    const after = await t.query(api.financeDesk.getDeskData, { accountId: DEMO });
    expect(after.approvedPolicies).toEqual([expect.objectContaining({ policyId: "P-1", approvedBy: "dev-unverified:sam" })]);
    expect(after.policies.some(p => p.policyId === "invoice-exact-match")).toBe(false);
    expect((await t.query(api.finance.listMoneyEvents, { accountId: DEMO })).some(e => e.type === "finance.money.policy_approved")).toBe(true);
    for (let i = 0; i < 3; i++) { await t.mutation(api.financeIntake.feedNext, { accountId: DEMO }); await drain(t); }
    const f7 = (await runs(t, "demo:bank:txn:F-007")).runs[0];
    expect(f7.providerInput?.approvedPolicies.map(p => p.policyId)).toEqual(["P-1"]);
    expect(f7.result?.summary).toContain("Used policy P-1");
    expect((await overview(t)).proposals.find(p => p.bankSourceId === "demo:bank:txn:F-007")?.evidenceSourceIds).toContain(`policy:${DEMO}:P-1@v1`);
  });

  it("approve-all approves only proposals proven by the lock, the checker and an approved policy", async () => {
    const t = await setup();
    for (let i = 0; i < 3; i++) { await t.mutation(api.financeIntake.feedNext, { accountId: DEMO }); await drain(t); }
    const candidate = (await t.query(api.financeDesk.getDeskData, { accountId: DEMO })).policies.find(p => p.policyId === "invoice-exact-match")!;
    await t.mutation(api.financeProposals.approvePolicy, { runId: candidate.runId, candidatePolicyId: candidate.policyId, dev: approver });
    for (let i = 0; i < 3; i++) { await t.mutation(api.financeIntake.feedNext, { accountId: DEMO }); await drain(t); }
    await t.mutation(api.financeProposals.proposeAllocation, { accountId: DEMO, bankSourceId: "demo:bank:txn:F-004", shares: [{ ownerId: "demo:owner:delta", amountCents: 30_000 }], evidenceSourceIds: ["demo:bank:txn:F-004"], purpose: "by hand", dev: requester });
    await expect(t.mutation(api.financeProposals.approveAllProven, { accountId: DEMO, dev: requester })).rejects.toThrow("approver");
    const result = await t.mutation(api.financeProposals.approveAllProven, { accountId: DEMO, dev: approver });
    const ov = await overview(t);
    const idFor = (bank: string) => ov.proposals.find(p => p.bankSourceId === bank)!.proposalId;
    expect(result.approved).toEqual([idFor("demo:bank:txn:F-007")]);
    expect(result.skipped.map(s => s.proposalId)).toEqual(expect.arrayContaining([idFor("demo:bank:txn:A-001"), idFor("demo:bank:txn:F-001"), idFor("demo:bank:txn:F-003"), idFor("demo:bank:txn:F-004")]));
    expect(ov.proposals.filter(p => p.status === "approved").map(p => p.bankSourceId)).toEqual(["demo:bank:txn:F-007"]);
    expect(ov.entries.some(e => e.proposalId === idFor("demo:bank:txn:F-007"))).toBe(false);
  });
});
