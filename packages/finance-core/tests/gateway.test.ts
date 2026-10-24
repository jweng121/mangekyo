import type { ProposalStatus } from "@mangekyo/contracts";
import { describe, expect, it } from "vitest";
import { buildPostingEntries, canTransition, checkEvidence, classifyFailures, holdReason, checkSelfApproval, checkState, evaluateAllocation, evaluatePayment, TRANSITIONS, type GatewayContext } from "../src/gateway";
import { threeWayCheck, type AccountLedgerState } from "../src/ledger";
import { demoIds, demoUnrecordedOutflow } from "../fixtures/demoMoney";
import { demoState, NOW } from "./money";

function context(state: AccountLedgerState = demoState(), proposals: GatewayContext["proposals"] = []): GatewayContext {
  const known = new Set([...state.bankTransactions.map(t => t.sourceId), ...state.owners.map(o => o.sourceId), "demo:document:instruction-x-001:v1", "demo:document:instruction-d-001:v1", "demo:document:instruction-y-001:v1", "demo:document:remit-a-001:v1"]);
  return { state, threeWay: threeWayCheck(state, NOW), knownSourceIds: known, proposals, cutoff: NOW };
}
const payment = (ownerId: string, amountCents: number, extra: object = {}) => ({ proposalId: "pay-1", ownerId, amountCents, currency: "USD", evidenceSourceIds: ["demo:document:instruction-y-001:v1"], requestedBy: "dev:requester:riley", ...extra });
const request = { stage: "request" as const, actor: "dev:requester:riley" };
const codes = (result: ReturnType<typeof evaluatePayment>) => result.failures.map(f => f.code);

describe("L1 owner funds — the pool's cash is not the owner's cash", () => {
  it("blocks Owner X even though the pooled account holds far more than the request", () => {
    const ctx = context();
    const result = evaluatePayment(ctx, payment(demoIds.xavier, 500_000, { evidenceSourceIds: ["demo:document:instruction-x-001:v1"] }), request);
    expect(ctx.threeWay.bank.clearedCents).toBeGreaterThan(500_000 * 50);
    expect(result.allowed).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ rule: "L1", code: "OWNER_INSUFFICIENT_FUNDS", sourceIds: ["demo:owner-record:xavier"] })]);
    expect(result.failures[0].message).toContain("$120.00 available");
    expect(result.failures[0].message).toContain("$268,100.00 cleared");
    expect(result.facts).toMatchObject({ requestedCents: 500_000, ownerAvailableCents: 12_000, poolClearedCents: 26_810_000 });
  });

  it("allows a payment within the owner's available balance and counts other holds", () => {
    expect(evaluatePayment(context(), payment(demoIds.yankee, 100_000), request).allowed).toBe(true);
    const held = demoState({ holds: [{ proposalId: "other", ownerId: demoIds.yankee, amountCents: 1_450_000 }] });
    expect(codes(evaluatePayment(context(held), payment(demoIds.yankee, 100_000), request))).toEqual(["OWNER_INSUFFICIENT_FUNDS"]);
  });
});

describe("L2 funds not cleared", () => {
  it("blocks spending posted money that comes from a pending deposit", () => {
    const result = evaluatePayment(context(), payment(demoIds.delta, 200_000, { evidenceSourceIds: ["demo:document:instruction-d-001:v1"] }), request);
    expect(result.failures).toEqual([expect.objectContaining({ rule: "L2", code: "FUNDS_NOT_CLEARED", sourceIds: [demoIds.depositD] })]);
    expect(result.failures[0].message).toContain("$3,000.00 posted but only $500.00 available");
  });

  it("blocks a payment explicitly funded by an uncleared deposit, and passes once it clears", () => {
    const ctx = context();
    const funded = payment(demoIds.delta, 10_000, { fundingSourceId: demoIds.depositD, evidenceSourceIds: ["demo:document:instruction-d-001:v1"] });
    expect(codes(evaluatePayment(ctx, funded, request))).toEqual(["FUNDS_NOT_CLEARED"]);
    const cleared = demoState();
    cleared.bankTransactions = cleared.bankTransactions.map(t => t.sourceId === demoIds.depositD ? { ...t, clearing: "cleared" } : t);
    expect(evaluatePayment(context(cleared), funded, request).allowed).toBe(true);
  });
});

describe("L3 evidence", () => {
  it("requires at least one sourceId that exists in our records", () => {
    const known = new Set(["a"]);
    expect(checkEvidence([], known)?.code).toBe("MISSING_EVIDENCE");
    expect(checkEvidence(["a", "made-up"], known)?.sourceIds).toEqual(["made-up"]);
    expect(checkEvidence(["a"], known)).toBeNull();
    expect(codes(evaluatePayment(context(), payment(demoIds.yankee, 100, { evidenceSourceIds: [] }), request))).toEqual(["MISSING_EVIDENCE"]);
    expect(codes(evaluatePayment(context(), payment("demo:owner:nobody", 100), request))).toContain("MISSING_EVIDENCE");
  });
});

describe("L4 self-approval", () => {
  it("rejects the requester approving or posting their own request", () => {
    expect(checkSelfApproval("dev:requester:riley", "DEV:REQUESTER:RILEY ", "p")?.code).toBe("SELF_APPROVAL");
    expect(checkSelfApproval("dev:requester:riley", "dev:approver:sam", "p")).toBeNull();
    const result = evaluatePayment(context(), payment(demoIds.yankee, 100), { stage: "approve", actor: "dev:requester:riley", transition: { from: "pending_approval", to: "approved" } });
    expect(codes(result)).toEqual(["SELF_APPROVAL"]);
    expect(result.evaluated).toEqual(["L7", "L4", "L6", "L3", "L2", "L1", "L5", "L8", "L9", "L10", "L11"]);
  });
});

describe("L5 reconciliation lock", () => {
  it("blocks outflows for affected owners only, and allows others", () => {
    const state = demoState();
    state.bankTransactions.push(demoUnrecordedOutflow(NOW - 10));
    const ctx = context(state);
    const blocked = evaluatePayment(ctx, payment(demoIds.yankee, 100), request);
    expect(blocked.failures).toEqual([expect.objectContaining({ rule: "L5", code: "RECONCILIATION_MISMATCH", sourceIds: ["demo:bank:txn:E-001"] })]);
    expect(evaluatePayment(ctx, payment(demoIds.alpha, 100), request).allowed).toBe(true);
  });

  it("blocks a payment funded by a source named in a mismatch cause, even for an unaffected owner", () => {
    const ctx = context();
    ctx.threeWay = { ...ctx.threeWay, status: "mismatched", causes: [{ code: "AMOUNT_MISMATCH", severity: "mismatch", message: "test", amountCents: 1, sourceIds: [demoIds.depositA], ownerIds: [demoIds.yankee], unattributed: false }] };
    const unfunded = payment(demoIds.alpha, 100, { evidenceSourceIds: ["demo:document:remit-a-001:v1"] });
    expect(evaluatePayment(ctx, unfunded, request).allowed).toBe(true);
    const result = evaluatePayment(ctx, { ...unfunded, fundingSourceId: demoIds.depositA }, request);
    expect(result.failures).toEqual([expect.objectContaining({ code: "RECONCILIATION_MISMATCH", sourceIds: [demoIds.depositA] })]);
  });

  it("blocks every outflow when a cause cannot be attributed to an owner", () => {
    const state = demoState();
    state.bankTransactions.push({ ...demoUnrecordedOutflow(NOW - 10), ownerHintSourceId: null });
    expect(codes(evaluatePayment(context(state), payment(demoIds.alpha, 100), request))).toEqual(["RECONCILIATION_MISMATCH"]);
  });

  it("still allows allocations (moving money between buckets) during a mismatch", () => {
    const state = demoState();
    state.bankTransactions.push({ ...demoUnrecordedOutflow(NOW - 10), ownerHintSourceId: null });
    const result = evaluateAllocation(context(state), { proposalId: "a-1", bankSourceId: demoIds.depositA, shares: [{ ownerId: demoIds.alpha, amountCents: 150_000 }], currency: "USD", evidenceSourceIds: ["demo:document:remit-a-001:v1"], requestedBy: "agent" }, request);
    expect(result.allowed).toBe(true);
  });
});

describe("L6 amount integrity", () => {
  const alloc = (shares: Array<{ ownerId: string; amountCents: number }>, extra: object = {}) => ({ proposalId: "a-1", bankSourceId: demoIds.depositA, shares, currency: "USD", evidenceSourceIds: ["demo:document:remit-a-001:v1"], requestedBy: "agent", ...extra });
  const allocCodes = (ctx: GatewayContext, shares: Parameters<typeof alloc>[0], extra?: object) => evaluateAllocation(ctx, alloc(shares, extra), request).failures.map(f => f.message);

  it("passes when integer shares sum exactly to the deposit", () => {
    expect(evaluateAllocation(context(), alloc([{ ownerId: demoIds.alpha, amountCents: 100_000 }, { ownerId: demoIds.yankee, amountCents: 50_000 }]), request).allowed).toBe(true);
  });

  it("rejects sums that differ, non-integer or non-positive shares, duplicates, unknown owners and currency", () => {
    const ctx = context();
    expect(allocCodes(ctx, [{ ownerId: demoIds.alpha, amountCents: 149_999 }])[0]).toContain("must match exactly");
    expect(allocCodes(ctx, [{ ownerId: demoIds.alpha, amountCents: 150_000.5 }]).join()).toContain("positive integer cents");
    expect(allocCodes(ctx, [{ ownerId: demoIds.alpha, amountCents: -1 }, { ownerId: demoIds.yankee, amountCents: 150_001 }]).join()).toContain("positive integer cents");
    expect(allocCodes(ctx, [{ ownerId: demoIds.alpha, amountCents: 75_000 }, { ownerId: demoIds.alpha, amountCents: 75_000 }]).join()).toContain("appears twice");
    expect(allocCodes(ctx, [{ ownerId: "demo:owner:nobody", amountCents: 150_000 }]).join()).toContain("not in our records");
    expect(allocCodes(ctx, [{ ownerId: demoIds.alpha, amountCents: 150_000 }], { currency: "EUR" }).join()).toContain("currency");
    expect(allocCodes(ctx, [])).toContain("An allocation needs at least one owner share.");
  });

  it("rejects a second allocation of the same deposit using the full ledger history and open proposals", () => {
    const state = demoState();
    const posted = buildPostingEntries({ proposalId: "first", accountId: state.account.accountId, kind: "allocation", status: "approved", currency: "USD", requestedBy: "agent", origin: { type: "person" }, evidenceSourceIds: [], bankSourceId: demoIds.depositA, shares: [{ ownerId: demoIds.alpha, amountCents: 150_000 }], amountCents: 150_000, purpose: "x", createdAt: 0, updatedAt: 0 }, NOW - 1, "approver", "approval-1");
    state.entries.push(...posted);
    expect(allocCodes(context(state), [{ ownerId: demoIds.alpha, amountCents: 150_000 }]).join()).toContain("already has $1,500.00 allocated");
    const open = context(demoState(), [{ proposalId: "other", kind: "allocation", status: "pending_approval", bankSourceId: demoIds.depositA }]);
    expect(allocCodes(open, [{ ownerId: demoIds.alpha, amountCents: 150_000 }]).join()).toContain("open allocation proposal");
  });

  it("rejects allocating a deposit that was never recorded as received", () => {
    const state = demoState();
    state.entries = state.entries.filter(e => e.fundsSourceId !== demoIds.depositB);
    expect(evaluateAllocation(context(state), alloc([{ ownerId: demoIds.alpha, amountCents: 98_000 }], { bankSourceId: demoIds.depositB }), request).failures.map(f => f.message).join()).toContain("has not been recorded");
  });

  it("rejects payments with invalid cents or currency", () => {
    expect(codes(evaluatePayment(context(), payment(demoIds.yankee, 0), request))).toContain("AMOUNT_INTEGRITY");
    expect(codes(evaluatePayment(context(), payment(demoIds.yankee, 10.5), request))).toContain("AMOUNT_INTEGRITY");
    expect(codes(evaluatePayment(context(), payment(demoIds.yankee, 100, { currency: "EUR" }), request))).toContain("AMOUNT_INTEGRITY");
  });
});

describe("L7 state machine", () => {
  const all: ProposalStatus[] = ["proposed", "pending_approval", "approved", "posted", "rejected", "blocked", "on_hold", "cancelled"];
  it("allows only the documented transitions", () => {
    const allowed = all.flatMap(from => all.filter(to => canTransition(from, to)).map(to => `${from}->${to}`));
    expect(allowed).toEqual(["proposed->pending_approval", "proposed->blocked", "pending_approval->approved", "pending_approval->rejected", "pending_approval->blocked", "pending_approval->on_hold", "approved->posted", "approved->blocked", "approved->on_hold", "on_hold->approved", "on_hold->posted", "on_hold->blocked", "on_hold->cancelled"]);
    for (const terminal of ["posted", "rejected", "blocked", "cancelled"] as const) expect(TRANSITIONS[terminal]).toEqual([]);
    expect(canTransition("proposed", "on_hold")).toBe(false);
    expect(checkState("posted", "posted", "p")?.code).toBe("STATE");
    expect(checkState("pending_approval", "posted", "p")?.rule).toBe("L7");
  });
});

describe("posting entries", () => {
  it("are deterministic, balanced for allocations, and reference-tagged for payments", () => {
    const base = { accountId: "demo:account:pool-001", status: "approved" as const, currency: "USD", requestedBy: "r", origin: { type: "person" as const }, evidenceSourceIds: ["e"], purpose: "p", createdAt: 0, updatedAt: 0 };
    const alloc = buildPostingEntries({ ...base, proposalId: "a", kind: "allocation", bankSourceId: demoIds.depositA, shares: [{ ownerId: demoIds.alpha, amountCents: 100 }, { ownerId: demoIds.yankee, amountCents: 50 }], amountCents: 150 }, 1, "approver", "ap");
    expect(alloc.map(e => [e.entryId, e.ownerId, e.amountCents])).toEqual([["a:entry:1", null, -100], ["a:entry:2", demoIds.alpha, 100], ["a:entry:3", null, -50], ["a:entry:4", demoIds.yankee, 50]]);
    expect(alloc.reduce((s, e) => s + e.amountCents, 0)).toBe(0);
    const pay = buildPostingEntries({ ...base, proposalId: "p1", kind: "payment", ownerId: demoIds.yankee, amountCents: 100 }, 1, "approver", "ap");
    expect(pay).toEqual([expect.objectContaining({ entryId: "p1:entry:1", amountCents: -100, kind: "disbursement", bankReference: "PAY:p1", approvalId: "ap" })]);
  });
});

describe("hold classification", () => {
  const f = (rule: "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7") => ({ rule, code: "STATE" as const, message: `${rule} failed.`, sourceIds: [] });
  it("holds only when every failure is temporary (L2/L5), refuses actor/action errors, and blocks the rest", () => {
    expect(classifyFailures([])).toBe("pass");
    expect(classifyFailures([f("L2")])).toBe("temporary");
    expect(classifyFailures([f("L5"), f("L2")])).toBe("temporary");
    expect(classifyFailures([f("L2"), f("L1")])).toBe("permanent");
    for (const rule of ["L1", "L3", "L6"] as const) expect(classifyFailures([f(rule)])).toBe("permanent");
    expect(classifyFailures([f("L4"), f("L2")])).toBe("refused");
    expect(classifyFailures([f("L7")])).toBe("refused");
  });

  it("explains a hold in plain English", () => {
    const state = demoState();
    const ctx = context(state);
    const l2 = evaluatePayment(ctx, payment(demoIds.delta, 10_000, { fundingSourceId: demoIds.depositD, evidenceSourceIds: ["demo:document:instruction-d-001:v1"] }), request).failures;
    expect(holdReason(l2, state, ctx.threeWay)).toBe("On hold: $2,500.00 from DEMO Delta Tenant hasn't cleared yet.");
    state.bankTransactions.push(demoUnrecordedOutflow(NOW - 10));
    const red = context(state);
    const l5 = evaluatePayment(red, payment(demoIds.yankee, 100), request).failures;
    expect(holdReason(l5, state, red.threeWay)).toBe("On hold: the bank and the books don't agree yet (Bank outflow $2,000.00 (DEMO-WIRE-Y-9001) has no ledger entry).");
  });
});
