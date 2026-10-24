import { defineSchema, defineTable } from "convex/server";
import * as fields from "./lib/validators";

export default defineSchema({
  financeCases: defineTable(fields.financeCase).index("by_caseId", ["caseId"]),
  financeOwners: defineTable(fields.owner).index("by_caseId", ["caseId"]),
  financeTransactions: defineTable(fields.transaction).index("by_caseId", ["caseId"]),
  financeDocuments: defineTable(fields.document).index("by_caseId", ["caseId"]),
  financeTasks: defineTable(fields.task).index("by_taskId", ["taskId"]),
  financeEvents: defineTable(fields.event).index("by_taskId_and_sequence", ["taskId", "sequence"]),
  financeSnapshots: defineTable(fields.snapshot).index("by_taskId_and_sequence", ["taskId", "sequence"]),
  financeInvestigationRuns: defineTable(fields.storedRun)
    .index("by_runId", ["runId"]).index("by_taskId_and_attempt", ["taskId", "attempt"]),
  financeInvestigationQuestions: defineTable(fields.question)
    .index("by_questionId", ["questionId"]).index("by_taskId", ["taskId"]),
  financeClarifications: defineTable(fields.clarification)
    .index("by_taskId_and_timestamp", ["taskId", "timestamp"]),
  financeApprovedPolicies: defineTable(fields.policy)
    .index("by_accountId_and_currency_and_approvedAt", ["accountId", "currency", "approvedAt"]),
});
