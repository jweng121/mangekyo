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

describe("Fix 2: hold instead of kill", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); vi.stubEnv("AUTO_INVESTIGATE", "false"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  async function setup() {
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    return t;
  }
  const overview = (t: T) => t.query(api.financeIntake.getAccountOverview, { accountId: DEMO });
  const request = (t: T, ownerId: string, amountCents: number, evidence: string) =>
    t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId, amountCents, purpose: "hold test", evidenceSourceIds: [evidence], dev: requester });
  const holdEvents = async (t: T, proposalId: string) => (await t.query(api.finance.listMoneyEvents, { accountId: DEMO }))
    .filter(e => e.type === "finance.money.hold_updated" && e.payload.proposalId === proposalId);

  it("L5 at posting holds the proposal, flags it to a person, and only a person continues it once rules pass", async () => {
    const t = await setup();
    const { proposal } = await request(t, "demo:owner:yankee", 100_000, "demo:document:instruction-y-001:v1");
    await t.mutation(api.financeProposals.approveProposal, { proposalId: proposal.proposalId, dev: approver });
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, {});

    const held = await t.mutation(api.financeProposals.postProposal, { proposalId: proposal.proposalId, dev: approver });
    expect(held.proposal).toMatchObject({ status: "on_hold", hold: { stage: "post", ready: false, reasonCodes: ["RECONCILIATION_MISMATCH"], lastCheckedBy: "dev-unverified:sam" } });
    expect(held.proposal.hold?.message).toBe("On hold: the bank and the books don't agree yet (Bank outflow $2,000.00 (DEMO-WIRE-Y-9001) has no ledger entry).");
    expect((await overview(t)).entries.some(e => e.proposalId === proposal.proposalId)).toBe(false);

    const rechecked = await t.mutation(api.financeProposals.recheckHeld, { proposalId: proposal.proposalId, dev: requester });
    expect(rechecked.hold).toMatchObject({ ready: false, lastDecision: "recheck", lastCheckedBy: "dev-unverified:riley" });
    const waiting = await t.mutation(api.financeProposals.keepWaiting, { proposalId: proposal.proposalId, dev: approver });
    expect(waiting.hold).toMatchObject({ lastDecision: "keep_waiting", lastCheckedBy: "dev-unverified:sam" });

    await t.mutation(api.financeIntake.recordBankItem, { accountId: DEMO, bankSourceId: "demo:bank:txn:E-001", dev: approver });
    const ready = (await overview(t)).proposals.find(p => p.proposalId === proposal.proposalId)!;
    expect(ready).toMatchObject({ status: "on_hold", hold: { ready: true, lastDecision: "auto_recheck" } });
    expect((await overview(t)).entries.some(e => e.proposalId === proposal.proposalId)).toBe(false);
    const messages = (await holdEvents(t, proposal.proposalId)).map(e => e.payload.message);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatch(/^Re-check by dev-unverified:riley: On hold/);
    expect(messages[1]).toMatch(/^dev-unverified:sam chose to keep waiting/);
    expect(messages[2]).toMatch(/^Automatic re-check: Ready to continue/);

    await expect(t.mutation(api.financeProposals.continueHeld, { proposalId: proposal.proposalId, dev: requester })).rejects.toThrow("approver role");
    const self = await t.mutation(api.financeProposals.continueHeld, { proposalId: proposal.proposalId, dev: { role: "approver", name: "riley" } });
    expect(self).toMatchObject({ proposal: { status: "on_hold" }, lock: { allowed: false } });
    const posted = await t.mutation(api.financeProposals.continueHeld, { proposalId: proposal.proposalId, dev: approver });
    expect(posted.proposal.status).toBe("posted");
    const after = await overview(t);
    expect(after.entries.filter(e => e.proposalId === proposal.proposalId).map(e => e.amountCents)).toEqual([-100_000]);
    expect(after.threeWay.status).toBe("matched");
    expect((await t.query(api.financeProposals.listTransitions, { proposalId: proposal.proposalId })).map(r => [r.to, r.actor])).toEqual([
      ["proposed", "dev-unverified:riley"], ["pending_approval", "dev-unverified:riley"], ["approved", "dev-unverified:sam"], ["on_hold", "dev-unverified:sam"], ["posted", "dev-unverified:sam"],
    ]);
  });

  it("L2 at approval holds with a plain-English reason and becomes ready when the deposit clears", async () => {
    const t = await setup();
    const { proposal } = await request(t, "demo:owner:delta", 40_000, "demo:document:instruction-d-001:v1");
    expect(proposal.status).toBe("pending_approval");
    await t.run(async (ctx) => {
      await ctx.db.insert("financeBankTransactions", { sourceId: "demo:bank:txn:TEST-D-FEE", accountId: DEMO, subAccount: "DEMO-POOL", direction: "outflow", amountCents: 20_000, currency: "USD", bookedAt: Date.now() - 1000, clearing: "cleared", reference: "DEMO-FEE-D", counterparty: "DEMO Bank", ownerHintSourceId: "demo:owner-record:delta", documentSourceIds: [], duplicateOfSourceId: null, raw: { system: "demo", recordType: "bank-transaction", rawId: "TEST-D-FEE", datasetVersion: "test" } });
    });
    await t.mutation(api.financeIntake.recordBankItem, { accountId: DEMO, bankSourceId: "demo:bank:txn:TEST-D-FEE", dev: approver });

    const held = await t.mutation(api.financeProposals.approveProposal, { proposalId: proposal.proposalId, dev: approver });
    expect(held.proposal).toMatchObject({ status: "on_hold", hold: { stage: "approve", ready: false, reasonCodes: ["FUNDS_NOT_CLEARED"] } });
    expect(held.proposal.hold?.message).toBe("On hold: $2,500.00 from DEMO Delta Tenant hasn't cleared yet.");
    expect((await overview(t)).balances.find(b => b.ownerId === "demo:owner:delta")?.holdsCents).toBe(40_000);

    await t.mutation(api.financeIntake.simulateDepositCleared, { bankSourceId: "demo:bank:txn:D-001" });
    expect((await overview(t)).proposals.find(p => p.proposalId === proposal.proposalId)?.hold?.ready).toBe(true);
    const approved = await t.mutation(api.financeProposals.continueHeld, { proposalId: proposal.proposalId, dev: approver });
    expect(approved.proposal).toMatchObject({ status: "approved", approvedBy: "dev-unverified:sam" });
    expect((await t.mutation(api.financeProposals.postProposal, { proposalId: proposal.proposalId, dev: approver })).proposal.status).toBe("posted");
  });

  it("cancel with reason ends a held proposal and records who did it", async () => {
    const t = await setup();
    const { proposal } = await request(t, "demo:owner:yankee", 100_000, "demo:document:instruction-y-001:v1");
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, {});
    expect((await t.mutation(api.financeProposals.approveProposal, { proposalId: proposal.proposalId, dev: approver })).proposal.status).toBe("on_hold");
    await expect(t.mutation(api.financeProposals.cancelHeld, { proposalId: proposal.proposalId, reason: " ", dev: approver })).rejects.toThrow("reason");
    const cancelled = await t.mutation(api.financeProposals.cancelHeld, { proposalId: proposal.proposalId, reason: "Client withdrew the instruction", dev: approver });
    expect(cancelled).toMatchObject({ status: "cancelled", cancellationReason: "Client withdrew the instruction" });
    const last = (await t.query(api.financeProposals.listTransitions, { proposalId: proposal.proposalId })).at(-1);
    expect(last).toMatchObject({ from: "on_hold", to: "cancelled", actor: "dev-unverified:sam", reason: "Client withdrew the instruction" });
    await expect(t.mutation(api.financeProposals.continueHeld, { proposalId: proposal.proposalId, dev: approver })).rejects.toThrow("not on hold");
    expect((await overview(t)).balances.find(b => b.ownerId === "demo:owner:yankee")?.holdsCents).toBe(0);
  });

  it("permanent failures at approval still block, and any failure at request time still blocks", async () => {
    const t = await setup();
    const { proposal } = await request(t, "demo:owner:yankee", 1_400_000, "demo:document:instruction-y-001:v1");
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, {});
    await t.mutation(api.financeIntake.recordBankItem, { accountId: DEMO, bankSourceId: "demo:bank:txn:E-001", dev: approver });
    const l1 = await t.mutation(api.financeProposals.approveProposal, { proposalId: proposal.proposalId, dev: approver });
    expect(l1.proposal.status).toBe("blocked");
    expect(l1.lock?.failures.map(f => f.code)).toEqual(["OWNER_INSUFFICIENT_FUNDS"]);

    const atRequest = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:delta", amountCents: 100_000, purpose: "funded by pending", evidenceSourceIds: ["demo:document:instruction-d-001:v1"], fundingSourceId: "demo:bank:txn:D-001", dev: requester });
    expect(atRequest.proposal.status).toBe("blocked");
    expect(atRequest.lock?.failures.every(f => f.code === "FUNDS_NOT_CLEARED")).toBe(true);
  });

  it("a held payment keeps reserving the owner's funds", async () => {
    const t = await setup();
    const { proposal } = await request(t, "demo:owner:yankee", 1_000_000, "demo:document:instruction-y-001:v1");
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, {});
    await t.mutation(api.financeProposals.approveProposal, { proposalId: proposal.proposalId, dev: approver });
    await t.mutation(api.financeIntake.recordBankItem, { accountId: DEMO, bankSourceId: "demo:bank:txn:E-001", dev: approver });
    const second = await request(t, "demo:owner:yankee", 400_000, "demo:document:instruction-y-001:v1");
    expect(second.lock?.failures.map(f => f.code)).toEqual(["OWNER_INSUFFICIENT_FUNDS"]);
  });
});
