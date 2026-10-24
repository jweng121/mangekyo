/**
 * Agent orchestration contract for the visual audit and the desk. Import via "@mangekyo/contracts/orchestration".
 * Additive to the existing contracts: nothing here changes money.ts, investigation.ts or events.ts.
 * Amounts are integer cents. IDs are stable strings, never Convex document IDs.
 */
import type { ClaimCheck, ClaimVerdict, FinanceAgentInput, FinanceAgentOutput } from "./investigation";
import type { LockFailure, LockResult, LockRule, PayoutKind, ThreeWayCause, ThreeWayCheckResult } from "./money";

/* ---------- Agents ---------- */

/** The five trust agents. Old names stay valid as aliases (see AGENT_ALIASES). */
export type AgentName = "intake" | "disbursement" | "evidence_checker" | "reconciler" | "auditor";
/** mock: deterministic stand-in; creao: a CREAO app; external: a model provider called directly with a key from env. */
export type AgentMode = "mock" | "creao" | "external";
export const AGENT_ALIASES: Record<string, AgentName> = {
  investigator: "intake", "trust-intake": "intake", intake: "intake",
  checker: "evidence_checker", "claim-checker": "evidence_checker", "evidence-checker": "evidence_checker", evidence_checker: "evidence_checker",
  "mismatch-agent": "reconciler", mismatch: "reconciler", "three-way-reconciler": "reconciler", reconciler: "reconciler",
  disbursement: "disbursement", auditor: "auditor", "trust-compliance-auditor": "auditor",
};
/** Which model each agent is planned to run on when its mode is external. Recorded on every run with the mode. */
export interface AgentModelPlan { agent: AgentName; label: string; plannedModel: string; envPrefix: string }

/* ---------- Runs and states ---------- */

export type OrchestratorState = "received" | "investigating" | "validating" | "checking" | "needs_person" | "ready_for_approval" | "rejected" | "waiting_to_clear" | "failed";
export type OrchestratorKind = "deposit" | "reconciliation" | "disbursement" | "audit";
export interface OrchestratorActor { type: "system" | "agent" | "code" | "person"; identity: string }
export interface OrchestratorReason { code: string; message: string }

/** One orchestrator per subject (deposit, mismatch cause, matter payout, audit period). */
export interface OrchestrationRecord {
  orchestrationId: string;
  kind: OrchestratorKind;
  taskId: string;
  accountId: string | null;
  subjectSourceId: string | null;
  state: OrchestratorState;
  activeRunId: string | null;
  lastRunId: string | null;
  sequence: number;
  retries: number;
  reason: OrchestratorReason | null;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestratorEventRecord {
  eventId: string;
  orchestrationId: string;
  taskId: string;
  accountId: string | null;
  runId: string | null;
  sequence: number;
  kind: "transition" | "retry" | "budget_check";
  from: OrchestratorState | null;
  to: OrchestratorState;
  trigger: string;
  actor: OrchestratorActor;
  reason: OrchestratorReason;
  timestamp: number;
}

/** Model and mode as recorded on every agent run. `model` is "mock" for mock runs and the CREAO app ID for creao runs. */
export interface AgentRunProvenance { agent: AgentName; mode: AgentMode; model: string; instructionVersion: string }

/* ---------- Steps and snapshots (visual audit) ---------- */

export type RunStepKind = "input_frozen" | "agent_answered" | "output_validated" | "claims_checked" | "lock_evaluated" | "person_decided" | "failed";

/** Immutable record of one step of one run. Written once; never patched. */
export interface StepSnapshot {
  snapshotId: string;
  runId: string;
  taskId: string;
  accountId: string | null;
  agent: AgentName;
  stepIndex: number;
  kind: RunStepKind;
  actor: OrchestratorActor;
  model: string;
  mode: AgentMode;
  instructionVersion: string;
  startedAt: number;
  finishedAt: number;
  /** Exactly what the agent (or code) was given at this step, frozen. */
  input: unknown;
  /** The validated output of this step, or null when the step produced none (or failed). */
  output: unknown | null;
  checkerVerdicts: ClaimCheck[] | null;
  lockResults: LockResult[] | null;
  message: string;
}

export interface RunStep {
  stepIndex: number;
  snapshotId: string;
  kind: RunStepKind;
  actor: OrchestratorActor;
  model: string;
  mode: AgentMode;
  startedAt: number;
  finishedAt: number;
  message: string;
}

/* ---------- Claims and verdicts ---------- */

export type { ClaimCheck, ClaimVerdict };
export interface ClaimsView {
  runId: string;
  agent: AgentName;
  status: "passed" | "rejected" | "not_checked";
  checkerMode: AgentMode | "off";
  claims: ClaimCheck[];
}

/* ---------- Corrections ---------- */

export type CorrectionKind = "cite_clarification" | "checker_wrong" | "add_document" | "correct_input_field";

export interface CorrectionRequest {
  runId: string;
  /** Step of the run the person is correcting (from getRunSteps). */
  stepIndex: number;
  kind: CorrectionKind;
  /** cite_clarification: { note? }; checker_wrong: { note }; add_document: { title?, text }; correct_input_field: { path, value }. */
  payload: Record<string, string>;
  reason: string;
  actor: { role: "requester" | "approver"; name: string };
}

export interface CorrectionRecord {
  correctionId: string;
  runId: string;
  taskId: string;
  stepIndex: number;
  kind: CorrectionKind;
  payload: Record<string, string>;
  reason: string;
  actor: string;
  /** The new attempt this correction created. The corrected run itself is never changed. */
  newRunId: string;
  clarificationId: string;
  createdAt: number;
}

/* ---------- Policies and backtests ---------- */

export interface PolicyRecord {
  policyId: string;
  version: string;
  statement: string;
  status: "approved";
  accountId: string;
  currency: string;
  approvedAt: number;
  approvedBy: string | null;
  fromRunId: string | null;
  sourceId: string;
  /** Shown wherever the policy is used: "Used policy P-1, approved by dev-unverified:sam". */
  usedLabel: string;
}

export interface BacktestCase { bankSourceId: string; label: string; predictedOwnerId: string; decidedOwnerIds: string[]; agrees: boolean }
export interface PolicyBacktestRecord {
  statement: string;
  testable: boolean;
  handled: number;
  agree: number;
  disagree: number;
  cases: BacktestCase[];
  summary: string;
  reasonRequired: boolean;
  backtestId?: string;
  policyId?: string;
  runId?: string;
  reason?: string | null;
  approvedBy?: string;
  at?: number;
}

export interface CandidatePolicyView { policyId: string; runId: string; statement: string; sourceRefs: string[]; backtest: PolicyBacktestRecord | null }

/* ---------- Eval cases ---------- */

export type EvalCaseKind = "correction" | "checker_rejection";
export interface EvalCase {
  evalCaseId: string;
  agent: AgentName;
  instructionVersion: string;
  kind: EvalCaseKind;
  runId: string;
  taskId: string;
  /** The frozen input of the run the case came from. */
  input: unknown;
  /** What the agent answered then. */
  observedOutput: unknown;
  /** What a correct answer must satisfy, in code-checkable terms. */
  expectation: { mustNotRepeatClaim?: string; mustCite?: string[]; mustNotCite?: string[]; expectedOutcome?: string; expectedOwnerId?: string };
  createdAt: number;
}
export type EvalVerdict = "passed" | "failed" | "changed";
export interface EvalCaseResult { evalCaseId: string; verdict: EvalVerdict; detail: string }
export interface EvalReport {
  evalRunId: string;
  agent: AgentName;
  instructionVersion: string;
  mode: "mock";
  passed: number;
  failed: number;
  changed: number;
  total: number;
  results: EvalCaseResult[];
  ranAt: number;
}

/* ---------- Disbursement ---------- */

/** One proposed payout line, each backed by a signed document. */
export interface PayoutLine {
  lineId: string;
  kind: PayoutKind;
  label: string;
  amountCents: number;
  /** null when the client receives it. */
  payeeOwnerId: string | null;
  /** sourceIds of the signed documents (and approved invoices) that back the line. */
  sourceRefs: string[];
}
export interface DisbursementProposalView {
  runId: string;
  matterId: string;
  clientOwnerId: string;
  settlementSourceId: string;
  outcome: "proposal_ready" | "needs_information";
  lines: PayoutLine[];
  questions: Array<{ key: string; question: string; sourceRefs: string[] }>;
  /** Proposal IDs created in the lock queue, one per line, in line order. */
  proposalIds: string[];
}

/* ---------- Audit ---------- */

export type AuditRuleId = "A1_NEGATIVE_CLIENT_BALANCE" | "A2_GOOD_FUNDS" | "A3_COMMINGLING" | "A4_FEE_NOT_EARNED" | "A5_DISPUTED_FUNDS_PAID" | "A6_SETTLEMENT_SPLIT" | "A7_MONTHLY_RECONCILIATION" | "A8_SECOND_APPROVER_AND_EVIDENCE";
export interface AuditFinding {
  findingId: string;
  ruleId: AuditRuleId;
  severity: "violation" | "warning";
  message: string;
  entryIds: string[];
  sourceIds: string[];
  ownerId: string | null;
  amountCents: number | null;
  /** Code found it, or the auditor agent did (an agent finding must cite entries from the input). */
  foundBy: "code" | "agent";
}
export interface AuditReport {
  reportId: string;
  accountId: string;
  period: { from: number; to: number };
  agent: "auditor";
  mode: AgentMode;
  model: string;
  instructionVersion: string;
  status: "clean" | "findings";
  findings: AuditFinding[];
  summary: string;
  /** Counts of what was reviewed, so a clean report says what it covered. */
  reviewed: { entries: number; proposals: number; owners: number; months: number };
  generatedAt: number;
  generatedBy: string;
}

export interface AuditorScorecard {
  accountId: string;
  reportId: string | null;
  planted: Array<{ key: string; label: string; entryId: string; ruleId: AuditRuleId; status: "caught" | "missed" }>;
  caught: number;
  missed: number;
  falseAlarms: number;
  falseAlarmFindings: Array<{ findingId: string; ruleId: AuditRuleId; message: string }>;
  line: string;
}

/* ---------- Monthly reconciliation ---------- */

export interface MonthlyReconciliationReport {
  reportId: string;
  accountId: string;
  /** YYYY-MM (UTC). */
  month: string;
  periodEnd: number;
  bank: { statementCents: number | null; adjustedCents: number | null; clearedCents: number | null; pendingCents: number };
  bookCents: number;
  clientLedgers: Array<{ ownerId: string | null; name: string; postedCents: number; clearedCents: number; ownerKind: "client" | "firm" | "unallocated" }>;
  reconcilingItems: Array<{ kind: string; entryId: string | null; sourceIds: string[]; amountCents: number; description: string }>;
  threeWay: { status: ThreeWayCheckResult["status"]; bankMinusBook: number | null; bookMinusOwners: number; causes: ThreeWayCause[] };
  signedOff: { by: string; at: number; note: string | null } | null;
}

/* ---------- Scorecards ---------- */

export interface PlantedScorecardView {
  kind: "planted";
  scorecardId: string;
  startedAt: number;
  plants: Array<{ key: string; label: string; mistake: string; rightAnswer: string; catcher: string; status: "caught" | "wrong" | "pending"; askedPerson: boolean; detail: string; link: string | null }>;
  summary: { caught: number; wrong: number; askedPerson: number; pending: number; total: number; line: string };
}
export interface BatchScorecardView {
  kind: "batch";
  scorecardId: string;
  startedAt: number;
  summary: { count: number; settled: number; durationMs: number | null; handledWithoutPerson: number; flagged: number; waiting: number; matchedRightAnswer: number; pctHandled: number; pctFlagged: number; line: string };
  byState: Record<string, number>;
}
export type ScorecardView = PlantedScorecardView | BatchScorecardView;

/* ---------- Lock ---------- */

export type { LockFailure, LockResult, LockRule, PayoutKind };
/** Every rule the lock evaluates, in order, including the trust rules. */
export const LOCK_RULES: readonly LockRule[] = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11"];

/** Input and output shapes of the agents, re-exported so one import covers the whole run. */
export type { FinanceAgentInput, FinanceAgentOutput, FinanceAgentOutput as IntakeOutput };
