import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const record = defineTable({ tenantId: v.string(), itemId: v.string(), runId: v.string(), payload: v.any() })
  .index("by_tenant", ["tenantId"])
  .index("by_tenant_item", ["tenantId", "itemId"])
  .index("by_tenant_run", ["tenantId", "runId"]);

import * as fields from "./lib/validators";
import * as money from "./lib/moneyValidators";
import * as orchestrator from "./lib/orchestratorValidators";

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
    .index("by_taskId_and_timestamp", ["taskId", "timestamp"])
    // Memory: every person's answer on the account is visible to the next run on any of its deposits.
    .index("by_accountId_and_timestamp", ["accountId", "timestamp"]),
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
  financeOrchestrations: defineTable(orchestrator.orchestration).index("by_orchestrationId", ["orchestrationId"]).index("by_taskId", ["taskId"]).index("by_accountId", ["accountId"]),
  // Append-only, like financeEvents/financeSnapshots: one event and one snapshot per orchestrator step.
  financeOrchestratorEvents: defineTable(orchestrator.event).index("by_orchestrationId_and_sequence", ["orchestrationId", "sequence"]),
  financeOrchestratorSnapshots: defineTable(orchestrator.snapshot).index("by_orchestrationId_and_sequence", ["orchestrationId", "sequence"]),
  financeRealRuns: defineTable(orchestrator.realRun).index("by_day", ["day"]).index("by_taskId", ["taskId"]),
  financeReconciliationRuns: defineTable(orchestrator.reconciliationRun).index("by_runId", ["runId"]).index("by_orchestrationId", ["orchestrationId"]),
  financeCorrections: defineTable(orchestrator.correction).index("by_correctionId", ["correctionId"]).index("by_accountId", ["accountId"]),
  financePolicyBacktests: defineTable(orchestrator.policyBacktest).index("by_accountId", ["accountId"]),
  financeScorecards: defineTable(orchestrator.scorecard).index("by_accountId", ["accountId"]),
  // Trust rules and the five agents. Every table below is append-only or changes status fields only; money moves only through the ledger.
  financeDisputes: defineTable(money.dispute).index("by_disputeId", ["disputeId"]).index("by_accountId", ["accountId"]),
  // One immutable snapshot per step of every agent run (visual audit). Never patched.
  financeStepSnapshots: defineTable(orchestrator.stepSnapshot).index("by_snapshotId", ["snapshotId"]).index("by_runId_and_stepIndex", ["runId", "stepIndex"]),
  // A person's correction of a run: creates a new linked attempt; the corrected run never changes.
  financeRunCorrections: defineTable(orchestrator.runCorrection).index("by_correctionId", ["correctionId"]).index("by_runId", ["runId"]).index("by_taskId", ["taskId"]).index("by_newRunId", ["newRunId"]),
  financeEvalCases: defineTable(orchestrator.evalCase).index("by_evalCaseId", ["evalCaseId"]).index("by_agent_and_instructionVersion", ["agent", "instructionVersion"]),
  financeEvalRuns: defineTable(orchestrator.evalRun).index("by_evalRunId", ["evalRunId"]).index("by_agent", ["agent"]),
  financeDisbursementRuns: defineTable(orchestrator.disbursementRun).index("by_runId", ["runId"]).index("by_taskId_and_attempt", ["taskId", "attempt"]).index("by_accountId", ["accountId"]),
  financeAuditRuns: defineTable(orchestrator.auditRun).index("by_runId", ["runId"]).index("by_accountId", ["accountId"]),
  financeAuditReports: defineTable(orchestrator.auditReport).index("by_reportId", ["reportId"]).index("by_accountId", ["accountId"]),
  // A signed monthly reconciliation is the report exactly as the person saw it; one row per sign-off, never edited.
  financeMonthlyReconciliations: defineTable(orchestrator.monthlyReport).index("by_accountId_and_month", ["accountId", "month"]),

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
