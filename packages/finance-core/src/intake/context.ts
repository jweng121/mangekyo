import type {
  FinanceRecordSet, InvestigationScope, LedgerEntry, NormalizedBankTransaction, NormalizedDocument,
  NormalizedObligation, ProposedAllocation,
} from "@mangekyo/contracts";
import { ownerBalances, type AccountLedgerState } from "../ledger";

export interface DepositContextInput {
  state: AccountLedgerState;
  documents: NormalizedDocument[];
  obligations: NormalizedObligation[];
  deposit: NormalizedBankTransaction;
  caseId: string;
  system: "erp" | "demo";
  datasetVersion: string;
  scope: InvestigationScope;
}

const LIMIT = 20;

export function depositCaseId(accountId: string): string {
  return `intake:${accountId}`;
}

/** Candidate owners: the record's own hint, owners named in linked documents, and owners of reference-matched obligations. */
export function candidateOwnerSourceIds(input: Pick<DepositContextInput, "deposit" | "documents" | "obligations" | "state">): string[] {
  const { deposit, documents, obligations, state } = input;
  const linked = documents.filter(doc => deposit.documentSourceIds.includes(doc.sourceId));
  const refMatched = obligations.filter(row => row.reference && deposit.reference.includes(row.reference));
  const ids = new Set<string>([
    ...(deposit.ownerHintSourceId ? [deposit.ownerHintSourceId] : []),
    ...linked.flatMap(doc => doc.namedOwnerSourceIds),
    ...refMatched.flatMap(row => row.ownerSourceId ? [row.ownerSourceId] : []),
  ]);
  if (ids.size === 0) for (const owner of state.owners.filter(o => o.subAccount === deposit.subAccount).slice(0, LIMIT)) ids.add(owner.sourceId);
  return [...ids].sort();
}

function existingAllocations(entries: LedgerEntry[], deposit: NormalizedBankTransaction): ProposedAllocation[] {
  const reversed = new Set(entries.flatMap(row => row.reversesEntryId ? [row.reversesEntryId] : []));
  return entries.filter(row => row.kind === "allocation" && row.ownerId !== null && row.fundsSourceId === deposit.sourceId && !reversed.has(row.entryId))
    .map(row => ({ proposalId: row.proposalId ?? row.entryId, transactionId: deposit.sourceId, ownerId: row.ownerId!, amountCents: row.amountCents, currency: row.currency, evidenceSourceIds: row.sourceRefs }));
}

/** Scoped finance-investigation-input/v1 records for one deposit. Only cleared deposits enter `transactions`. */
export function buildDepositRecordSet(input: DepositContextInput): FinanceRecordSet {
  const { state, deposit, scope, caseId } = input;
  const candidates = candidateOwnerSourceIds(input);
  const owners = state.owners.filter(o => candidates.includes(o.sourceId));
  const ownerIds = new Set(owners.map(o => o.ownerId));
  const linkedDocs = input.documents.filter(doc => deposit.documentSourceIds.includes(doc.sourceId));
  const candidateDocs = input.documents.filter(doc => !linkedDocs.includes(doc) && doc.namedOwnerSourceIds.some(id => candidates.includes(id)) && doc.documentType.toLowerCase().includes("agreement"));
  const documents = [...linkedDocs, ...candidateDocs].slice(0, LIMIT);
  const obligations = input.obligations.filter(row => (row.reference && deposit.reference.includes(row.reference)) || (row.ownerSourceId !== null && candidates.includes(row.ownerSourceId))).slice(0, LIMIT);
  const related = state.bankTransactions.filter(row => row.sourceId === deposit.sourceId || row.sourceId === deposit.duplicateOfSourceId || row.duplicateOfSourceId === deposit.sourceId || (row.reference === deposit.reference && row.sourceId !== deposit.sourceId)).slice(0, LIMIT);
  const recorded = state.entries.some(row => row.kind === "deposit_received" && row.fundsSourceId === deposit.sourceId);
  const inScope = deposit.bookedAt <= scope.cutoff && (scope.from === null || deposit.bookedAt >= scope.from);
  const balances = ownerBalances(state, scope.cutoff).filter(row => row.ownerId !== null && ownerIds.has(row.ownerId));

  const missingEvidence: string[] = [];
  if (deposit.clearing !== "cleared") missingEvidence.push(`Deposit ${deposit.sourceId} has not cleared; it is excluded from transactions until it does.`);
  if (!recorded) missingEvidence.push(`Deposit ${deposit.sourceId} has no deposit_received ledger entry, so allocation history cannot be checked.`);
  if (linkedDocs.length === 0) missingEvidence.push(`No supporting document is linked to ${deposit.sourceId} by the source system.`);
  for (const o of owners) {
    if (!input.documents.some(doc => doc.namedOwnerSourceIds.includes(o.sourceId) && doc.documentType.toLowerCase().includes("agreement"))) missingEvidence.push(`No client agreement on file names ${o.name}.`);
  }
  missingEvidence.push(`Opening balances are a cutover snapshot as of ${new Date(state.account.openingAsOf).toISOString()}; owner-level history before then is unavailable.`);
  if (candidates.length > 0 && !deposit.ownerHintSourceId && linkedDocs.every(doc => doc.namedOwnerSourceIds.length === 0)) missingEvidence.push("No source record names the beneficial owner; candidate owners are the account's owners, listed for questions only.");

  return {
    transactions: deposit.direction === "inflow" && deposit.clearing === "cleared" && inScope ? [{
      synthetic: true, caseId, transactionId: deposit.sourceId, sourceId: deposit.sourceId, amountCents: deposit.amountCents, currency: "USD",
      direction: "deposit", bankStatus: "cleared", allocationStatus: "unallocated", clearedAt: deposit.bookedAt,
      description: `${deposit.counterparty} · ${deposit.reference}`, accountId: state.account.accountId,
    }] : [],
    owners: owners.map(o => ({ synthetic: true, caseId, ownerId: o.ownerId, name: o.name })),
    documents: documents.map(doc => ({ synthetic: true, caseId, documentId: doc.raw.rawId, sourceId: doc.sourceId, title: doc.title, mimeType: "text/plain", text: doc.text, excerpt: doc.excerpt, version: doc.version, effectiveAt: null })),
    invoices: obligations.filter(row => row.kind === "invoice").map(row => ({ recordId: row.raw.rawId, sourceId: row.sourceId, version: row.raw.datasetVersion, excerpt: row.excerpt })),
    agreements: documents.filter(doc => doc.documentType.toLowerCase().includes("agreement")).map(doc => ({ recordId: doc.raw.rawId, sourceId: doc.sourceId, version: doc.version, excerpt: doc.excerpt })),
    bankBalance: null, controlBalance: null, ownerBalances: null, ownerBalancesComplete: false, timingDifferences: [],
    existingAllocations: existingAllocations(state.entries, deposit),
    allocationHistoryComplete: recorded,
    missingEvidence, coverage: "available_records_only",
    sourceAdapter: { system: input.system, datasetVersion: input.datasetVersion, accountId: state.account.accountId },
    bankTransactions: related, obligations,
    ownerLedgerBalances: balances.map(row => ({ ...row, ownerId: row.ownerId!, sourceId: `ledger:balance:${row.ownerId}@${scope.cutoff}`, cutoff: scope.cutoff })),
  };
}
