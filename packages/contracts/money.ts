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
  /** "firm" marks the law firm's own money (earned fees, operating funds). Absent means client. Trust rule L8 flags firm money in trust. */
  ownerKind?: "client" | "firm";
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
  /** Matter the invoice bills, when the source says. Trust rule L9 matches fee transfers to approved invoices by owner and matter. */
  matterId?: string;
  raw: RawPointer;
}

/** What a payout is for. Trust rules L9 and L11 read it; integer cents everywhere. */
export type PayoutKind = "client_share" | "attorney_fee" | "costs" | "lien" | "refund" | "other";

/** One line of a signed settlement statement, as structured by the source adapter. */
export interface SettlementLine {
  kind: PayoutKind;
  label: string;
  amountCents: number;
  /** Payee when the statement names one (the firm for fees and costs, a lienholder for liens); null for the client. */
  payeeOwnerSourceId: string | null;
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
  /** True only when the source system records the document as signed. Payouts and fees can rest only on signed documents. */
  signed?: boolean;
  /** Matter (case) the document belongs to, when the source says. */
  matterId?: string;
  /** Structured lines of a signed settlement statement, so code can compare payouts to it exactly. */
  lines?: SettlementLine[];
  /** Contingency fee of a signed fee agreement, in basis points (33% = 3300). Integer only. */
  feeBasisPoints?: number;
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
  | "CURRENCY_MISMATCH" | "RECONCILING_ITEM_WITHOUT_DETAIL" | "NO_OPENING_BALANCE" | "OUTSTANDING_ITEM_AGED"
  /** Warning: the firm's own money is in the trust account (trust rule L8). */
  | "COMMINGLING";

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

/** A posted entry the bank feed has not shown yet: a reconciling item, not a mismatch, until it ages. */
export interface OutstandingItem {
  kind: "outstanding_payment" | "deposit_in_transit";
  entryId: string;
  sourceIds: string[];
  ownerId: string | null;
  amountCents: number;
  bankReference: string | null;
  effectiveAt: number;
  ageDays: number;
}

export interface ThreeWayCheckResult {
  accountId: string;
  currency: string;
  cutoff: number;
  status: "matched" | "mismatched" | "insufficient_data";
  /**
   * adjustedCents = statement + post-cutover feed + reconciling items + outstanding items (optional on legacy snapshots).
   * adjustedClearedCents = adjustedCents − pending deposits − deposits in transit: the pool figure lock cards show. Outstanding
   * payments are already out of it; clearedCents adds them back (the bank's own cleared view).
   */
  bank: { statementCents: number | null; postAnchorCents: number; reconcilingCents: number; outstandingCents?: number; adjustedCents: number | null; clearedCents: number | null; adjustedClearedCents?: number | null; pendingCents: number };
  bookCents: number;
  ownersTotalCents: number;
  unallocatedCents: number;
  differences: { bankMinusBook: number | null; bookMinusOwners: number };
  causes: ThreeWayCause[];
  outstanding?: OutstandingItem[];
  outstandingMaxDays?: number;
}

/** A disputed amount a person recorded on a client's trust balance. Only a person records its resolution (L10). */
export interface TrustDispute {
  disputeId: string;
  accountId: string;
  ownerId: string;
  amountCents: number;
  reason: string;
  status: "open" | "resolved";
  recordedBy: string;
  recordedAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
  resolution?: string;
  sourceIds: string[];
}

export type ProposalKind = "allocation" | "payment";
export type ProposalStatus = "proposed" | "pending_approval" | "approved" | "posted" | "rejected" | "blocked" | "on_hold" | "cancelled";

/** A proposal paused by temporary failures (L2, L5) at approval or posting; only a person continues it. */
export interface ProposalHold {
  stage: "approve" | "post";
  reasonCodes: string[];
  message: string;
  since: number;
  /** All rules passed at the last re-check; a person may continue. Money never moves on its own. */
  ready: boolean;
  lastCheckedAt: number;
  lastCheckedBy: string;
  lastDecision: "placed" | "recheck" | "auto_recheck" | "keep_waiting";
}

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
  /** Payment: what the payout is for (trust rules L9 and L11). Absent on payments made before trust rules existed; treated as "other". */
  payoutKind?: PayoutKind;
  /** Payment: the matter the payout settles, when known. */
  matterId?: string;
  /** Payment: the signed settlement statement the payout line comes from (L11 compares the line exactly). */
  settlementSourceId?: string;
  /** Payment: who receives the money when it is not the client (the firm for fees and costs, a lienholder). */
  payeeOwnerId?: string;
  approvedBy?: string;
  approvalId?: string;
  rejectionReason?: string;
  hold?: ProposalHold;
  cancellationReason?: string;
  blockedReasons?: LockFailure[];
  postedEntryIds?: string[];
  /** Blocked payment: a person saw it and closed the card. The proposal stays blocked in the history. */
  acknowledged?: { by: string; at: number; note: string | null };
  createdAt: number;
  updatedAt: number;
}

/** Why a blocked payment no longer needs a person: a later request for the same line passed the lock, or a person acknowledged it. */
export interface BlockedSuperseded { reason: "later_request" | "acknowledged"; proposalId: string | null; by: string; at: number }

/** A proposal as the overview returns it. `superseded` is derived on read and never stored. */
export type MoneyProposalView = MoneyProposal & { superseded?: BlockedSuperseded };

export type LockCode =
  | "OWNER_INSUFFICIENT_FUNDS" | "FUNDS_NOT_CLEARED" | "MISSING_EVIDENCE" | "SELF_APPROVAL"
  | "RECONCILIATION_MISMATCH" | "AMOUNT_INTEGRITY" | "STATE"
  // Trust rules L8–L11
  | "COMMINGLING" | "FEE_NOT_EARNED" | "DISPUTED_FUNDS" | "SETTLEMENT_MISMATCH";

export type LockRule = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "L8" | "L9" | "L10" | "L11";

export interface LockFailure { rule: LockRule; code: LockCode; message: string; sourceIds: string[] }

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
