import type { EvidenceReference, FinanceDocument, FinanceOwner, FinanceTransaction } from "./finance";
import type { NormalizedBankTransaction, NormalizedObligation, OwnerBalance, ThreeWayCheckResult } from "./money";

export const FINANCE_INPUT_VERSION = "finance-investigation-input/v1" as const;
export const FINANCE_OUTPUT_VERSION = "finance-investigation-output/v1" as const;
export const FINANCE_INSTRUCTION_VERSION = "finance-investigator/v1" as const;
export type FinanceAgentMode = "mock" | "creao";
export interface FinanceReportSource {
  field: "result.text" | "result.chatText";
  format: "json" | "json_suffix";
}
export interface InvestigationScope {
  kind: "historical_onboarding" | "deposit_investigation";
  accountId: string;
  currency: string;
  from: number | null;
  cutoff: number;
}
/** Start requests may omit cutoff; persisted scopes always have server-resolved time. */
export type InvestigationStartScope = Omit<InvestigationScope, "cutoff"> & { cutoff?: number };
export interface BalanceRecord {
  balanceId: string;
  sourceId: string;
  accountId: string;
  currency: string;
  cutoff: number;
  amountCents: number;
}
export interface OwnerBalanceRecord extends BalanceRecord { ownerId: string }
export interface TimingDifference {
  differenceId: string;
  sourceId: string;
  accountId: string;
  currency: string;
  cutoff: number;
  appliesTo: "bank" | "control" | "owners";
  amountCents: number;
  description: string;
  documented: boolean;
}
/** A view over source systems, not a replacement ERP. Missing collections remain explicit. */
export interface FinanceRecordSet {
  transactions: Array<FinanceTransaction & { accountId: string }>;
  owners: FinanceOwner[];
  documents: Array<FinanceDocument & { version: string; effectiveAt: number | null }>;
  invoices: Array<{ recordId: string; sourceId: string; version: string; excerpt: string }>;
  agreements: Array<{ recordId: string; sourceId: string; version: string; excerpt: string }>;
  bankBalance: BalanceRecord | null;
  controlBalance: BalanceRecord | null;
  ownerBalances: OwnerBalanceRecord[] | null;
  ownerBalancesComplete: boolean;
  timingDifferences: TimingDifference[];
  existingAllocations: ProposedAllocation[];
  allocationHistoryComplete: boolean;
  missingEvidence: string[];
  coverage: "available_records_only";
  /** Optional v1 additions from the money source adapter; absent on legacy inputs. */
  sourceAdapter?: { system: "erp" | "demo"; datasetVersion: string; accountId: string };
  bankTransactions?: NormalizedBankTransaction[];
  obligations?: NormalizedObligation[];
  ownerLedgerBalances?: Array<OwnerBalance & { ownerId: string; sourceId: string; cutoff: number }>;
}
export interface ApprovedFinancePolicy {
  policyId: string;
  version: string;
  statement: string;
  status: "approved";
  accountId: string;
  currency: string;
  approvedAt: number;
  sourceId: string;
}
export interface HumanClarification {
  clarificationId: string;
  sourceId: string;
  questionId: string;
  question: string;
  answer: string;
  caseId: string;
  taskId: string;
  runId: string;
  timestamp: number;
  respondent: { identity: string; authenticated: boolean };
  evidenceRefs: EvidenceReference[];
}
export interface FinancialCheck {
  status: "passed" | "failed" | "insufficient_data" | "not_applicable";
  issues: string[];
}
export interface ReconciliationResult {
  status: "insufficient_data" | "unbalanced" | "balanced_totals";
  reasons: string[];
  adjustedBankCents: number | null;
  adjustedControlCents: number | null;
  adjustedOwnerCents: number | null;
  timingDifferences: TimingDifference[];
  /** Matching totals alone do not establish ownership. */
  ownerAllocationsVerified: false;
}
export interface DeterministicChecks {
  amounts: FinancialCheck;
  proposedAllocations: FinancialCheck;
  reconciliation: ReconciliationResult;
  /** Code-computed bank = books = owners check for the account; optional v1 addition. */
  threeWay?: ThreeWayCheckResult;
}
export interface ProposedAllocation {
  proposalId: string;
  transactionId: string;
  ownerId: string;
  amountCents: number;
  currency: string;
  evidenceSourceIds: string[];
}
export interface FinanceAgentInput {
  schemaVersion: typeof FINANCE_INPUT_VERSION;
  instructionVersion: typeof FINANCE_INSTRUCTION_VERSION;
  caseId: string;
  taskId: string;
  runId: string;
  scope: InvestigationScope;
  /** Context collection time, separate from the fixed financial-record cutoff. Optional on legacy runs. */
  contextAsOf?: number;
  records: FinanceRecordSet;
  evidenceRefs: EvidenceReference[];
  deterministicChecks: DeterministicChecks;
  approvedPolicies: ApprovedFinancePolicy[];
  humanClarifications: HumanClarification[];
}
export interface FinanceAgentOutput {
  schemaVersion: typeof FINANCE_OUTPUT_VERSION;
  outcome: "findings" | "needs_information" | "proposal_ready";
  summary: string;
  findings: Array<{ findingId: string; summary: string; sourceRefs: string[] }>;
  questions: Array<{ key: string; question: string; sourceRefs: string[] }>;
  proposedAllocations: ProposedAllocation[];
  proposedActions: Array<{ kind: "request_evidence"; description: string; sourceRefs: string[] }>;
  candidatePolicies: Array<{ policyId: string; statement: string; sourceRefs: string[]; status: "proposed" }>;
}
export type InvestigationStatus = "queued" | "retrieving_evidence" | "checking" | "provider_starting" |
  "provider_pending" | "validating" | "needs_information" | "review_required" | "completed" | "failed";
export interface InvestigationError { code: string; message: string; retryable: boolean; details?: Array<{ path: string; reason: string }> }
export interface FinanceInvestigationRun {
  caseId: string;
  taskId: string;
  runId: string;
  parentRunId: string | null;
  attempt: number;
  mode: FinanceAgentMode;
  simulated: boolean;
  status: InvestigationStatus;
  scope: InvestigationScope;
  createdAt: number;
  updatedAt: number;
  externalRunId: string | null;
  reportSource?: FinanceReportSource;
  /** Frozen nonsecret CREAO app selector; keys remain in the runtime environment. */
  providerAppId?: string;
  providerInput: FinanceAgentInput | null;
  result: FinanceAgentOutput | null;
  resultChecks?: DeterministicChecks;
  error: InvestigationError | null;
}
export interface FinanceInvestigationQuestion {
  caseId: string;
  taskId: string;
  runId: string;
  questionId: string;
  key: string;
  question: string;
  sourceRefs: string[];
  status: "open" | "answered";
  clarificationId: string | null;
}
/** Integration hook only. The teammate's visual-audit implementation owns processing. */
export interface FinanceAuditHandoff {
  kind: "finance.investigation.review_requested";
  taskId: string;
  runId: string;
  contextRunId: string;
  resultAvailable: boolean;
  visualAuditStatus: "not_connected";
}
export interface TaskInvestigationView {
  runs: FinanceInvestigationRun[];
  questions: FinanceInvestigationQuestion[];
  clarifications: HumanClarification[];
  auditHandoff: FinanceAuditHandoff | null;
}
