import { v } from "convex/values";
import * as money from "./moneyValidators";

const synthetic = { synthetic: v.literal(true), caseId: v.string() };
export const evidenceReference = v.object({
  sourceId: v.string(), documentId: v.string(), excerpt: v.string(),
});
export const financeCase = v.object({
  ...synthetic, taskId: v.string(), runId: v.string(), createdAt: v.number(), label: v.string(),
});
export const owner = v.object({ ...synthetic, ownerId: v.string(), name: v.string() });
export const transaction = v.object({
  ...synthetic, transactionId: v.string(), sourceId: v.string(), amountCents: v.number(),
  currency: v.literal("USD"), direction: v.literal("deposit"), bankStatus: v.literal("cleared"),
  allocationStatus: v.literal("unallocated"), clearedAt: v.number(), description: v.string(),
});
export const document = v.object({
  ...synthetic, documentId: v.string(), sourceId: v.string(), title: v.string(),
  mimeType: v.literal("text/plain"), text: v.string(), excerpt: v.string(),
});
export const task = v.object({
  ...synthetic, taskId: v.string(), runId: v.string(), transactionId: v.string(),
  candidateOwnerId: v.string(), evidenceRefs: v.array(evidenceReference),
  status: v.union(v.literal("awaiting_investigation"), v.literal("investigating"), v.literal("needs_information"), v.literal("review_required"), v.literal("investigation_completed"), v.literal("investigation_failed")),
  activeRunId: v.optional(v.string()), createdAt: v.number(),
  accountId: v.optional(v.string()), bankSourceId: v.optional(v.string()),
});
export const taskCreatedEvent = v.object({
  ...synthetic, eventId: v.string(), taskId: v.string(), runId: v.string(), sequence: v.number(),
  type: v.literal("finance.task.created"), timestamp: v.number(),
  actor: v.object({ type: v.literal("system"), component: v.literal("finance-dev.synthetic-seed") }),
  evidenceRefs: v.array(evidenceReference),
  payload: v.object({
    transactionId: v.string(), candidateOwnerId: v.string(), amountCents: v.number(),
    currency: v.literal("USD"), allocationStatus: v.literal("unallocated"),
  }),
});
export const initialSnapshot = v.object({
  ...synthetic, snapshotId: v.string(), eventId: v.string(), taskId: v.string(), runId: v.string(),
  sequence: v.number(), timestamp: v.number(), taskState: task,
  inputs: v.object({ transactionId: v.string(), candidateOwnerId: v.string(), evidenceRefs: v.array(evidenceReference) }),
  output: v.object({
    allocationStatus: v.literal("unallocated"), allocatedAmountCents: v.literal(0),
    approved: v.literal(false), investigationStatus: v.literal("not_started"),
  }),
});
export const caseBundle = v.object({ case: financeCase, owner, transaction, document, task });

export const mode = v.union(v.literal("mock"), v.literal("creao"));
export const scope = v.object({ kind: v.union(v.literal("historical_onboarding"), v.literal("deposit_investigation")), accountId: v.string(), currency: v.string(), from: v.union(v.number(), v.null()), cutoff: v.number() });
export const balance = v.object({ balanceId: v.string(), sourceId: v.string(), accountId: v.string(), currency: v.string(), cutoff: v.number(), amountCents: v.number() });
export const timingDifference = v.object({ differenceId: v.string(), sourceId: v.string(), accountId: v.string(), currency: v.string(), cutoff: v.number(), appliesTo: v.union(v.literal("bank"), v.literal("control"), v.literal("owners")), amountCents: v.number(), description: v.string(), documented: v.boolean() });
export const allocation = v.object({ proposalId: v.string(), transactionId: v.string(), ownerId: v.string(), amountCents: v.number(), currency: v.string(), evidenceSourceIds: v.array(v.string()) });
const supplementalRecord = v.object({ recordId: v.string(), sourceId: v.string(), version: v.string(), excerpt: v.string() });
export const records = v.object({
  transactions: v.array(transaction.extend({ accountId: v.string() })), owners: v.array(owner),
  documents: v.array(document.extend({ version: v.string(), effectiveAt: v.union(v.number(), v.null()) })),
  invoices: v.array(supplementalRecord), agreements: v.array(supplementalRecord),
  bankBalance: v.union(balance, v.null()), controlBalance: v.union(balance, v.null()),
  ownerBalances: v.union(v.array(balance.extend({ ownerId: v.string() })), v.null()), ownerBalancesComplete: v.boolean(),
  timingDifferences: v.array(timingDifference), existingAllocations: v.array(allocation), allocationHistoryComplete: v.boolean(),
  missingEvidence: v.array(v.string()), coverage: v.literal("available_records_only"),
  sourceAdapter: v.optional(v.object({ system: v.union(v.literal("erp"), v.literal("demo")), datasetVersion: v.string(), accountId: v.string() })),
  bankTransactions: v.optional(v.array(money.bankTransaction)), obligations: v.optional(v.array(money.obligation)),
  ownerLedgerBalances: v.optional(v.array(money.ownerBalance.extend({ ownerId: v.string(), sourceId: v.string(), cutoff: v.number() }))),
});
export const policy = v.object({ policyId: v.string(), version: v.string(), statement: v.string(), status: v.literal("approved"), accountId: v.string(), currency: v.string(), approvedAt: v.number(), sourceId: v.string() });
export const clarification = v.object({ clarificationId: v.string(), sourceId: v.string(), questionId: v.string(), question: v.string(), answer: v.string(), caseId: v.string(), taskId: v.string(), runId: v.string(), timestamp: v.number(), respondent: v.object({ identity: v.string(), authenticated: v.boolean() }), evidenceRefs: v.array(evidenceReference) });
export const financialCheck = v.object({ status: v.union(v.literal("passed"), v.literal("failed"), v.literal("insufficient_data"), v.literal("not_applicable")), issues: v.array(v.string()) });
export const checks = v.object({ amounts: financialCheck, proposedAllocations: financialCheck, reconciliation: v.object({ status: v.union(v.literal("insufficient_data"), v.literal("unbalanced"), v.literal("balanced_totals")), reasons: v.array(v.string()), adjustedBankCents: v.union(v.number(), v.null()), adjustedControlCents: v.union(v.number(), v.null()), adjustedOwnerCents: v.union(v.number(), v.null()), timingDifferences: v.array(timingDifference), ownerAllocationsVerified: v.literal(false) }), threeWay: v.optional(money.threeWay) });
export const input = v.object({ schemaVersion: v.literal("finance-investigation-input/v1"), instructionVersion: v.literal("finance-investigator/v1"), caseId: v.string(), taskId: v.string(), runId: v.string(), scope, contextAsOf: v.optional(v.number()), records, evidenceRefs: v.array(evidenceReference), deterministicChecks: checks, approvedPolicies: v.array(policy), humanClarifications: v.array(clarification) });
export const output = v.object({
  schemaVersion: v.literal("finance-investigation-output/v1"), outcome: v.union(v.literal("findings"), v.literal("needs_information"), v.literal("proposal_ready")), summary: v.string(),
  findings: v.array(v.object({ findingId: v.string(), summary: v.string(), sourceRefs: v.array(v.string()) })),
  questions: v.array(v.object({ key: v.string(), question: v.string(), sourceRefs: v.array(v.string()) })),
  proposedAllocations: v.array(allocation), proposedActions: v.array(v.object({ kind: v.literal("request_evidence"), description: v.string(), sourceRefs: v.array(v.string()) })),
  candidatePolicies: v.array(v.object({ policyId: v.string(), statement: v.string(), sourceRefs: v.array(v.string()), status: v.literal("proposed") })),
});
export const investigationStatus = v.union(v.literal("queued"), v.literal("retrieving_evidence"), v.literal("checking"), v.literal("provider_starting"), v.literal("provider_pending"), v.literal("validating"), v.literal("needs_information"), v.literal("review_required"), v.literal("completed"), v.literal("failed"));
export const investigationError = v.object({ code: v.string(), message: v.string(), retryable: v.boolean(), details: v.optional(v.array(v.object({ path: v.string(), reason: v.string() }))) });
export const reportSource = v.object({ field: v.union(v.literal("result.text"), v.literal("result.chatText")), format: v.union(v.literal("json"), v.literal("json_suffix")) });
export const run = v.object({ caseId: v.string(), taskId: v.string(), runId: v.string(), parentRunId: v.union(v.string(), v.null()), attempt: v.number(), mode, simulated: v.boolean(), status: investigationStatus, scope, createdAt: v.number(), updatedAt: v.number(), externalRunId: v.union(v.string(), v.null()), reportSource: v.optional(reportSource), providerAppId: v.optional(v.string()), providerInput: v.union(input, v.null()), result: v.union(output, v.null()), resultChecks: v.optional(checks), error: v.union(investigationError, v.null()) });
export const storedRun = run.extend({ executionClaimed: v.boolean(), pollCount: v.number(), deadline: v.number() });
export const question = v.object({ caseId: v.string(), taskId: v.string(), runId: v.string(), questionId: v.string(), key: v.string(), question: v.string(), sourceRefs: v.array(v.string()), status: v.union(v.literal("open"), v.literal("answered")), clarificationId: v.union(v.string(), v.null()) });
export const auditHandoff = v.object({ kind: v.literal("finance.investigation.review_requested"), taskId: v.string(), runId: v.string(), contextRunId: v.string(), resultAvailable: v.boolean(), visualAuditStatus: v.literal("not_connected") });
export const taskView = v.object({ runs: v.array(run), questions: v.array(question), clarifications: v.array(clarification), auditHandoff: v.union(auditHandoff, v.null()) });
export const investigationEventType = v.union(v.literal("finance.investigation.started"), v.literal("finance.evidence.retrieved"), v.literal("finance.checks.completed"), v.literal("finance.provider.started"), v.literal("finance.provider.result_received"), v.literal("finance.validation.failed"), v.literal("finance.investigation.failed"), v.literal("finance.question.raised"), v.literal("finance.clarification.saved"), v.literal("finance.investigation.resumed"), v.literal("finance.investigation.completed"));
export const investigationActor = v.union(v.object({ type: v.literal("system"), component: v.literal("finance-investigation") }), v.object({ type: v.literal("human"), component: v.literal("finance-dev"), identity: v.string(), authenticated: v.boolean() }));
export const investigationPayload = v.object({ mode, simulated: v.boolean(), message: v.string(), instructionVersion: v.string(), policyVersions: v.array(v.string()), contextRunId: v.optional(v.string()), parentRunId: v.optional(v.string()), externalRunId: v.optional(v.string()), reportSource: v.optional(reportSource), questionId: v.optional(v.string()), clarificationId: v.optional(v.string()), errorCode: v.optional(v.string()) });
export const investigationEvent = v.object({ ...synthetic, eventId: v.string(), taskId: v.string(), runId: v.string(), sequence: v.number(), type: investigationEventType, timestamp: v.number(), actor: investigationActor, evidenceRefs: v.array(evidenceReference), payload: investigationPayload });
export const moneyEventType = v.union(v.literal("finance.money.import_completed"), v.literal("finance.money.lock_checked"), v.literal("finance.money.proposal_transitioned"), v.literal("finance.money.ledger_posted"), v.literal("finance.money.bank_item_recorded"));
export const moneyActor = v.union(v.object({ type: v.literal("system"), component: v.literal("finance-money") }), v.object({ type: v.literal("human"), component: v.literal("finance-dev"), identity: v.string(), authenticated: v.boolean() }));
export const moneyEvent = v.object({ ...synthetic, eventId: v.string(), taskId: v.string(), runId: v.string(), sequence: v.number(), type: moneyEventType, timestamp: v.number(), actor: moneyActor, evidenceRefs: v.array(evidenceReference),
  payload: v.object({ accountId: v.string(), message: v.string(), proposalId: v.union(v.string(), v.null()), allowed: v.union(v.boolean(), v.null()), reasonCodes: v.array(v.string()), sourceIds: v.array(v.string()), entryIds: v.array(v.string()) }) });
export const event = v.union(taskCreatedEvent, investigationEvent, moneyEvent);
export const investigationSnapshot = v.object({
  ...synthetic, snapshotId: v.string(), eventId: v.string(), taskId: v.string(), runId: v.string(), sequence: v.number(), timestamp: v.number(), taskState: task,
  inputs: v.object({ transactionId: v.string(), candidateOwnerId: v.string(), evidenceRefs: v.array(evidenceReference), contextRunId: v.string(), instructionVersion: v.string() }),
  output: v.object({ allocationStatus: v.literal("unallocated"), allocatedAmountCents: v.literal(0), approved: v.literal(false), investigationStatus, providerMode: mode, simulated: v.boolean(), result: v.union(output, v.null()), deterministicChecks: v.union(checks, v.null()), error: v.union(investigationError, v.null()), reportSource: v.optional(reportSource) }),
});
export const moneySnapshot = v.object({ ...synthetic, kind: v.literal("money"), snapshotId: v.string(), eventId: v.string(), taskId: v.string(), runId: v.string(), sequence: v.number(), timestamp: v.number(),
  inputs: v.object({ accountId: v.string(), proposalId: v.union(v.string(), v.null()), stage: v.string() }),
  output: v.object({ proposal: v.union(money.proposal, v.null()), lock: v.union(money.lockResult, v.null()), threeWay: v.union(money.threeWay, v.null()), entryIds: v.array(v.string()) }) });
export const snapshot = v.union(initialSnapshot, investigationSnapshot, moneySnapshot);
