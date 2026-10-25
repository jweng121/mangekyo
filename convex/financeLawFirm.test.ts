/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { FunctionReturnType } from "convex/server";
import { PARALEGAL_FEE_PURPOSE } from "@mangekyo/finance-core/fixtures/law-firm-feed";
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
async function next(t: T, step: number) { expect(await t.mutation(api.financeIntake.feedNext, { accountId })).toMatchObject({ step, total: 10 }); await drain(t); }
async function post(t: T, proposalId: string) {
  expect((await t.mutation(api.financeProposals.approveProposal, { proposalId, dev: sam })).proposal.status).toBe("approved");
  expect((await t.mutation(api.financeProposals.postProposal, { proposalId, dev: sam })).proposal.status).toBe("posted");
}

it.each([true, false])("runs all ten law-firm steps with Okafor posted and policy approved = %s", async (approved) => {
  const t = convexTest(schema, modules);
  await t.mutation(api.financeIntake.startFreshDemoRun, {});
  expect((await view(t)).threeWay).toMatchObject({ status: "matched", bookCents: 33_950_000 });
  await next(t, 1);
  const original = (await runs(t, "harborline-delgado")).runs[0];
  expect(original.result?.proposedAllocations).toEqual([]);
  expect(original.result?.summary).toContain("Waiting for the check to clear");
  expect(original.provenance).toMatchObject({ agent: "intake", mode: "mock", model: "mock" });

  // Step 2: the Disbursement agent prepares the three lines from the signed statement; the lock blocks each one until the check clears (L2).
  await next(t, 2);
  const [firstDisbursement] = await t.query(api.financeTrust.listDisbursements, { accountId });
  expect(firstDisbursement).toMatchObject({ status: "needs_person", matterId: "matter:delgado-v-ridgeway", attempt: 1, provenance: { agent: "disbursement", mode: "mock" } });
  expect(firstDisbursement.output?.lines.map(l => [l.kind, l.amountCents])).toEqual([["attorney_fee", 2_805_000], ["costs", 95_000], ["client_share", 5_600_000]]);
  expect(firstDisbursement.claimCheck?.status).toBe("passed");
  const blockedLines = (await view(t)).proposals.filter(p => firstDisbursement.proposalIds.includes(p.proposalId));
  expect(blockedLines).toHaveLength(3);
  for (const line of blockedLines) {
    expect(line.status).toBe("blocked");
    expect(line.blockedReasons?.map(f => f.rule)).toContain("L2");
    expect(line.blockedReasons?.find(f => f.rule === "L2")?.message).toContain("has not cleared");
  }

  // Step 3: the check clears, a person approves the allocation, and Disbursement runs again on its own.
  await next(t, 3);
  const delgadoRuns = (await runs(t, "harborline-delgado")).runs;
  expect(delgadoRuns.find(r => r.runId === original.runId)).toEqual(original);
  const allocation = (await view(t)).proposals.find(p => p.kind === "allocation")!;
  expect(allocation.shares).toEqual([{ ownerId: "demo:owner:maria-delgado", amountCents: 8_500_000 }]);
  await post(t, allocation.proposalId);
  await drain(t);
  const second = (await t.query(api.financeTrust.listDisbursements, { accountId })).find(d => d.attempt === 2)!;
  expect(second).toMatchObject({ status: "ready_for_approval", claimCheck: { status: "passed" } });
  const detail = (await t.query(api.financeTrust.getDisbursement, { runId: second.runId }))!;
  expect(detail.state).toBe("ready_for_approval");
  expect(detail.lines.map(l => [l.line.kind, l.status, l.lock?.allowed])).toEqual([["attorney_fee", "pending_approval", true], ["costs", "pending_approval", true], ["client_share", "pending_approval", true]]);
  // Every line's claim was verified against the signed statement (and the fee agreement for the fee line).
  expect(second.claimCheck?.claims.every(c => c.verdict === "supported")).toBe(true);
  expect(second.claimCheck?.claims.find(c => c.findingId === "payout:line-1")?.sourceRefs).toEqual(["demo:document:delgado-settlement-statement:v1", "demo:document:delgado-fee-agreement:v1"]);
  // The firm's contingency fee passes L9 because the signed statement's fee line matches the signed 33% fee agreement.
  for (const proposalId of second.proposalIds) {
    const result = await t.mutation(api.financeProposals.approveProposal, { proposalId, dev: sam });
    expect(result.lock?.evaluated).toContain("L9"); expect(result.lock?.evaluated).toContain("L11");
    expect(result.proposal.status).toBe("approved");
    expect((await t.mutation(api.financeProposals.postProposal, { proposalId, dev: sam })).proposal.status).toBe("posted");
  }
  const afterPayout = await view(t);
  expect(afterPayout.balances.find(b => b.ownerId === "demo:owner:maria-delgado")?.postedCents).toBe(0);
  expect(afterPayout.proposals.filter(p => firstDisbursement.proposalIds.includes(p.proposalId)).every(p => p.status === "blocked")).toBe(true);

  await next(t, 4);
  const q = (await runs(t, "okafor-retainer")).questions[0];
  expect(q.question).toBe("Is $2,500.00 a partial payment of Daniel Okafor's $5,000.00 retainer?");
  if (approved) {
    await t.mutation(api.financeInvestigations.answerQuestion, { runId: q.runId, questionId: q.questionId, answer: "Yes, a partial retainer payment." }); await drain(t);
    await post(t, (await view(t)).proposals.find(p => p.bankSourceId === "demo:bank:txn:okafor-retainer")!.proposalId);
  }
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
  const duplicate = await t.mutation(api.financeIntake.confirmDuplicate, { accountId, bankSourceId: "demo:bank:txn:bayview-second", dev: riley });
  expect((await t.mutation(api.financeProposals.approveProposal, { proposalId: duplicate.proposalId, dev: { ...sam, name: "riley" } })).lock?.failures.some(f => f.rule === "L4")).toBe(true);
  await post(t, duplicate.proposalId);
  const refund = await t.mutation(api.financeProposals.requestPayment, { accountId, ownerId: "demo:owner:bayview-refund", amountCents: 4_000_000, purpose: "Refund confirmed duplicate to Bayview Title", evidenceSourceIds: ["demo:document:bayview-duplicate-decision:v1"], dev: riley });
  await post(t, refund.proposal.proposalId);
  await t.mutation(api.financeIntake.simulateSettlement, { proposalId: refund.proposal.proposalId });
  expect((await view(t)).balances.find(b => b.ownerId === "demo:owner:bayview-refund")?.postedCents).toBe(0);
  expect((await runs(t, "bayview-second")).clarifications[0].respondent.identity).toBe("dev-unverified:riley");
  await next(t, 7);
  const cho = (await view(t)).proposals.find(p => p.ownerId === "demo:owner:raymond-cho")!;
  expect(cho.status).toBe("blocked"); expect(cho.blockedReasons?.map(f => f.rule)).toContain("L1");
  await next(t, 8);
  const desk = await t.query(api.financeDesk.getDeskData, { accountId });
  const insurance = desk.policies.find(p => p.statement === "Insurance checks that quote a claim number go to the client on that claim.")!;
  expect(insurance).toBeDefined();
  // Memory becomes a candidate rule: Okafor's confirmed partial retainer is offered as a policy only after a person confirmed it.
  expect(desk.policies.some(p => p.policyId === "partial-retainer")).toBe(approved);
  if (approved) await t.mutation(api.financeProposals.approvePolicy, { runId: insurance.runId, candidatePolicyId: insurance.policyId, dev: sam });
  await next(t, 9);
  const westbrook = (await view(t)).proposals.find(p => p.bankSourceId === "demo:bank:txn:harborline-westbrook")!;
  expect(westbrook.shares?.[0].ownerId).toBe("demo:owner:westbrook");
  expect((await t.mutation(api.financeProposals.approveAllProven, { accountId, dev: sam })).approved).toEqual(approved ? [westbrook.proposalId] : []);
  expect((await view(t)).threeWay.status).toBe("matched");

  // Step 10: a paralegal moves $3,000 of Chen & Park fees to the firm with no invoice: blocked by L9, nothing moves.
  await next(t, 10);
  const fee = (await view(t)).proposals.find(p => p.purpose === PARALEGAL_FEE_PURPOSE)!;
  expect(fee).toMatchObject({ status: "blocked", requestedBy: "dev-unverified:priya", payoutKind: "attorney_fee", ownerId: "demo:owner:chen-park" });
  expect(fee.blockedReasons?.map(f => f.rule)).toContain("L9");
  expect(fee.blockedReasons?.find(f => f.rule === "L9")?.message).toContain("no approved invoice");
  expect((await view(t)).balances.find(b => b.ownerId === "demo:owner:chen-park")?.postedCents).toBe(12_000_000);
  expect(await t.mutation(api.financeIntake.feedNext, { accountId })).toMatchObject({ step: 10, done: true });

  const beforeBounce = await view(t);
  const bounce = await t.mutation(api.financeIntake.simulateClientBounce, { accountId, dev: riley });
  const bounced = await view(t);
  expect(bounced.threeWay.bookCents).toBe(beforeBounce.threeWay.bookCents);
  expect(bounced.threeWay.bank.adjustedCents).toBe(beforeBounce.threeWay.bank.adjustedCents! - (approved ? 250_000 : 120_000));
  expect(bounced.threeWay.status).toBe("mismatched");
  expect(bounced.threeWay.causes).toContainEqual(expect.objectContaining({ code: "BANK_TXN_WITHOUT_LEDGER_ENTRY", ownerIds: [approved ? "demo:owner:daniel-okafor" : "demo:owner:james-nguyen"] }));
  await expect(t.mutation(api.financeIntake.recordBankItem, { accountId, bankSourceId: bounce.sourceId, dev: { ...sam, name: "riley" } })).rejects.toThrow("different person");
  await t.mutation(api.financeIntake.recordBankItem, { accountId, bankSourceId: bounce.sourceId, dev: sam });
  expect((await view(t)).threeWay.status).toBe("matched");
  expect((await view(t)).balances.find(b => b.ownerId === (approved ? "demo:owner:daniel-okafor" : "demo:owner:james-nguyen"))?.postedCents).toBe(approved ? 0 : 420_000);
  expect((await t.mutation(api.financeIntake.simulateClientBounce, { accountId, dev: riley })).created).toBe(false);
  // Native pagination returns every event, including old investigation boundaries, in timestamp order.
  let cursor: string | null = null;
  const ids: string[] = []; const times: number[] = [];
  for (;;) {
    const page: FunctionReturnType<typeof api.financeDesk.getActivity> = await t.query(api.financeDesk.getActivity, { accountId, paginationOpts: { numItems: 20, cursor } });
    ids.push(...page.page.map(e => e.eventId)); times.push(...page.page.map(e => e.timestamp));
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(new Set(ids).size).toBe(ids.length);
  expect(times).toEqual([...times].sort((a, b) => b - a));
  expect(ids.length).toBe(await t.run(async ctx => (await ctx.db.query("financeEvents").collect()).length));
});
