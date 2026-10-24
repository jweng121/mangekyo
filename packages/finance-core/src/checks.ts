import type { DeterministicChecks, FinanceRecordSet, FinancialCheck, InvestigationScope, ProposedAllocation, ReconciliationResult } from "@mangekyo/contracts";

export function isIntegerCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function safeSum(values: number[]): number | null {
  let total = 0;
  for (const value of values) {
    if (!isIntegerCents(value) || !Number.isSafeInteger(total + value)) return null;
    total += value;
  }
  return total;
}

export function validateAllocationProposals(
  proposals: ProposedAllocation[], records: FinanceRecordSet, scope: InvestigationScope,
): FinancialCheck {
  if (proposals.length === 0) return { status: "not_applicable", issues: [] };
  const issues: string[] = [];
  const ids = new Set<string>();
  const pairs = new Set<string>();
  const totals = new Map<string, number[]>();
  for (const proposal of proposals) {
    const transaction = records.transactions.find(row => row.transactionId === proposal.transactionId);
    if (!isIntegerCents(proposal.amountCents) || proposal.amountCents <= 0) issues.push(`Invalid integer cents: ${proposal.proposalId}`);
    if (!transaction) issues.push(`Unknown transaction: ${proposal.transactionId}`);
    if (!records.owners.some(row => row.ownerId === proposal.ownerId)) issues.push(`Unknown owner: ${proposal.ownerId}`);
    if (proposal.currency !== scope.currency || (transaction && proposal.currency !== transaction.currency)) issues.push(`Currency mismatch: ${proposal.proposalId}`);
    if (transaction && (transaction.accountId !== scope.accountId || transaction.clearedAt > scope.cutoff || (scope.from !== null && transaction.clearedAt < scope.from))) issues.push(`Transaction outside scope: ${proposal.transactionId}`);
    if (transaction && transaction.bankStatus !== "cleared") issues.push(`Transaction is not cleared: ${proposal.transactionId}`);
    const pair = JSON.stringify([proposal.transactionId, proposal.ownerId]);
    if (ids.has(proposal.proposalId) || pairs.has(pair)) issues.push(`Duplicate proposed allocation: ${proposal.proposalId}`);
    ids.add(proposal.proposalId); pairs.add(pair);
    if (records.existingAllocations.some(row => row.proposalId === proposal.proposalId || (row.transactionId === proposal.transactionId && row.amountCents > 0))) issues.push(`This deposit already has a recorded allocation; a second full allocation is unsupported: ${proposal.proposalId}`);
    if (records.existingAllocations.some(row => row.transactionId === proposal.transactionId && (!isIntegerCents(row.amountCents) || row.amountCents <= 0))) issues.push(`Existing allocation history contains invalid cents: ${proposal.transactionId}`);
    const values = totals.get(proposal.transactionId) ?? [];
    values.push(proposal.amountCents); totals.set(proposal.transactionId, values);
  }
  for (const [transactionId, values] of totals) {
    const transaction = records.transactions.find(row => row.transactionId === transactionId);
    const total = safeSum(values);
    if (total === null || (transaction && total !== transaction.amountCents)) issues.push(`Allocation total does not equal the deposit: ${transactionId}`);
  }
  if (issues.length) return { status: "failed", issues };
  if (!records.allocationHistoryComplete) return { status: "insufficient_data", issues: ["Complete allocation history is unavailable; duplicate ownership entries cannot be ruled out."] };
  return { status: "passed", issues: [] };
}

export function reconcileBalances(records: FinanceRecordSet, scope: InvestigationScope): ReconciliationResult {
  const result: ReconciliationResult = {
    status: "insufficient_data", reasons: [], adjustedBankCents: null, adjustedControlCents: null,
    adjustedOwnerCents: null, timingDifferences: records.timingDifferences, ownerAllocationsVerified: false,
  };
  if (!records.bankBalance) result.reasons.push("Bank closing balance is unavailable.");
  if (!records.controlBalance) result.reasons.push("Corresponding book/control balance is unavailable.");
  if (records.ownerBalances === null || !records.ownerBalancesComplete) result.reasons.push("Complete corresponding owner ledger balances are unavailable.");
  const balances = [records.bankBalance, records.controlBalance, ...(records.ownerBalances ?? [])].filter(row => row !== null);
  for (const row of balances) {
    if (!isIntegerCents(row.amountCents)) result.reasons.push(`Invalid balance cents: ${row.balanceId}`);
    if (row.accountId !== scope.accountId || row.currency !== scope.currency || row.cutoff !== scope.cutoff) result.reasons.push(`Incompatible account/currency/cutoff: ${row.balanceId}`);
  }
  const ownerIds = new Set<string>();
  for (const row of records.ownerBalances ?? []) {
    if (!records.owners.some(owner => owner.ownerId === row.ownerId) || ownerIds.has(row.ownerId)) result.reasons.push(`Unknown or duplicated owner balance: ${row.ownerId}`);
    ownerIds.add(row.ownerId);
  }
  for (const difference of records.timingDifferences) {
    if (!difference.documented || !difference.sourceId || !difference.description.trim() || !isIntegerCents(difference.amountCents) || difference.accountId !== scope.accountId || difference.currency !== scope.currency || difference.cutoff !== scope.cutoff) result.reasons.push(`Undocumented or incompatible timing difference: ${difference.differenceId}`);
  }
  if (result.reasons.length || !records.bankBalance || !records.controlBalance || !records.ownerBalances) return result;
  const adjustments = (kind: "bank" | "control" | "owners") => records.timingDifferences.filter(row => row.appliesTo === kind).map(row => row.amountCents);
  result.adjustedBankCents = safeSum([records.bankBalance.amountCents, ...adjustments("bank")]);
  result.adjustedControlCents = safeSum([records.controlBalance.amountCents, ...adjustments("control")]);
  result.adjustedOwnerCents = safeSum([...records.ownerBalances.map(row => row.amountCents), ...adjustments("owners")]);
  if (result.adjustedBankCents === null || result.adjustedControlCents === null || result.adjustedOwnerCents === null) {
    result.reasons.push("Reconciliation exceeds the safe integer-cent range."); return result;
  }
  result.status = result.adjustedBankCents === result.adjustedControlCents && result.adjustedBankCents === result.adjustedOwnerCents ? "balanced_totals" : "unbalanced";
  if (result.status === "balanced_totals") result.reasons.push("Totals match; correct owner-level attribution still requires supporting evidence.");
  else result.reasons.push("Adjusted bank, control, and owner totals differ.");
  return result;
}

export function runDeterministicChecks(records: FinanceRecordSet, scope: InvestigationScope, proposals: ProposedAllocation[] = []): DeterministicChecks {
  const issues: string[] = [];
  if (!Number.isSafeInteger(scope.cutoff) || scope.cutoff < 0 || (scope.from !== null && (!Number.isSafeInteger(scope.from) || scope.from < 0 || scope.from > scope.cutoff))) issues.push("Invalid explicit review period.");
  for (const transaction of records.transactions) {
    if (!isIntegerCents(transaction.amountCents) || transaction.amountCents <= 0) issues.push(`Invalid deposit cents: ${transaction.transactionId}`);
    if (transaction.currency !== scope.currency || transaction.accountId !== scope.accountId) issues.push(`Transaction account/currency mismatch: ${transaction.transactionId}`);
    if (transaction.clearedAt > scope.cutoff || (scope.from !== null && transaction.clearedAt < scope.from)) issues.push(`Transaction outside review period: ${transaction.transactionId}`);
  }
  return {
    amounts: { status: issues.length ? "failed" : records.transactions.length ? "passed" : "insufficient_data", issues: issues.length ? issues : records.transactions.length ? [] : ["No transactions available in the specified period."] },
    proposedAllocations: validateAllocationProposals(proposals, records, scope),
    reconciliation: reconcileBalances(records, scope),
  };
}
