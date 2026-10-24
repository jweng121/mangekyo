import type { MonthlyReconciliationReport } from "@mangekyo/contracts/orchestration";
import { formatCents } from "../intake/cents";
import { ownerBalances, threeWayCheck, type AccountLedgerState, type ThreeWayOptions } from "../ledger";

/** YYYY-MM must be a real month. Returns the UTC period end (last millisecond of the month). */
export function monthEnd(month: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error("Month must be YYYY-MM.");
  const year = Number(match[1]); const m = Number(match[2]);
  if (m < 1 || m > 12) throw new Error("Month must be YYYY-MM.");
  return Date.UTC(year, m, 1) - 1;
}

/**
 * The monthly reconciliation: bank, books, each client ledger and the reconciling items at the month's end, computed by code.
 * It is a report a person signs off; signing records it immutably. Nothing here changes money.
 */
export function monthlyReconciliation(state: AccountLedgerState, month: string, options: ThreeWayOptions = {}): Omit<MonthlyReconciliationReport, "reportId" | "signedOff"> {
  const periodEnd = monthEnd(month);
  const threeWay = threeWayCheck(state, periodEnd, { ...options, now: options.now ?? periodEnd });
  const firm = new Set(state.owners.filter(o => o.ownerKind === "firm").map(o => o.ownerId));
  const ledgers = ownerBalances(state, periodEnd).map(b => ({ ownerId: b.ownerId, name: b.name, postedCents: b.postedCents, clearedCents: b.clearedCents, ownerKind: b.ownerId === null ? "unallocated" as const : firm.has(b.ownerId) ? "firm" as const : "client" as const }));
  const items = [
    ...(threeWay.outstanding ?? []).map(o => ({ kind: o.kind, entryId: o.entryId, sourceIds: o.sourceIds, amountCents: o.amountCents, description: `${o.kind === "outstanding_payment" ? "Outstanding payment" : "Deposit in transit"} ${formatCents(o.amountCents, state.account.currency)}${o.bankReference ? ` (${o.bankReference})` : ""}, ${o.ageDays} day(s)` })),
    ...state.reconcilingItems.filter(r => r.appliesTo === "bank").map(r => ({ kind: "reconciling_item", entryId: null, sourceIds: [r.sourceId], amountCents: r.amountCents, description: r.description })),
    ...state.bankTransactions.filter(t => t.clearing === "pending" && t.bookedAt <= periodEnd).map(t => ({ kind: "pending_deposit", entryId: null, sourceIds: [t.sourceId], amountCents: t.direction === "inflow" ? t.amountCents : -t.amountCents, description: `Pending ${t.direction} ${formatCents(t.amountCents, t.currency)} from ${t.counterparty} (${t.reference})` })),
  ];
  return {
    accountId: state.account.accountId, month, periodEnd,
    bank: { statementCents: threeWay.bank.statementCents, adjustedCents: threeWay.bank.adjustedCents, clearedCents: threeWay.bank.clearedCents, pendingCents: threeWay.bank.pendingCents },
    bookCents: threeWay.bookCents, clientLedgers: ledgers, reconcilingItems: items,
    threeWay: { status: threeWay.status, bankMinusBook: threeWay.differences.bankMinusBook, bookMinusOwners: threeWay.differences.bookMinusOwners, causes: threeWay.causes },
  };
}
