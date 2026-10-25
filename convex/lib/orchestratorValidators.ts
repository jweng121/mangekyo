import { v } from "convex/values";
import { ORCHESTRATOR_STATES } from "@mangekyo/finance-core/orchestrator";
import * as money from "./moneyValidators";
import { claimCheck, clarification, investigationError, policy } from "./validators";

export const state = v.union(...ORCHESTRATOR_STATES.map(s => v.literal(s)));
export const kind = v.union(v.literal("deposit"), v.literal("reconciliation"), v.literal("disbursement"), v.literal("audit"));
export const agentName = v.union(v.literal("intake"), v.literal("disbursement"), v.literal("evidence_checker"), v.literal("reconciler"), v.literal("auditor"));
export const agentMode = v.union(v.literal("mock"), v.literal("creao"), v.literal("external"));
/** Recorded on every agent run: which agent, in which mode, on which model (never a key). */
export const provenance = v.object({ agent: agentName, mode: agentMode, model: v.string(), instructionVersion: v.string() });
export const actor = v.object({ type: v.union(v.literal("system"), v.literal("agent"), v.literal("code"), v.literal("person")), identity: v.string() });
export const reason = v.object({ code: v.string(), message: v.string() });
export const budget = v.object({
  allowed: v.boolean(), code: v.string(), message: v.string(), needed: v.number(), usedToday: v.number(), usedForDeposit: v.number(),
  limits: v.object({ perDay: v.number(), perDeposit: v.number() }),
});

/** One per deposit task (kind deposit) or per code-found mismatch (kind reconciliation). */
export const orchestration = v.object({
  orchestrationId: v.string(), kind, taskId: v.string(), accountId: v.union(v.string(), v.null()), subjectSourceId: v.union(v.string(), v.null()),
  state, activeRunId: v.union(v.string(), v.null()), lastRunId: v.union(v.string(), v.null()), sequence: v.number(), retries: v.number(),
  reason: v.union(reason, v.null()), createdAt: v.number(), updatedAt: v.number(),
});

/** Append-only. Every state change, retry and budget check, with who or what caused it. */
export const event = v.object({
  eventId: v.string(), orchestrationId: v.string(), taskId: v.string(), accountId: v.union(v.string(), v.null()), runId: v.union(v.string(), v.null()), sequence: v.number(),
  kind: v.union(v.literal("transition"), v.literal("retry"), v.literal("budget_check")), from: v.union(state, v.null()), to: state,
  trigger: v.string(), actor, reason, timestamp: v.number(), budget: v.optional(budget), error: v.optional(investigationError),
});

const checkerSummary = v.object({ status: v.union(v.literal("passed"), v.literal("rejected")), agentMode: v.string(), supported: v.number(), notSupported: v.number(), notCheckable: v.number() });
export const runSummary = v.object({ runId: v.string(), attempt: v.number(), status: v.string(), mode: v.string(), outcome: v.union(v.string(), v.null()), checker: v.union(checkerSummary, v.null()) });

/** Append-only. The orchestration exactly as it was after the event. */
export const snapshot = v.object({
  snapshotId: v.string(), eventId: v.string(), orchestrationId: v.string(), sequence: v.number(), timestamp: v.number(),
  orchestration, run: v.union(runSummary, v.null()),
});

/** One row per real (paid) provider run of any agent. Mock runs are never recorded. Old rows say investigator/checker. */
export const realRun = v.object({ runId: v.string(), taskId: v.string(), accountId: v.union(v.string(), v.null()), provider: v.union(v.literal("investigator"), v.literal("checker"), v.literal("intake"), v.literal("evidence_checker"), v.literal("disbursement"), v.literal("reconciler"), v.literal("auditor")), day: v.string(), at: v.number() });

export const correctingEntry = v.object({
  kind: v.union(v.literal("record_bank_item"), v.literal("reverse_entry")), bankSourceId: v.union(v.string(), v.null()), reversesEntryId: v.union(v.string(), v.null()),
  ownerId: v.union(v.string(), v.null()), amountCents: v.number(), memo: v.string(), evidenceSourceIds: v.array(v.string()),
});
const cause = v.object({ code: money.causeCode, severity: v.union(v.literal("mismatch"), v.literal("warning")), message: v.string(), amountCents: v.union(v.number(), v.null()), sourceIds: v.array(v.string()), ownerIds: v.array(v.string()), unattributed: v.boolean() });
export const reconciliationInput = v.object({
  schemaVersion: v.literal("finance-reconciliation-input/v1"), instructionVersion: v.literal("finance-reconciler/v1"), runId: v.string(), accountId: v.string(), currency: v.string(), causeKey: v.string(), cause,
  threeWay: v.object({ status: v.union(v.literal("matched"), v.literal("mismatched"), v.literal("insufficient_data")), bankMinusBook: v.union(v.number(), v.null()), bookMinusOwners: v.number() }),
  records: v.object({
    bankTransactions: v.array(money.bankTransaction), ledgerEntries: v.array(money.ledgerEntry),
    owners: v.array(v.object({ ownerId: v.string(), sourceId: v.string(), name: v.string() })), documents: v.array(v.object({ sourceId: v.string(), title: v.string(), text: v.string() })),
  }),
});
export const reconciliationOutput = v.object({
  schemaVersion: v.literal("finance-reconciliation-output/v1"), outcome: v.union(v.literal("correction_proposed"), v.literal("needs_information")), explanation: v.string(),
  findings: v.array(v.object({ findingId: v.string(), summary: v.string(), sourceRefs: v.array(v.string()) })), questions: v.array(v.object({ key: v.string(), question: v.string() })),
  proposedEntry: v.union(correctingEntry, v.null()),
});
const correctionFailure = v.object({ rule: v.union(v.literal("L3"), v.literal("L4"), v.literal("L6"), v.literal("L7"), v.literal("R1")), code: v.string(), message: v.string(), sourceIds: v.array(v.string()) });
export const correctionLock = v.object({ allowed: v.boolean(), failures: v.array(correctionFailure), evaluated: v.array(v.string()), resolves: v.boolean() });
export const findingCheck = v.object({ findingId: v.string(), supported: v.boolean(), missing: v.array(v.string()), sourceSays: v.union(v.string(), v.null()) });

export const reconciliationRun = v.object({
  runId: v.string(), orchestrationId: v.string(), accountId: v.string(), causeKey: v.string(), attempt: v.number(), mode: agentMode, model: v.optional(v.string()),
  status: v.union(v.literal("investigating"), v.literal("validating"), v.literal("checking"), v.literal("needs_person"), v.literal("rejected"), v.literal("failed")),
  input: reconciliationInput, output: v.union(reconciliationOutput, v.null()), findingChecks: v.array(findingCheck), dryRun: v.union(correctionLock, v.null()),
  error: v.union(investigationError, v.null()), externalRunId: v.union(v.string(), v.null()), retries: v.number(), createdAt: v.number(), updatedAt: v.number(),
});

/** A proposed correcting entry. It changes status (proposed → posted | rejected); the ledger itself is only appended to. */
export const correction = v.object({
  correctionId: v.string(), accountId: v.string(), runId: v.string(), orchestrationId: v.string(), causeKey: v.string(), entry: correctingEntry, explanation: v.string(),
  status: v.union(v.literal("proposed"), v.literal("posted"), v.literal("rejected")), requestedBy: v.string(),
  decidedBy: v.optional(v.string()), rejectionReason: v.optional(v.string()), lock: v.optional(correctionLock), entryIds: v.optional(v.array(v.string())), createdAt: v.number(), updatedAt: v.number(),
});

export const backtestCase = v.object({ bankSourceId: v.string(), label: v.string(), predictedOwnerId: v.string(), decidedOwnerIds: v.array(v.string()), agrees: v.boolean() });
export const backtest = v.object({ statement: v.string(), testable: v.boolean(), handled: v.number(), agree: v.number(), disagree: v.number(), cases: v.array(backtestCase), summary: v.string(), reasonRequired: v.boolean() });
/** Append-only record of the backtest shown when a person approved a rule, and their reason when one was required. */
export const policyBacktest = backtest.extend({ backtestId: v.string(), accountId: v.string(), policyId: v.string(), runId: v.string(), reason: v.union(v.string(), v.null()), approvedBy: v.string(), at: v.number() });

export const scorecard = v.object({ scorecardId: v.string(), accountId: v.string(), kind: v.union(v.literal("planted"), v.literal("batch"), v.literal("audit_drill")), count: v.number(), startedAt: v.number() });

/* ---------- Step snapshots for the visual audit (append-only) ---------- */
export const stepKind = v.union(v.literal("input_frozen"), v.literal("agent_answered"), v.literal("output_validated"), v.literal("claims_checked"), v.literal("lock_evaluated"), v.literal("person_decided"), v.literal("failed"));
export const stepSnapshot = v.object({
  snapshotId: v.string(), runId: v.string(), taskId: v.string(), accountId: v.union(v.string(), v.null()), agent: agentName, stepIndex: v.number(), kind: stepKind, actor,
  model: v.string(), mode: agentMode, instructionVersion: v.string(), startedAt: v.number(), finishedAt: v.number(),
  input: v.any(), output: v.any(), checkerVerdicts: v.union(v.array(claimCheck.fields.claims.element), v.null()), lockResults: v.union(v.array(money.lockResult), v.null()), message: v.string(),
});
export const runStep = v.object({ stepIndex: v.number(), snapshotId: v.string(), kind: stepKind, actor, model: v.string(), mode: agentMode, startedAt: v.number(), finishedAt: v.number(), message: v.string() });

/* ---------- Corrections of runs (a new linked attempt; the old run is never changed) ---------- */
export const correctionKind = v.union(v.literal("cite_clarification"), v.literal("checker_wrong"), v.literal("add_document"), v.literal("correct_input_field"));
export const runCorrection = v.object({
  correctionId: v.string(), runId: v.string(), taskId: v.string(), stepIndex: v.number(), kind: correctionKind, payload: v.record(v.string(), v.string()), reason: v.string(), actor: v.string(),
  newRunId: v.string(), clarificationId: v.string(), createdAt: v.number(),
});

/* ---------- Eval cases and replays ---------- */
export const evalExpectation = v.object({ mustNotRepeatClaim: v.optional(v.string()), mustCite: v.optional(v.array(v.string())), mustNotCite: v.optional(v.array(v.string())), expectedOutcome: v.optional(v.string()), expectedOwnerId: v.optional(v.string()) });
export const evalCase = v.object({
  evalCaseId: v.string(), agent: agentName, instructionVersion: v.string(), kind: v.union(v.literal("correction"), v.literal("checker_rejection")), runId: v.string(), taskId: v.string(),
  input: v.any(), observedOutput: v.any(), expectation: evalExpectation, createdAt: v.number(),
});
export const evalResult = v.object({ evalCaseId: v.string(), verdict: v.union(v.literal("passed"), v.literal("failed"), v.literal("changed")), detail: v.string() });
export const evalRun = v.object({ evalRunId: v.string(), agent: agentName, instructionVersion: v.string(), mode: v.literal("mock"), passed: v.number(), failed: v.number(), changed: v.number(), total: v.number(), results: v.array(evalResult), ranAt: v.number() });

/* ---------- Disbursement runs ---------- */
export const payoutLine = v.object({ lineId: v.string(), kind: money.payoutKind, label: v.string(), amountCents: v.number(), payeeOwnerId: v.union(v.string(), v.null()), sourceRefs: v.array(v.string()) });
const smallOwner = v.object({ ownerId: v.string(), sourceId: v.string(), name: v.string() });
export const disbursementInput = v.object({
  schemaVersion: v.literal("finance-disbursement-input/v1"), instructionVersion: v.literal("finance-disbursement/v1"), runId: v.string(), accountId: v.string(), currency: v.string(), matterId: v.string(),
  client: smallOwner, firm: v.union(smallOwner, v.null()), settlementDeposit: v.union(money.bankTransaction, v.null()), documents: v.array(money.sourceDocument), invoices: v.array(money.obligation),
  clientBalance: v.union(money.ownerBalance, v.null()), disputes: v.array(money.dispute), approvedPolicies: v.array(policy), humanClarifications: v.array(clarification),
});
export const disbursementOutput = v.object({
  schemaVersion: v.literal("finance-disbursement-output/v1"), outcome: v.union(v.literal("proposal_ready"), v.literal("needs_information")), summary: v.string(),
  findings: v.array(v.object({ findingId: v.string(), summary: v.string(), sourceRefs: v.array(v.string()) })), questions: v.array(v.object({ key: v.string(), question: v.string(), sourceRefs: v.array(v.string()) })), lines: v.array(payoutLine),
});
export const lineCheck = v.object({ lineId: v.string(), supported: v.boolean(), reason: v.string(), sourceIds: v.array(v.string()) });
export const disbursementRun = v.object({
  runId: v.string(), orchestrationId: v.string(), taskId: v.string(), accountId: v.string(), matterId: v.string(), clientOwnerId: v.string(), settlementSourceId: v.string(), attempt: v.number(),
  provenance, status: v.union(v.literal("investigating"), v.literal("validating"), v.literal("checking"), v.literal("needs_person"), v.literal("ready_for_approval"), v.literal("rejected"), v.literal("waiting_to_clear"), v.literal("failed")),
  input: disbursementInput, output: v.union(disbursementOutput, v.null()), lineChecks: v.array(lineCheck), claimCheck: v.optional(claimCheck), proposalIds: v.array(v.string()),
  error: v.union(investigationError, v.null()), externalRunId: v.union(v.string(), v.null()), retries: v.number(), deadline: v.number(), createdAt: v.number(), updatedAt: v.number(),
});

/* ---------- Audit reports (append-only; never change money) ---------- */
export const auditRuleId = v.union(...(["A1_NEGATIVE_CLIENT_BALANCE", "A2_GOOD_FUNDS", "A3_COMMINGLING", "A4_FEE_NOT_EARNED", "A5_DISPUTED_FUNDS_PAID", "A6_SETTLEMENT_SPLIT", "A7_MONTHLY_RECONCILIATION", "A8_SECOND_APPROVER_AND_EVIDENCE"] as const).map(r => v.literal(r)));
export const auditFinding = v.object({ findingId: v.string(), ruleId: auditRuleId, severity: v.union(v.literal("violation"), v.literal("warning")), message: v.string(), entryIds: v.array(v.string()), sourceIds: v.array(v.string()), ownerId: v.union(v.string(), v.null()), amountCents: v.union(v.number(), v.null()), foundBy: v.union(v.literal("code"), v.literal("agent")) });
export const auditReport = v.object({
  reportId: v.string(), accountId: v.string(), period: v.object({ from: v.number(), to: v.number() }), agent: v.literal("auditor"), mode: agentMode, model: v.string(), instructionVersion: v.string(),
  status: v.union(v.literal("clean"), v.literal("findings")), findings: v.array(auditFinding), summary: v.string(), reviewed: v.object({ entries: v.number(), proposals: v.number(), owners: v.number(), months: v.number() }), generatedAt: v.number(), generatedBy: v.string(),
});
export const auditRun = v.object({ runId: v.string(), orchestrationId: v.string(), taskId: v.string(), accountId: v.string(), period: v.object({ from: v.number(), to: v.number() }), provenance, status: v.union(v.literal("investigating"), v.literal("validating"), v.literal("needs_person"), v.literal("failed")), input: v.any(), output: v.any(), reportId: v.union(v.string(), v.null()), error: v.union(investigationError, v.null()), externalRunId: v.union(v.string(), v.null()), retries: v.number(), deadline: v.number(), requestedBy: v.string(), createdAt: v.number(), updatedAt: v.number() });

/* ---------- Monthly reconciliation (signed off by a person; immutable once signed) ---------- */
export const monthlyReport = v.object({
  reportId: v.string(), accountId: v.string(), month: v.string(), periodEnd: v.number(),
  bank: v.object({ statementCents: v.union(v.number(), v.null()), adjustedCents: v.union(v.number(), v.null()), clearedCents: v.union(v.number(), v.null()), pendingCents: v.number() }),
  bookCents: v.number(), clientLedgers: v.array(v.object({ ownerId: v.union(v.string(), v.null()), name: v.string(), postedCents: v.number(), clearedCents: v.number(), ownerKind: v.union(v.literal("client"), v.literal("firm"), v.literal("unallocated")) })),
  reconcilingItems: v.array(v.object({ kind: v.string(), entryId: v.union(v.string(), v.null()), sourceIds: v.array(v.string()), amountCents: v.number(), description: v.string() })),
  threeWay: v.object({ status: v.union(v.literal("matched"), v.literal("mismatched"), v.literal("insufficient_data")), bankMinusBook: v.union(v.number(), v.null()), bookMinusOwners: v.number(), causes: money.threeWay.fields.causes }),
  signedOff: v.union(v.object({ by: v.string(), at: v.number(), note: v.union(v.string(), v.null()) }), v.null()),
});
