import { defineSchema, defineTable } from "convex/server";
import * as fields from "./lib/validators";
import * as money from "./lib/moneyValidators";

export default defineSchema({
  financeCases: defineTable(fields.financeCase).index("by_caseId", ["caseId"]),
  financeOwners: defineTable(fields.owner).index("by_caseId", ["caseId"]),
  financeTransactions: defineTable(fields.transaction).index("by_caseId", ["caseId"]),
  financeDocuments: defineTable(fields.document).index("by_caseId", ["caseId"]),
  financeTasks: defineTable(fields.task).index("by_taskId", ["taskId"]).index("by_accountId", ["accountId"]),
  financeEvents: defineTable(fields.event).index("by_taskId_and_sequence", ["taskId", "sequence"]).index("by_caseId_and_timestamp", ["caseId", "timestamp"]),
  financeSnapshots: defineTable(fields.snapshot).index("by_taskId_and_sequence", ["taskId", "sequence"]),
  financeInvestigationRuns: defineTable(fields.storedRun)
    .index("by_runId", ["runId"]).index("by_taskId_and_attempt", ["taskId", "attempt"]),
  financeInvestigationQuestions: defineTable(fields.question)
    .index("by_questionId", ["questionId"]).index("by_taskId", ["taskId"]),
  financeClarifications: defineTable(fields.clarification)
    .index("by_taskId_and_timestamp", ["taskId", "timestamp"]),
  financeApprovedPolicies: defineTable(fields.policy)
    .index("by_accountId_and_currency_and_approvedAt", ["accountId", "currency", "approvedAt"]),
  financeAccounts: defineTable(money.storedAccount).index("by_accountId", ["accountId"]),
  financeBankTransactions: defineTable(money.bankTransaction).index("by_accountId", ["accountId"]).index("by_sourceId", ["sourceId"]),
  financeAccountOwners: defineTable(money.owner).index("by_accountId", ["accountId"]).index("by_sourceId", ["sourceId"]),
  financeObligations: defineTable(money.obligation).index("by_accountId", ["accountId"]).index("by_sourceId", ["sourceId"]),
  financeSourceDocuments: defineTable(money.sourceDocument).index("by_accountId", ["accountId"]).index("by_sourceId", ["sourceId"]),
  financeBankStatements: defineTable(money.statementBalance).index("by_accountId", ["accountId"]).index("by_sourceId", ["sourceId"]),
  financeReconcilingItems: defineTable(money.reconcilingItem).index("by_accountId", ["accountId"]).index("by_sourceId", ["sourceId"]),
  // Append-only: rows are inserted, never patched or deleted. Corrections are reversal entries.
  financeLedgerEntries: defineTable(money.ledgerEntry).index("by_accountId_and_effectiveAt", ["accountId", "effectiveAt"]).index("by_entryId", ["entryId"]),
  financeProposals: defineTable(money.proposal).index("by_proposalId", ["proposalId"]).index("by_accountId", ["accountId"]),
  financeProposalTransitions: defineTable(money.transition).index("by_proposalId", ["proposalId"]),
});
