import { describe, expect, it } from "vitest";
import { affectedOwners, buildReversalEntries, ownerBalances, threeWayCheck } from "../src/ledger";
import { demoIds, demoSettlement, demoUnrecordedOutflow } from "../fixtures/demoMoney";
import { demoState, entry, erpState, NOW } from "./money";

const LATEST_CUTOFF = Number.MAX_SAFE_INTEGER;

const codes = (result: ReturnType<typeof threeWayCheck>) => result.causes.map(c => c.code);

describe("three-way check on the real ERP import", () => {
  it("matches bank, books and owners at 300,000.00 and reports the undetailed timing item", () => {
    const result = threeWayCheck(erpState(), NOW);
    expect(result).toMatchObject({ status: "matched", bookCents: 30_000_000, ownersTotalCents: 30_000_000, unallocatedCents: 825_000, differences: { bankMinusBook: 0, bookMinusOwners: 0 } });
    expect(result.bank).toMatchObject({ statementCents: 30_150_000, reconcilingCents: -150_000, adjustedCents: 30_000_000, pendingCents: 720_000, clearedCents: 29_280_000 });
    expect(result.causes).toEqual([expect.objectContaining({ code: "RECONCILING_ITEM_WITHOUT_DETAIL", severity: "warning", sourceIds: ["erp:timing-adjustment:trust-pool"] })]);
  });

  it("is insufficient before the cutover statement exists", () => {
    const result = threeWayCheck(erpState(), Date.UTC(2026, 9, 1));
    expect(result.status).toBe("insufficient_data");
    expect(codes(result)).toContain("NO_OPENING_BALANCE");
    expect(affectedOwners(result)).toBe("all");
  });
});

describe("three-way check causes", () => {
  it("matches on the demo fixture", () => {
    const result = threeWayCheck(demoState(), NOW);
    expect(result.status).toBe("matched");
    expect(result.bookCents).toBe(26_812_000 + 248_000);
    expect(result.bank.pendingCents).toBe(250_000);
  });

  it("finds a bank transaction with no ledger entry and attributes it to the hinted owner", () => {
    const state = demoState();
    state.bankTransactions.push(demoUnrecordedOutflow(NOW - 10));
    const result = threeWayCheck(state, NOW);
    expect(result.status).toBe("mismatched");
    expect(result.differences.bankMinusBook).toBe(-200_000);
    expect(result.causes).toContainEqual(expect.objectContaining({ code: "BANK_TXN_WITHOUT_LEDGER_ENTRY", sourceIds: ["demo:bank:txn:E-001"], ownerIds: [demoIds.yankee], unattributed: false }));
    expect(affectedOwners(result)).toEqual(new Set([demoIds.yankee]));
  });

  it("treats a posted payment the bank has not shown as an outstanding item, not a mismatch", () => {
    const state = demoState();
    const before = threeWayCheck(state, NOW);
    state.entries.push(entry({ entryId: "pay-1:entry:1", ownerId: demoIds.yankee, amountCents: -100_000, kind: "disbursement", bankReference: "PAY:pay-1", sourceRefs: ["demo:document:instruction-y-001:v1"] }));
    const posted = threeWayCheck(state, NOW);
    expect(posted.status).toBe("matched");
    expect(posted.outstanding).toEqual([expect.objectContaining({ kind: "outstanding_payment", entryId: "pay-1:entry:1", amountCents: -100_000, bankReference: "PAY:pay-1", ageDays: 0 })]);
    expect(posted.bank.outstandingCents).toBe(-100_000);
    expect(posted.bank.adjustedCents).toBe(before.bank.adjustedCents! - 100_000);
    expect(posted.bank.clearedCents).toBe(before.bank.clearedCents);
    expect(affectedOwners(posted)).toEqual(new Set());
    state.bankTransactions.push(demoSettlement("pay-1", 100_000, NOW - 5, "demo:owner-record:yankee"));
    const settled = threeWayCheck(state, NOW);
    expect(settled).toMatchObject({ status: "matched", outstanding: [] });
    expect(settled.bank.adjustedCents).toBe(posted.bank.adjustedCents);
  });

  it("turns an outstanding item into a mismatch once it is older than the limit", () => {
    const state = demoState();
    state.entries.push(entry({ entryId: "pay-1:entry:1", ownerId: demoIds.yankee, amountCents: -100_000, kind: "disbursement", bankReference: "PAY:pay-1", effectiveAt: NOW }));
    const day = 24 * 60 * 60 * 1000;
    expect(threeWayCheck(state, NOW + 5 * day, { outstandingMaxDays: 5 }).status).toBe("matched");
    const aged = threeWayCheck(state, NOW + 5 * day + 1, { outstandingMaxDays: 5 });
    expect(aged.status).toBe("mismatched");
    expect(aged.outstanding).toEqual([]);
    expect(aged.causes).toContainEqual(expect.objectContaining({ code: "OUTSTANDING_ITEM_AGED", ownerIds: [demoIds.yankee], sourceIds: ["pay-1:entry:1"] }));
    expect(affectedOwners(aged)).toEqual(new Set([demoIds.yankee]));
    expect(threeWayCheck(state, NOW + 2 * day, { outstandingMaxDays: 1 }).status).toBe("mismatched");
    expect(threeWayCheck(state, LATEST_CUTOFF, { now: NOW + day }).status).toBe("matched");
  });

  it("treats a recorded deposit the bank has not shown as a deposit in transit, with the same age limit", () => {
    const state = demoState();
    state.entries.push(entry({ entryId: "dit", amountCents: 40_000, kind: "deposit_received", bankReference: "DEMO-LOCKBOX-1", effectiveAt: NOW }));
    expect(threeWayCheck(state, NOW).outstanding).toEqual([expect.objectContaining({ kind: "deposit_in_transit", amountCents: 40_000 })]);
    expect(threeWayCheck(state, NOW).status).toBe("matched");
    expect(threeWayCheck(state, NOW + 6 * 24 * 60 * 60 * 1000).causes.map(c => c.code)).toContain("OUTSTANDING_ITEM_AGED");
  });

  it("finds amount mismatches between the bank and its ledger entry", () => {
    const state = demoState();
    state.entries.push(entry({ entryId: "pay-2:entry:1", ownerId: demoIds.alpha, amountCents: -100_000, kind: "disbursement", bankReference: "PAY:pay-2" }));
    state.bankTransactions.push(demoSettlement("pay-2", 99_000, NOW - 5, null));
    expect(codes(threeWayCheck(state, NOW))).toContain("AMOUNT_MISMATCH");
  });

  it("finds duplicate postings of the same bank transaction", () => {
    const state = demoState();
    state.entries.push(entry({ entryId: "dup", amountCents: 150_000, kind: "deposit_received", fundsSourceId: demoIds.depositA, sourceRefs: [demoIds.depositA] }));
    const result = threeWayCheck(state, NOW);
    expect(result.causes).toContainEqual(expect.objectContaining({ code: "DUPLICATE_POSTING", sourceIds: [demoIds.depositA, "import:demo:bank:txn:A-001", "dup"] }));
  });

  it("flags uncleared deposits that were allocated, and entries for unknown owners or other currencies", () => {
    const state = demoState();
    state.entries.push(
      entry({ entryId: "alloc:1", amountCents: -1, kind: "allocation", fundsSourceId: demoIds.depositD }),
      entry({ entryId: "alloc:2", ownerId: demoIds.delta, amountCents: 1, kind: "allocation", fundsSourceId: demoIds.depositD }),
      entry({ entryId: "ghost", ownerId: "demo:owner:ghost", amountCents: 0, kind: "adjustment" }),
      entry({ entryId: "eur", ownerId: demoIds.alpha, amountCents: 5, kind: "adjustment", currency: "EUR" }),
    );
    const result = threeWayCheck(state, NOW);
    expect(codes(result)).toEqual(expect.arrayContaining(["UNCLEARED_DEPOSIT_ALLOCATED", "UNKNOWN_OWNER_ENTRY", "CURRENCY_MISMATCH"]));
    expect(result.causes.find(c => c.code === "UNCLEARED_DEPOSIT_ALLOCATED")?.severity).toBe("warning");
  });

  it("treats a reversed bank entry pair as cancelled, without deleting history", () => {
    const state = demoState();
    const wrong = entry({ entryId: "wrong", ownerId: demoIds.alpha, amountCents: -500, kind: "fee", bankReference: "FEE-404" });
    state.entries.push(wrong, ...buildReversalEntries([wrong], "posted in error", "approver", NOW - 1));
    const result = threeWayCheck(state, NOW);
    expect(result.status).toBe("matched");
    expect(state.entries.map(e => e.entryId)).toEqual(expect.arrayContaining(["wrong", "wrong:reversal"]));
  });
});

describe("owner balances", () => {
  it("separates posted from available using bank clearing status and holds", () => {
    const state = demoState({ holds: [{ proposalId: "hold-1", ownerId: demoIds.alpha, amountCents: 1_000_000 }] });
    const rows = ownerBalances(state, NOW);
    expect(rows.find(r => r.ownerId === demoIds.delta)).toMatchObject({ postedCents: 300_000, clearedCents: 50_000, unclearedCents: 250_000, availableCents: 50_000 });
    expect(rows.find(r => r.ownerId === demoIds.alpha)).toMatchObject({ postedCents: 25_000_000, holdsCents: 1_000_000, availableCents: 24_000_000 });
    expect(ownerBalances(state, NOW, "hold-1").find(r => r.ownerId === demoIds.alpha)?.availableCents).toBe(25_000_000);
    expect(rows.at(-1)).toMatchObject({ ownerId: null, postedCents: 248_000 });
    state.bankTransactions = state.bankTransactions.map(t => t.sourceId === demoIds.depositD ? { ...t, clearing: "cleared" } : t);
    expect(ownerBalances(state, NOW).find(r => r.ownerId === demoIds.delta)?.availableCents).toBe(300_000);
  });
});
