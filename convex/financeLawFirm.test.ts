/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const accountId = "demo:account:pool-001";
const sam = { role: "approver" as const, name: "sam" };
const riley = { role: "requester" as const, name: "riley" };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
type T = ReturnType<typeof convexTest>;
async function drain(t: T) { for (let i = 0; i < 8; i++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); } }
const view = (t: T) => t.query(api.financeIntake.getAccountOverview, { accountId });
const runs = (t: T, name: string) => t.query(api.financeInvestigations.getTaskInvestigation, { taskId: `intake:${accountId}:deposit:demo:bank:txn:${name}` });
async function next(t: T, step: number) { expect(await t.mutation(api.financeIntake.feedNext, { accountId })).toMatchObject({ step, total: 9 }); await drain(t); }
async function post(t: T, proposalId: string) {
  expect((await t.mutation(api.financeProposals.approveProposal, { proposalId, dev: sam })).proposal.status).toBe("approved");
  expect((await t.mutation(api.financeProposals.postProposal, { proposalId, dev: sam })).proposal.status).toBe("posted");
}

it("runs all nine law-firm steps through unchanged validators and money gates", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.financeIntake.startFreshDemoRun, {});
  expect((await view(t)).threeWay).toMatchObject({ status: "matched", bookCents: 33_950_000 });
  await next(t, 1);
  const original = (await runs(t, "harborline-delgado")).runs[0];
  expect(original.result?.proposedAllocations).toEqual([]);
  expect(original.result?.summary).toContain("Waiting for the check to clear");
  await next(t, 2);
  const blocked = (await view(t)).proposals[0];
  expect(blocked.status).toBe("blocked");
  expect(blocked.blockedReasons?.some(f => f.rule === "L2")).toBe(true);
  await next(t, 3);
  const delgadoRuns = (await runs(t, "harborline-delgado")).runs;
  expect(delgadoRuns.find(r => r.runId === original.runId)).toEqual(original);
  const allocation = (await view(t)).proposals.find(p => p.kind === "allocation")!;
  expect(allocation.shares).toEqual([{ ownerId: "demo:owner:maria-delgado", amountCents: 8_500_000 }]);
  await post(t, allocation.proposalId);
  const payment = await t.mutation(api.financeProposals.requestPayment, { accountId, ownerId: "demo:owner:maria-delgado", amountCents: 5_600_000, purpose: "Delgado client share after clearing", evidenceSourceIds: ["demo:document:delgado-settlement:v1"], fundingSourceId: "demo:bank:txn:harborline-delgado", dev: riley });
  expect(payment.proposal.status).toBe("pending_approval");
  await post(t, payment.proposal.proposalId);
  expect((await view(t)).proposals.find(p => p.proposalId === blocked.proposalId)).toEqual(blocked);
  await next(t, 4);
  const q = (await runs(t, "okafor-retainer")).questions[0];
  expect(q.question).toBe("Is $2,500.00 a partial payment of Daniel Okafor's $5,000.00 retainer?");
  await t.mutation(api.financeInvestigations.answerQuestion, { runId: q.runId, questionId: q.questionId, answer: "Yes, a partial retainer payment." }); await drain(t);
  await post(t, (await view(t)).proposals.find(p => p.bankSourceId === "demo:bank:txn:okafor-retainer")!.proposalId);
  await next(t, 5);
  const nq = (await runs(t, "nguyen-zelle")).questions[0];
  expect(nq.question).toBe("Which Nguyen is this for, Linh or James?");
  const answered = await t.mutation(api.financeInvestigations.answerQuestion, { runId: nq.runId, questionId: nq.questionId, answer: "James" }); await drain(t);
  const rejected = (await runs(t, "nguyen-zelle")).runs.find(r => r.runId === answered.runId)!;
  expect(rejected.status).toBe("checker_rejected");
  expect(rejected.claimCheck?.claims[0].missing).toContain("James Nguyen");
  const correction = await t.mutation(api.financeInvestigations.correctAndRerun, { runId: rejected.runId, choice: "cite_clarification", note: "", dev: sam }); await drain(t);
  expect((await runs(t, "nguyen-zelle")).runs.find(r => r.runId === correction.runId)).toMatchObject({ status: "review_required", claimCheck: { status: "passed" } });
  await post(t, (await view(t)).proposals.find(p => p.bankSourceId === "demo:bank:txn:nguyen-zelle")!.proposalId);
  await next(t, 6);
  expect((await runs(t, "bayview-second")).questions[0].question).toContain("duplicate");
  await next(t, 7);
  const cho = (await view(t)).proposals.find(p => p.ownerId === "demo:owner:raymond-cho")!;
  expect(cho.status).toBe("blocked"); expect(cho.blockedReasons?.map(f => f.rule)).toContain("L1");
  await next(t, 8);
  const desk = await t.query(api.financeDesk.getDeskData, { accountId });
  expect(desk.policies).toHaveLength(1);
  expect(desk.policies[0].statement).toBe("Insurance checks that quote a claim number go to the client on that claim.");
  await t.mutation(api.financeProposals.approvePolicy, { runId: desk.policies[0].runId, candidatePolicyId: desk.policies[0].policyId, dev: sam });
  await next(t, 9);
  const westbrook = (await view(t)).proposals.find(p => p.bankSourceId === "demo:bank:txn:harborline-westbrook")!;
  expect(westbrook.shares?.[0].ownerId).toBe("demo:owner:westbrook");
  expect((await t.mutation(api.financeProposals.approveAllProven, { accountId, dev: sam })).approved).toEqual([westbrook.proposalId]);
  expect((await view(t)).threeWay.status).toBe("matched");
  expect(await t.mutation(api.financeIntake.feedNext, { accountId })).toMatchObject({ step: 9, done: true });
});
