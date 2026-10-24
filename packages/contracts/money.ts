/** Client-money records. Amounts are integer cents; sourceIds are deterministic functions of raw IDs. */

export interface RawPointer {
  system: "erp" | "bank" | "demo";
  recordType: string;
  rawId: string;
  datasetVersion: string;
}

export interface MoneyAccount {
  accountId: string;
  sourceId: string;
  name: string;
  currency: string;
  /** Cutover time of the opening balances and bank statement anchor. */
  openingAsOf: number;
  synthetic: true;
  raw: RawPointer;
}

export interface NormalizedBankTransaction {
  sourceId: string;
  accountId: string;
  subAccount: string;
  direction: "inflow" | "outflow";
  amountCents: number;
  currency: string;
  bookedAt: number;
  clearing: "cleared" | "pending";
  reference: string;
  counterparty: string;
  /** Owner named by the bank/ERP record itself; a hint, never proof of ownership. */
  ownerHintSourceId: string | null;
  documentSourceIds: string[];
  duplicateOfSourceId: string | null;
  raw: RawPointer;
}

export interface NormalizedOwner {
  sourceId: string;
  ownerId: string;
  accountId: string;
  subAccount: string;
  name: string;
  raw: RawPointer;
}

export interface NormalizedObligation {
  sourceId: string;
  accountId: string;
  kind: "invoice" | "agreement" | "expected_payment";
  ownerSourceId: string | null;
  amountCents: number | null;
  currency: string | null;
  reference: string;
  status: string;
  excerpt: string;
  raw: RawPointer;
}

export interface NormalizedDocument {
  sourceId: string;
  accountId: string;
  documentType: string;
  title: string;
  version: string;
  text: string;
  excerpt: string;
  /** Owners named in the document text, matched exactly by code. */
  namedOwnerSourceIds: string[];
  raw: RawPointer;
}

export interface BankStatementBalance {
  sourceId: string;
  accountId: string;
  amountCents: number;
  asOf: number;
  raw: RawPointer;
}

export interface ReconcilingItem {
  sourceId: string;
  accountId: string;
  appliesTo: "bank";
  amountCents: number;
  description: string;
  /** False when the source supplies a figure without line-item detail. */
  detailed: boolean;
  raw: RawPointer;
}

export interface OpeningBalance {
  sourceId: string;
  accountId: string;
  /** null is the unallocated bucket. */
  ownerId: string | null;
  amountCents: number;
  clearedCents: number;
  asOf: number;
  /** Bank transaction backing an unallocated opening deposit. */
  bankSourceId: string | null;
  raw: RawPointer;
}

export interface NormalizedAccountBundle {
  account: MoneyAccount;
  owners: NormalizedOwner[];
  bankTransactions: NormalizedBankTransaction[];
  obligations: NormalizedObligation[];
  documents: NormalizedDocument[];
  statementBalances: BankStatementBalance[];
  reconcilingItems: ReconcilingItem[];
  openingBalances: OpeningBalance[];
  /** Records the adapter refused or could not represent exactly. Never silently dropped. */
  issues: Array<{ rawId: string; reason: string }>;
}

export type LedgerEntryKind = "deposit_received" | "allocation" | "disbursement" | "reversal" | "fee" | "adjustment";

/** Append-only. Corrections are new reversal entries linked by reversesEntryId. */
export interface LedgerEntry {
  entryId: string;
  accountId: string;
  ownerId: string | null;
  amountCents: number;
  currency: string;
  kind: LedgerEntryKind;
  status: "posted";
  sourceRefs: string[];
  proposalId?: string;
  approvalId?: string;
  reversesEntryId?: string;
  /** Bank transaction whose clearing status governs availability of these funds. */
  fundsSourceId?: string;
  /** Fixed cleared portion for opening balances imported without a bank transaction. */
  clearedCents?: number;
  /** Reference the bank feed is expected to carry for this entry's settlement. */
  bankReference?: string;
  memo: string;
  effectiveAt: number;
  createdAt: number;
  createdBy: string;
}

export interface OwnerBalance {
  ownerId: string | null;
  name: string;
  postedCents: number;
  clearedCents: number;
  unclearedCents: number;
  holdsCents: number;
  availableCents: number;
}

export type ThreeWayCauseCode =
  | "BANK_TXN_WITHOUT_LEDGER_ENTRY" | "LEDGER_ENTRY_WITHOUT_BANK_TXN" | "AMOUNT_MISMATCH"
  | "DUPLICATE_POSTING" | "UNCLEARED_DEPOSIT_ALLOCATED" | "UNKNOWN_OWNER_ENTRY"
  | "CURRENCY_MISMATCH" | "RECONCILING_ITEM_WITHOUT_DETAIL" | "NO_OPENING_BALANCE";

export interface ThreeWayCause {
  code: ThreeWayCauseCode;
  /** Warnings are reported risks that do not, by themselves, make the totals disagree. */
  severity: "mismatch" | "warning";
  message: string;
  amountCents: number | null;
  sourceIds: string[];
  /** Owners whose outflows are affected; empty with unattributed=true blocks the whole account. */
  ownerIds: string[];
  unattributed: boolean;
}

export interface ThreeWayCheckResult {
  accountId: string;
  currency: string;
  cutoff: number;
  status: "matched" | "mismatched" | "insufficient_data";
  bank: { statementCents: number | null; postAnchorCents: number; reconcilingCents: number; adjustedCents: number | null; clearedCents: number | null; pendingCents: number };
  bookCents: number;
  ownersTotalCents: number;
  unallocatedCents: number;
  differences: { bankMinusBook: number | null; bookMinusOwners: number };
  causes: ThreeWayCause[];
}

export type ProposalKind = "allocation" | "payment";
export type ProposalStatus = "proposed" | "pending_approval" | "approved" | "posted" | "rejected" | "blocked";

export interface AllocationShare { ownerId: string; amountCents: number }

export interface MoneyProposal {
  proposalId: string;
  accountId: string;
  kind: ProposalKind;
  status: ProposalStatus;
  currency: string;
  requestedBy: string;
  origin: { type: "agent"; taskId: string; runId: string; agentProposalIds: string[] } | { type: "person" };
  evidenceSourceIds: string[];
  /** Allocation: the deposit being divided among owners. */
  bankSourceId?: string;
  shares?: AllocationShare[];
  /** Payment: the owner whose money is disbursed. */
  ownerId?: string;
  amountCents: number;
  purpose: string;
  fundingSourceId?: string;
  approvedBy?: string;
  approvalId?: string;
  rejectionReason?: string;
  blockedReasons?: LockFailure[];
  postedEntryIds?: string[];
  createdAt: number;
  updatedAt: number;
}

export type LockCode =
  | "OWNER_INSUFFICIENT_FUNDS" | "FUNDS_NOT_CLEARED" | "MISSING_EVIDENCE" | "SELF_APPROVAL"
  | "RECONCILIATION_MISMATCH" | "AMOUNT_INTEGRITY" | "STATE";

export interface LockFailure { rule: "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7"; code: LockCode; message: string; sourceIds: string[] }

export interface LockResult {
  allowed: boolean;
  stage: "request" | "approve" | "post";
  failures: LockFailure[];
  /** Rules evaluated, in order, including those that passed. */
  evaluated: Array<LockFailure["rule"]>;
  facts: Record<string, number | string | null>;
}

export interface ProposalTransition {
  transitionId: string;
  proposalId: string;
  accountId: string;
  from: ProposalStatus | null;
  to: ProposalStatus;
  actor: string;
  reason: string | null;
  lock: LockResult | null;
  at: number;
}
