import type { FinanceRecordSet, FinanceTask, InvestigationScope } from "@mangekyo/contracts";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export function recordOnly<T extends { _id: unknown; _creationTime: number }>(row: T): T extends unknown ? Omit<T, "_id" | "_creationTime"> : never {
  const { _id, _creationTime, ...record } = row;
  return record as T extends unknown ? Omit<T, "_id" | "_creationTime"> : never;
}

export async function requireTask(ctx: QueryCtx | MutationCtx, taskId: string) {
  const task = await ctx.db.query("financeTasks").withIndex("by_taskId", (q) => q.eq("taskId", taskId)).unique();
  if (!task || !task.synthetic) throw new Error("Unknown synthetic development task");
  return task;
}

export function validateScope(scope: InvestigationScope) {
  if (scope.accountId !== "synthetic-bank-account-001" || scope.currency !== "USD") {
    throw new Error("Only synthetic-bank-account-001 in USD is available from this source adapter");
  }
  if (!Number.isSafeInteger(scope.cutoff) || scope.cutoff < 0 ||
      (scope.from !== null && (!Number.isSafeInteger(scope.from) || scope.from < 0 || scope.from > scope.cutoff))) {
    throw new Error("Scope requires integer millisecond dates with from <= cutoff");
  }
}

/** Bounded projection of the existing source records. No ERP records are manufactured. */
export async function readRecords(ctx: QueryCtx | MutationCtx, task: FinanceTask, scope: InvestigationScope): Promise<FinanceRecordSet> {
  validateScope(scope);
  const [transactions, owners, documents] = await Promise.all([
    ctx.db.query("financeTransactions").withIndex("by_caseId", (q) => q.eq("caseId", task.caseId)).take(101),
    ctx.db.query("financeOwners").withIndex("by_caseId", (q) => q.eq("caseId", task.caseId)).take(101),
    ctx.db.query("financeDocuments").withIndex("by_caseId", (q) => q.eq("caseId", task.caseId)).take(101),
  ]);
  if ([transactions, owners, documents].some((rows) => rows.length > 100)) {
    throw new Error("Source context exceeds the 100-record development limit; narrow the source adapter before investigating");
  }
  const missingEvidence = [
    "No payer identity or agreement verifies the candidate owner's deposit ownership.",
    "No bank closing balance, book/control balance, or complete owner ledger balances are available.",
    "Invoices and agreements are unavailable in the current source schema.",
    "Historical records for the complete account and allocation history are unavailable; only this synthetic case is reviewed.",
    "Legacy document versions use legacy-v1; effective dates were not recorded, so document availability at the cutoff is unverified.",
  ];
  return {
    transactions: transactions.filter((row) => row.currency === scope.currency && row.clearedAt <= scope.cutoff &&
      (scope.from === null || row.clearedAt >= scope.from) &&
      (scope.kind === "historical_onboarding" || row.transactionId === task.transactionId))
      .map((row) => ({ ...recordOnly(row), accountId: scope.accountId })),
    owners: owners.map(recordOnly),
    documents: documents.map((row) => ({ ...recordOnly(row), version: "legacy-v1", effectiveAt: null })),
    invoices: [], agreements: [], bankBalance: null, controlBalance: null, ownerBalances: null,
    ownerBalancesComplete: false, timingDifferences: [], existingAllocations: [], allocationHistoryComplete: false,
    missingEvidence, coverage: "available_records_only",
  };
}
