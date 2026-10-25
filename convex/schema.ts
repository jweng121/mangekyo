import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const record = defineTable({ tenantId: v.string(), itemId: v.string(), runId: v.string(), payload: v.any() })
  .index("by_tenant", ["tenantId"])
  .index("by_tenant_item", ["tenantId", "itemId"])
  .index("by_tenant_run", ["tenantId", "runId"]);

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

  runs: record,
  events: record,
  snapshots: record,
  auditFindings: record,
  escalations: record,
  steeringRequests: record,
  executionBranches: record,
  chatMessages: record,
  investigationReports: record,
  memoryRecords: record,
  screenshotArtifacts: defineTable({ tenantId: v.string(), artifactId: v.string(), storageId: v.id("_storage") }).index("by_tenant_artifact", ["tenantId", "artifactId"]),
});
