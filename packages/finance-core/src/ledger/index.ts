import type {
  BankStatementBalance, LedgerEntry, MoneyAccount, NormalizedAccountBundle, NormalizedBankTransaction,
  NormalizedOwner, OwnerBalance, ReconcilingItem, ThreeWayCause, ThreeWayCheckResult,
} from "@mangekyo/contracts";
import { formatCents } from "../intake/cents";

export interface AccountLedgerState {
  account: MoneyAccount;
  owners: NormalizedOwner[];
  bankTransactions: NormalizedBankTransaction[];
  statementBalances: BankStatementBalance[];
  reconcilingItems: ReconcilingItem[];
  entries: LedgerEntry[];
  /** Outflows requested or approved but not yet posted; they reserve owner funds. */
  holds: Array<{ proposalId: string; ownerId: string; amountCents: number }>;
}

const BANK_KINDS = new Set<LedgerEntry["kind"]>(["deposit_received", "disbursement", "fee"]);

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value)) throw new RangeError("Ledger arithmetic exceeds the safe integer-cent range");
    total += value;
  }
  return total;
}

/** Ledger entries created by an import: opening balances at cutover plus post-cutover inflows into unallocated. */
export function importLedgerEntries(bundle: NormalizedAccountBundle, importedAt: number, createdBy: string): LedgerEntry[] {
  const { account } = bundle;
  const base = { accountId: account.accountId, currency: account.currency, status: "posted" as const, createdAt: importedAt, createdBy };
  const entries: LedgerEntry[] = bundle.openingBalances.map(row => row.ownerId === null ? {
    ...base, entryId: `import:${row.sourceId}`, ownerId: null, amountCents: row.amountCents, kind: "deposit_received",
    sourceRefs: [row.sourceId], fundsSourceId: row.bankSourceId ?? undefined, memo: "Unallocated deposit carried into cutover", effectiveAt: row.asOf,
  } : {
    ...base, entryId: `import:${row.sourceId}`, ownerId: row.ownerId, amountCents: row.amountCents, kind: "adjustment",
    sourceRefs: [row.sourceId],
    ...(row.bankSourceId ? { fundsSourceId: row.bankSourceId } : { clearedCents: row.clearedCents }),
    memo: "Opening owner balance at cutover", effectiveAt: row.asOf,
  });
  const recorded = new Set(entries.flatMap(row => row.fundsSourceId ? [row.fundsSourceId] : []));
  for (const txn of bundle.bankTransactions) {
    if (txn.direction !== "inflow" || txn.bookedAt <= account.openingAsOf || recorded.has(txn.sourceId)) continue;
    entries.push({
      ...base, entryId: `import:${txn.sourceId}`, ownerId: null, amountCents: txn.amountCents, kind: "deposit_received",
      sourceRefs: [txn.sourceId], fundsSourceId: txn.sourceId, memo: "Deposit received from bank feed; unallocated", effectiveAt: txn.bookedAt,
    });
  }
  return entries;
}

function clearedPortion(entry: LedgerEntry, bank: Map<string, NormalizedBankTransaction>, cutoff: number): number {
  if (entry.fundsSourceId) {
    const txn = bank.get(entry.fundsSourceId);
    return txn && txn.clearing === "cleared" && txn.bookedAt <= cutoff ? entry.amountCents : 0;
  }
  if (entry.clearedCents !== undefined) return entry.clearedCents;
  return entry.amountCents;
}

/** Posted and available balance per owner, plus the unallocated bucket (ownerId null) last. */
export function ownerBalances(state: AccountLedgerState, cutoff: number, excludeHoldFor?: string): OwnerBalance[] {
  const bank = new Map(state.bankTransactions.map(row => [row.sourceId, row]));
  const entries = state.entries.filter(row => row.effectiveAt <= cutoff && row.currency === state.account.currency);
  const rows: Array<{ ownerId: string | null; name: string }> = [...state.owners.map(o => ({ ownerId: o.ownerId, name: o.name })), { ownerId: null, name: "Unallocated" }];
  return rows.map(({ ownerId, name }) => {
    const mine = entries.filter(row => row.ownerId === ownerId);
    const postedCents = sum(mine.map(row => row.amountCents));
    const clearedCents = sum(mine.map(row => clearedPortion(row, bank, cutoff)));
    const holdsCents = ownerId === null ? 0 : sum(state.holds.filter(h => h.ownerId === ownerId && h.proposalId !== excludeHoldFor).map(h => h.amountCents));
    return { ownerId, name, postedCents, clearedCents, unclearedCents: postedCents - clearedCents, holdsCents, availableCents: clearedCents - holdsCents };
  });
}

function bankLinked(entry: LedgerEntry, txn: NormalizedBankTransaction): boolean {
  return entry.sourceRefs.includes(txn.sourceId) || entry.fundsSourceId === txn.sourceId || (!!entry.bankReference && entry.bankReference === txn.reference);
}

/** Bank = books = owners for one account at a cutoff. Code computes every number; nothing is repaired. */
export function threeWayCheck(state: AccountLedgerState, cutoff: number): ThreeWayCheckResult {
  const { account } = state;
  const causes: ThreeWayCause[] = [];
  const ownerIdBySource = new Map(state.owners.map(o => [o.sourceId, o.ownerId]));
  const knownOwners = new Set(state.owners.map(o => o.ownerId));
  const statement = state.statementBalances.filter(row => row.asOf <= cutoff).sort((a, b) => b.asOf - a.asOf)[0] ?? null;
  const feed = state.bankTransactions.filter(row => row.bookedAt <= cutoff);
  const signed = (txn: NormalizedBankTransaction) => txn.direction === "inflow" ? txn.amountCents : -txn.amountCents;

  const inCurrency = state.entries.filter(row => row.effectiveAt <= cutoff);
  for (const entry of inCurrency.filter(row => row.currency !== account.currency)) {
    causes.push({ code: "CURRENCY_MISMATCH", severity: "mismatch", message: `Entry ${entry.entryId} is in ${entry.currency}, not ${account.currency}; excluded from totals.`, amountCents: entry.amountCents, sourceIds: [entry.entryId, ...entry.sourceRefs], ownerIds: entry.ownerId ? [entry.ownerId] : [], unattributed: entry.ownerId === null });
  }
  const entries = inCurrency.filter(row => row.currency === account.currency);
  const bookCents = sum(entries.map(row => row.amountCents));
  for (const entry of entries.filter(row => row.ownerId !== null && !knownOwners.has(row.ownerId))) {
    causes.push({ code: "UNKNOWN_OWNER_ENTRY", severity: "mismatch", message: `Entry ${entry.entryId} names unknown owner ${entry.ownerId}.`, amountCents: entry.amountCents, sourceIds: [entry.entryId, ...entry.sourceRefs], ownerIds: [], unattributed: true });
  }
  const balances = ownerBalances({ ...state, holds: [] }, cutoff);
  const unallocatedCents = balances.find(row => row.ownerId === null)!.postedCents;
  const ownersTotalCents = sum(balances.map(row => row.postedCents));

  const reversed = new Set(entries.flatMap(row => row.reversesEntryId ? [row.reversesEntryId] : []));
  const bankEntries = entries.filter(row => BANK_KINDS.has(row.kind) && !reversed.has(row.entryId));
  const anchor = statement?.asOf ?? account.openingAsOf;
  for (const txn of feed) {
    const linked = bankEntries.filter(entry => bankLinked(entry, txn));
    const ownerHint = txn.ownerHintSourceId ? ownerIdBySource.get(txn.ownerHintSourceId) ?? null : null;
    const owners = [...new Set([...linked.flatMap(e => e.ownerId ? [e.ownerId] : []), ...(ownerHint ? [ownerHint] : [])])];
    if (linked.length > 1) {
      causes.push({ code: "DUPLICATE_POSTING", severity: "mismatch", message: `Bank transaction ${txn.sourceId} is recorded ${linked.length} times in the ledger.`, amountCents: txn.amountCents, sourceIds: [txn.sourceId, ...linked.map(e => e.entryId)], ownerIds: owners, unattributed: owners.length === 0 });
    } else if (linked.length === 1 && Math.abs(linked[0].amountCents) !== txn.amountCents) {
      causes.push({ code: "AMOUNT_MISMATCH", severity: "mismatch", message: `Bank ${formatCents(txn.amountCents)} vs ledger ${formatCents(Math.abs(linked[0].amountCents))} for ${txn.sourceId}.`, amountCents: txn.amountCents - Math.abs(linked[0].amountCents), sourceIds: [txn.sourceId, linked[0].entryId], ownerIds: owners, unattributed: owners.length === 0 });
    } else if (linked.length === 0 && txn.bookedAt > anchor) {
      causes.push({ code: "BANK_TXN_WITHOUT_LEDGER_ENTRY", severity: "mismatch", message: `Bank ${txn.direction} ${formatCents(txn.amountCents)} (${txn.reference}) has no ledger entry.`, amountCents: signed(txn), sourceIds: [txn.sourceId], ownerIds: owners, unattributed: owners.length === 0 });
    }
    if (txn.duplicateOfSourceId && linked.length > 0) {
      const original = feed.find(row => row.sourceId === txn.duplicateOfSourceId);
      if (original && bankEntries.some(entry => bankLinked(entry, original))) {
        causes.push({ code: "DUPLICATE_POSTING", severity: "mismatch", message: `${txn.sourceId} is flagged as a duplicate of ${original.sourceId}, and both are recorded.`, amountCents: txn.amountCents, sourceIds: [txn.sourceId, original.sourceId], ownerIds: owners, unattributed: owners.length === 0 });
      }
    }
  }
  for (const entry of bankEntries) {
    if (feed.some(txn => bankLinked(entry, txn))) continue;
    const explicit = entry.sourceRefs.some(ref => state.bankTransactions.some(txn => txn.sourceId === ref)) || !!entry.bankReference;
    if (entry.effectiveAt > anchor || explicit) {
      causes.push({ code: "LEDGER_ENTRY_WITHOUT_BANK_TXN", severity: "mismatch", message: `Ledger ${entry.kind} ${formatCents(entry.amountCents)} (${entry.entryId}) has no matching bank transaction${entry.bankReference ? ` with reference ${entry.bankReference}` : ""}.`, amountCents: entry.amountCents, sourceIds: [entry.entryId, ...entry.sourceRefs], ownerIds: entry.ownerId ? [entry.ownerId] : [], unattributed: entry.ownerId === null });
    }
  }
  const bankById = new Map(state.bankTransactions.map(row => [row.sourceId, row]));
  for (const entry of entries.filter(row => row.kind === "allocation" && row.ownerId !== null && row.amountCents > 0 && row.fundsSourceId)) {
    const txn = bankById.get(entry.fundsSourceId!);
    if (txn && txn.clearing === "pending") causes.push({ code: "UNCLEARED_DEPOSIT_ALLOCATED", severity: "warning", message: `${formatCents(entry.amountCents)} from pending deposit ${txn.sourceId} is allocated to ${entry.ownerId}; it is not available until cleared.`, amountCents: entry.amountCents, sourceIds: [txn.sourceId, entry.entryId], ownerIds: [entry.ownerId!], unattributed: false });
  }

  const reconciling = statement ? state.reconcilingItems.filter(row => row.appliesTo === "bank") : [];
  for (const item of reconciling.filter(row => !row.detailed)) {
    causes.push({ code: "RECONCILING_ITEM_WITHOUT_DETAIL", severity: "warning", message: `${item.description} (${formatCents(item.amountCents)}).`, amountCents: item.amountCents, sourceIds: [item.sourceId], ownerIds: [], unattributed: false });
  }
  const postAnchorCents = sum(feed.filter(row => row.bookedAt > anchor).map(signed));
  const reconcilingCents = sum(reconciling.map(row => row.amountCents));
  const pendingCents = sum(feed.filter(row => row.clearing === "pending").map(signed));
  const adjustedCents = statement ? sum([statement.amountCents, postAnchorCents, reconcilingCents]) : null;
  if (!statement) causes.push({ code: "NO_OPENING_BALANCE", severity: "mismatch", message: "No bank statement balance at or before the cutoff; the bank figure cannot be computed.", amountCents: null, sourceIds: [], ownerIds: [], unattributed: true });

  const bankMinusBook = adjustedCents === null ? null : adjustedCents - bookCents;
  const bookMinusOwners = bookCents - ownersTotalCents;
  const hasMismatchCause = causes.some(row => row.severity === "mismatch");
  if (bankMinusBook !== null && bankMinusBook !== 0 && !hasMismatchCause) {
    causes.push({ code: "AMOUNT_MISMATCH", severity: "mismatch", message: `Bank and books differ by ${formatCents(bankMinusBook)}; no specific cause was found by code.`, amountCents: bankMinusBook, sourceIds: statement ? [statement.sourceId] : [], ownerIds: [], unattributed: true });
  }
  const status = !statement ? "insufficient_data" : bankMinusBook === 0 && bookMinusOwners === 0 && !causes.some(row => row.severity === "mismatch") ? "matched" : "mismatched";
  return {
    accountId: account.accountId, currency: account.currency, cutoff, status,
    bank: { statementCents: statement?.amountCents ?? null, postAnchorCents, reconcilingCents, adjustedCents, clearedCents: adjustedCents === null ? null : adjustedCents - pendingCents, pendingCents },
    bookCents, ownersTotalCents, unallocatedCents, differences: { bankMinusBook, bookMinusOwners }, causes,
  };
}

/** Owners whose outflows a non-matched check blocks; "all" when any cause is unattributed. */
export function affectedOwners(result: ThreeWayCheckResult): "all" | Set<string> {
  if (result.status !== "matched" && result.status !== "mismatched") return "all";
  const mismatches = result.causes.filter(row => row.severity === "mismatch");
  if (result.status === "mismatched" && (mismatches.length === 0 || mismatches.some(row => row.unattributed))) return "all";
  return new Set(mismatches.flatMap(row => row.ownerIds));
}

export function buildReversalEntries(entries: LedgerEntry[], reason: string, actor: string, now: number, approvalId?: string): LedgerEntry[] {
  return entries.map(entry => ({
    ...entry, entryId: `${entry.entryId}:reversal`, amountCents: -entry.amountCents, kind: "reversal", reversesEntryId: entry.entryId,
    sourceRefs: [entry.entryId, ...entry.sourceRefs], memo: `Reversal: ${reason}`, effectiveAt: now, createdAt: now, createdBy: actor,
    ...(approvalId ? { approvalId } : {}), bankReference: undefined,
  }));
}
