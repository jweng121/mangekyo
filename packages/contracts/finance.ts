/** Domain IDs are stable strings, independent of Convex document IDs. Amounts are integer cents. */
export interface SyntheticRecord {
  synthetic: true;
  caseId: string;
}

export interface FinanceCase extends SyntheticRecord {
  taskId: string;
  runId: string;
  createdAt: number;
  label: string;
}

export interface FinanceOwner extends SyntheticRecord {
  ownerId: string;
  name: string;
}

export interface FinanceTransaction extends SyntheticRecord {
  transactionId: string;
  sourceId: string;
  amountCents: number;
  currency: "USD";
  direction: "deposit";
  bankStatus: "cleared";
  allocationStatus: "unallocated";
  clearedAt: number;
  description: string;
}

export interface FinanceDocument extends SyntheticRecord {
  documentId: string;
  sourceId: string;
  title: string;
  mimeType: "text/plain";
  text: string;
  excerpt: string;
}

export interface EvidenceReference {
  sourceId: string;
  documentId: string;
  excerpt: string;
}

export interface FinanceTask extends SyntheticRecord {
  taskId: string;
  runId: string;
  transactionId: string;
  /** Investigation candidate only; does not establish ownership of the deposit. */
  candidateOwnerId: string;
  evidenceRefs: EvidenceReference[];
  status: "awaiting_investigation" | "investigating" | "needs_information" | "review_required" | "investigation_completed" | "investigation_failed" | "checker_rejected";
  activeRunId?: string;
  createdAt: number;
  /** Present on tasks created from the money source adapter. */
  accountId?: string;
  bankSourceId?: string;
}

export interface FinanceCaseBundle {
  case: FinanceCase;
  owner: FinanceOwner;
  transaction: FinanceTransaction;
  document: FinanceDocument;
  task: FinanceTask;
}
