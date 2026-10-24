/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const ERP = "erp:account:trust-pool";
const DEMO = "demo:account:pool-001";
const requester = { role: "requester" as const, name: "riley" };
const approver = { role: "approver" as const, name: "sam" };

describe("core money workflow", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  async function setup() {
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.importErpSandbox, {});
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    return t;
  }
  const overview = (t: Awaited<ReturnType<typeof setup>>, accountId: string) => t.query(api.financeIntake.getAccountOverview, { accountId });
  async function investigate(t: Awaited<ReturnType<typeof setup>>, accountId: string, bankSourceId: string) {
    const { taskId } = await t.mutation(api.financeIntake.ensureDepositTask, { accountId, bankSourceId });
    const { runId } = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: { kind: "deposit_investigation", accountId, currency: "USD", from: null } });
    await t.action(internal.financeInvestigationActions.execute, { runId });
    return { taskId, runId, view: await t.query(api.financeInvestigations.getTaskInvestigation, { taskId }) };
  }

  it("imports idempotently by sourceId: a second import inserts nothing", async () => {
    const t = await setup();
    const again = await t.mutation(api.financeIntake.importErpSandbox, {});
    expect(again).toMatchObject({ inserted: 0, updated: 0, entriesInserted: 0, issues: [] });
    expect(again.unchanged).toBeGreaterThan(40);
    await t.run(async (ctx) => {
      expect((await ctx.db.query("financeBankTransactions").collect()).filter(r => r.accountId === ERP)).toHaveLength(15);
      expect((await ctx.db.query("financeLedgerEntries").collect()).filter(r => r.accountId === ERP)).toHaveLength(8);
    });
  });

  it("shows the real ERP account matched, with the undetailed timing item as a warning", async () => {
    const t = await setup();
    const view = await overview(t, ERP);
    expect(view.threeWay).toMatchObject({ status: "matched", bookCents: 30_000_000, ownersTotalCents: 30_000_000 });
    expect(view.deposits.filter(d => d.status === "unallocated").map(d => d.transaction.sourceId)).toEqual(["bank:txn:TX-001", "bank:txn:TX-002"]);
    expect(view.balances.find(b => b.ownerId === null)?.postedCents).toBe(825_000);
  });

  it("A: clear ERP deposit → mock proposal_ready → approval queue → approve → post, three numbers stay matched", async () => {
    const t = await setup();
    const { view, runId } = await investigate(t, ERP, "bank:txn:TX-001");
    expect(view.runs[0]).toMatchObject({ status: "review_required", result: { outcome: "proposal_ready" } });
    expect(view.runs[0].providerInput?.deterministicChecks.threeWay?.status).toBe("matched");
    let state = await overview(t, ERP);
    const [proposal] = state.proposals;
    expect(proposal).toMatchObject({ kind: "allocation", status: "pending_approval", origin: { type: "agent", runId }, bankSourceId: "bank:txn:TX-001", shares: [{ ownerId: "erp:owner:CMP-001", amountCents: 325_000 }] });
    expect(state.entries.some(e => e.proposalId === proposal.proposalId)).toBe(false);
    await expect(t.mutation(api.financeProposals.postProposal, { proposalId: proposal.proposalId, dev: approver })).resolves.toMatchObject({ proposal: { status: "blocked" }, lock: { failures: [expect.objectContaining({ code: "STATE" })] } });
  });

  it("A: approve then post writes balanced entries atomically, and a second post does nothing", async () => {
    const t = await setup();
    await investigate(t, ERP, "bank:txn:TX-001");
    const { proposalId } = (await overview(t, ERP)).proposals[0];
    const approved = await t.mutation(api.financeProposals.approveProposal, { proposalId, dev: approver });
    expect(approved.proposal).toMatchObject({ status: "approved", approvedBy: "dev-unverified:sam" });
    const posted = await t.mutation(api.financeProposals.postProposal, { proposalId, dev: approver });
    expect(posted.proposal).toMatchObject({ status: "posted", postedEntryIds: [`${proposalId}:entry:1`, `${proposalId}:entry:2`] });
    const after = await overview(t, ERP);
    expect(after.threeWay.status).toBe("matched");
    expect(after.balances.find(b => b.ownerId === "erp:owner:CMP-001")?.postedCents).toBe(4_000_000 + 325_000);
    expect(after.deposits.find(d => d.transaction.sourceId === "bank:txn:TX-001")?.status).toBe("posted");
    const before = after.entries.length;
    expect(await t.mutation(api.financeProposals.postProposal, { proposalId, dev: approver })).toMatchObject({ alreadyDone: true, proposal: { status: "posted" } });
    expect((await overview(t, ERP)).entries).toHaveLength(before);
    const transitions = await t.query(api.financeProposals.listTransitions, { proposalId });
    expect(transitions.map(r => r.to)).toEqual(["proposed", "pending_approval", "approved", "posted"]);
  });

  it("A: rejection requires a reason and reaches the next attempt as a clarification", async () => {
    const t = await setup();
    const { taskId } = await investigate(t, ERP, "bank:txn:TX-001");
    const { proposalId } = (await overview(t, ERP)).proposals[0];
    await expect(t.mutation(api.financeProposals.rejectProposal, { proposalId, reason: "  ", dev: approver })).rejects.toThrow("reason");
    await t.mutation(api.financeProposals.rejectProposal, { proposalId, reason: "Payer confirmation is for a different invoice.", dev: approver });
    const { runId } = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: { kind: "deposit_investigation", accountId: ERP, currency: "USD", from: null } });
    await t.action(internal.financeInvestigationActions.execute, { runId });
    const view = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(view.runs[0].providerInput?.humanClarifications.map(c => c.answer)).toEqual(["Payer confirmation is for a different invoice."]);
    expect(view.runs[0].result?.outcome).toBe("needs_information");
    expect((await overview(t, ERP)).proposals.find(p => p.proposalId === proposalId)?.status).toBe("rejected");
  });

  it("L4: the requester cannot approve their own request, even after switching role", async () => {
    const t = await setup();
    const { proposal } = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:yankee", amountCents: 100_000, purpose: "relocation", evidenceSourceIds: ["demo:document:instruction-y-001:v1"], dev: requester });
    expect(proposal.status).toBe("pending_approval");
    await expect(t.mutation(api.financeProposals.approveProposal, { proposalId: proposal.proposalId, dev: requester })).rejects.toThrow("approver role");
    const self = await t.mutation(api.financeProposals.approveProposal, { proposalId: proposal.proposalId, dev: { role: "approver", name: "Riley" } });
    expect(self.proposal.status).toBe("blocked");
    expect(self.lock?.failures.map(f => f.code)).toEqual(["SELF_APPROVAL"]);
  });

  it("B: unclear deposit → needs_information → answer → resumed attempt", async () => {
    const t = await setup();
    const { taskId, runId, view } = await investigate(t, DEMO, "demo:bank:txn:B-001");
    expect(view.runs[0].status).toBe("needs_information");
    expect(view.questions[0].question).toContain("$980.00");
    const resumed = await t.mutation(api.financeInvestigations.answerQuestion, { runId, questionId: view.questions[0].questionId, answer: "J Smith is a trustee of DEMO Alpha Holdings Trust; no agreement yet." });
    await t.action(internal.financeInvestigationActions.execute, { runId: resumed.runId });
    const after = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(after.runs[0]).toMatchObject({ attempt: 2, parentRunId: runId, status: "needs_information" });
    expect((await overview(t, DEMO)).proposals).toEqual([]);
  });

  it("C: the pool has plenty of cash but Owner X does not — blocked by L1 and saved as blocked", async () => {
    const t = await setup();
    const result = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:xavier", amountCents: 500_000, purpose: "annual property tax", evidenceSourceIds: ["demo:document:instruction-x-001:v1"], dev: requester });
    expect(result.proposal.status).toBe("blocked");
    expect(result.lock?.failures).toEqual([expect.objectContaining({ rule: "L1", code: "OWNER_INSUFFICIENT_FUNDS" })]);
    expect(result.lock?.facts).toMatchObject({ ownerAvailableCents: 12_000, poolClearedCents: 26_810_000 });
    const events = await t.query(api.finance.listMoneyEvents, { accountId: DEMO });
    expect(events.filter(e => e.type === "finance.money.lock_checked").at(-1)).toMatchObject({ payload: { allowed: false, reasonCodes: ["OWNER_INSUFFICIENT_FUNDS"] } });
    const snapshots = await t.query(api.finance.listMoneySnapshots, { accountId: DEMO });
    expect(snapshots).toHaveLength(events.length);
  });

  it("D: a payment drawing on a pending deposit is blocked by L2", async () => {
    const t = await setup();
    const result = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:delta", amountCents: 200_000, purpose: "roof repair", evidenceSourceIds: ["demo:document:instruction-d-001:v1"], dev: requester });
    expect(result.lock?.failures.map(f => [f.rule, f.code, f.sourceIds])).toEqual([["L2", "FUNDS_NOT_CLEARED", ["demo:bank:txn:D-001"]]]);
  });

  it("E: a posted payment the bank has not shown turns the check red, L5 blocks that owner, settlement turns it green", async () => {
    const t = await setup();
    const { proposal } = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:yankee", amountCents: 100_000, purpose: "relocation", evidenceSourceIds: ["demo:document:instruction-y-001:v1"], dev: requester });
    await t.mutation(api.financeProposals.approveProposal, { proposalId: proposal.proposalId, dev: approver });
    await t.mutation(api.financeProposals.postProposal, { proposalId: proposal.proposalId, dev: approver });
    const red = await overview(t, DEMO);
    expect(red.threeWay.status).toBe("mismatched");
    expect(red.threeWay.causes).toContainEqual(expect.objectContaining({ code: "LEDGER_ENTRY_WITHOUT_BANK_TXN", ownerIds: ["demo:owner:yankee"] }));
    const blocked = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:yankee", amountCents: 100, purpose: "second", evidenceSourceIds: ["demo:document:instruction-y-001:v1"], dev: requester });
    expect(blocked.lock?.failures.map(f => f.code)).toEqual(["RECONCILIATION_MISMATCH"]);
    const other = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:alpha", amountCents: 100, purpose: "unaffected owner", evidenceSourceIds: ["demo:document:agreement-alpha:v1"], dev: requester });
    expect(other.proposal.status).toBe("pending_approval");
    await t.mutation(api.financeIntake.simulateSettlement, { proposalId: proposal.proposalId });
    expect((await overview(t, DEMO)).threeWay.status).toBe("matched");
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, {});
    const unrecorded = await overview(t, DEMO);
    expect(unrecorded.threeWay.causes).toContainEqual(expect.objectContaining({ code: "BANK_TXN_WITHOUT_LEDGER_ENTRY", sourceIds: ["demo:bank:txn:E-001"], ownerIds: ["demo:owner:yankee"] }));
    await expect(t.mutation(api.financeIntake.simulateSettlement, { proposalId: other.proposal.proposalId })).rejects.toThrow("posted payments");
  });

  it("re-runs the lock at posting time: an approved payment is blocked if the owner's money is gone by then", async () => {
    const t = await setup();
    const first = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:yankee", amountCents: 1_000_000, purpose: "first", evidenceSourceIds: ["demo:document:instruction-y-001:v1"], dev: requester });
    const second = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:yankee", amountCents: 500_000, purpose: "second", evidenceSourceIds: ["demo:document:instruction-y-001:v1"], dev: requester });
    expect(second.proposal.status).toBe("pending_approval");
    await t.mutation(api.financeProposals.approveProposal, { proposalId: first.proposal.proposalId, dev: approver });
    await t.mutation(api.financeProposals.approveProposal, { proposalId: second.proposal.proposalId, dev: approver });
    await t.mutation(api.financeProposals.postProposal, { proposalId: first.proposal.proposalId, dev: approver });
    const late = await t.mutation(api.financeProposals.postProposal, { proposalId: second.proposal.proposalId, dev: approver });
    expect(late.proposal.status).toBe("blocked");
    expect(late.lock?.failures.map(f => f.code)).toContain("RECONCILIATION_MISMATCH");
  });

  it("corrects a posted allocation with reversal entries, freeing the deposit without deleting history", async () => {
    const t = await setup();
    await investigate(t, ERP, "bank:txn:TX-001");
    const { proposalId } = (await overview(t, ERP)).proposals[0];
    await t.mutation(api.financeProposals.approveProposal, { proposalId, dev: approver });
    await t.mutation(api.financeProposals.postProposal, { proposalId, dev: approver });
    await expect(t.mutation(api.financeProposals.reversePosting, { proposalId, reason: "", dev: approver })).rejects.toThrow("reason");
    const reversed = await t.mutation(api.financeProposals.reversePosting, { proposalId, reason: "Allocated to the wrong client", dev: approver });
    expect(reversed).toEqual({ entryIds: [`${proposalId}:entry:1:reversal`, `${proposalId}:entry:2:reversal`], alreadyDone: false });
    expect((await t.mutation(api.financeProposals.reversePosting, { proposalId, reason: "again", dev: approver })).alreadyDone).toBe(true);
    const after = await overview(t, ERP);
    expect(after.threeWay.status).toBe("matched");
    expect(after.deposits.find(d => d.transaction.sourceId === "bank:txn:TX-001")?.status).toBe("unallocated");
    expect(after.balances.find(b => b.ownerId === "erp:owner:CMP-001")?.postedCents).toBe(4_000_000);
    expect(after.entries.filter(e => e.proposalId === proposalId)).toHaveLength(4);
  });

  it("never deletes: ledger entries only accumulate across the workflow", async () => {
    const t = await setup();
    const ids = async () => (await t.run(async (ctx) => (await ctx.db.query("financeLedgerEntries").collect()).map(r => `${r.entryId}:${r.amountCents}`)));
    const start = await ids();
    await investigate(t, ERP, "bank:txn:TX-002");
    const { proposalId } = (await overview(t, ERP)).proposals[0];
    await t.mutation(api.financeProposals.approveProposal, { proposalId, dev: approver });
    await t.mutation(api.financeProposals.postProposal, { proposalId, dev: approver });
    await t.mutation(api.financeIntake.importErpSandbox, {});
    const end = await ids();
    expect(end).toEqual(expect.arrayContaining(start));
    expect(end.length).toBe(start.length + 2);
  });
});
