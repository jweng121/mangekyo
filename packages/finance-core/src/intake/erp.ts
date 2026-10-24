import type {
  NormalizedAccountBundle, NormalizedBankTransaction, NormalizedDocument, NormalizedObligation,
  NormalizedOwner, OpeningBalance, RawPointer,
} from "@mangekyo/contracts";
import { dollarsToCents, formatCents, IntakeError, utcDate } from "./cents";

/** Structural view of the sandbox ERP state (apps/demo-erp/data/seed.ts). Read-only. */
export interface ErpState {
  seed: number;
  companies: Array<{ id: string; name: string; client: string; account: string; status: string }>;
  transactions: Array<{ id: string; date: string; amount: number; currency: string; account: string; reference: string; sender: string; recipient: string; clearing: string; reconciliation: string; documentId: string; duplicateOf?: string }>;
  invoices: Array<{ id: string; companyId: string; client: string; amount: number; reference: string; status: string }>;
  documents: Array<{ id: string; version: number; type: string; title: string; sections: Array<{ id: string; company: string; fields: Array<{ id: string; label: string; value: string }> }> }>;
  ledgers: Array<{ owner: string; account: string; opening: number; debits: number; credits: number; closing: number; cleared: number }>;
  activity: Array<{ id: string; at: string; kind: string; action: string; detail: string }>;
  bankBalance: number;
  timingAdjustments: number;
  cashBook: number;
  suspenseBalance: number;
}

export const ERP_ACCOUNT_ID = "erp:account:trust-pool";

export const erpIds = {
  owner: (companyId: string) => `erp:owner:${companyId}`,
  company: (companyId: string) => `erp:company:${companyId}`,
  bankTxn: (transactionId: string) => `bank:txn:${transactionId}`,
  invoice: (invoiceId: string) => `erp:invoice:${invoiceId}`,
  document: (documentId: string, version: number) => `erp:document:${documentId}:v${version}`,
  ledger: (companyId: string) => `erp:ledger:${companyId}`,
  statement: () => "erp:bank-statement:trust-pool",
  timing: () => "erp:timing-adjustment:trust-pool",
};

export interface ErpImportOptions {
  /**
   * Deposits making up suspenseBalance. The ERP data does not list them; the default comes from
   * the hard-coded suspense check in apps/demo-erp/lib/financial-controls.ts post().
   */
  suspenseTransactionIds?: string[];
}

function documentText(doc: ErpState["documents"][number]): string {
  const lines = doc.sections.flatMap(section => section.fields.map(field => `[${section.company}] ${field.label}: ${field.value}`));
  return [doc.title, ...lines].join("\n");
}

export function namedOwners(text: string, owners: NormalizedOwner[]): string[] {
  return owners.filter(owner => text.includes(owner.name)).map(owner => owner.sourceId).sort();
}

/** Pure, deterministic ERP → normalized records. Same state in, same sourceIds and values out. */
export function normalizeErpState(state: ErpState, options: ErpImportOptions = {}): NormalizedAccountBundle {
  const datasetVersion = `demo-erp-seed-${state.seed}`;
  const raw = (recordType: string, rawId: string, system: RawPointer["system"] = "erp"): RawPointer => ({ system, recordType, rawId, datasetVersion });
  const issues: NormalizedAccountBundle["issues"] = [];
  const attempt = <T>(rawId: string, build: () => T): T | null => {
    try { return build(); } catch (error) {
      issues.push({ rawId, reason: error instanceof Error ? error.message : "Unrepresentable record" });
      return null;
    }
  };

  const seeded = state.activity.find(row => row.action === "Seeded");
  const openingAsOf = seeded ? Date.parse(seeded.at) : NaN;
  if (!Number.isFinite(openingAsOf)) throw new IntakeError("activity", "ERP state has no Seeded activity timestamp to anchor opening balances");
  const currencies = new Set(state.transactions.map(row => row.currency));
  if (currencies.size > 1) issues.push({ rawId: "transactions", reason: "Multiple currencies in one pooled account; only USD records are imported" });
  const currency = "USD";

  const owners: NormalizedOwner[] = state.companies.map(company => ({
    sourceId: erpIds.company(company.id), ownerId: erpIds.owner(company.id), accountId: ERP_ACCOUNT_ID,
    subAccount: company.account, name: company.client, raw: raw("company", company.id),
  }));
  const ownerByName = new Map(owners.map(owner => [owner.name, owner]));

  const documents: NormalizedDocument[] = state.documents.map(doc => {
    const text = documentText(doc);
    return {
      sourceId: erpIds.document(doc.id, doc.version), accountId: ERP_ACCOUNT_ID, documentType: doc.type, title: doc.title,
      version: `v${doc.version}`, text, excerpt: text.split("\n").slice(1).join("; ").slice(0, 500),
      namedOwnerSourceIds: namedOwners(text, owners), raw: raw("document", doc.id),
    };
  });
  const documentById = new Map(state.documents.map((doc, index) => [doc.id, documents[index]]));

  const bankTransactions = state.transactions.flatMap((row): NormalizedBankTransaction[] => {
    const normalized = attempt(row.id, (): NormalizedBankTransaction => {
      if (row.currency !== currency) throw new IntakeError(row.id, `Unsupported currency ${row.currency}`);
      const signed = dollarsToCents(row.amount, row.id);
      if (signed === 0) throw new IntakeError(row.id, "Zero-amount bank transaction");
      if (row.clearing !== "Cleared" && row.clearing !== "Pending") throw new IntakeError(row.id, `Unknown clearing status ${row.clearing}`);
      const doc = documentById.get(row.documentId);
      if (!doc) issues.push({ rawId: row.id, reason: `Referenced document ${row.documentId} is not in the ERP data` });
      return {
        sourceId: erpIds.bankTxn(row.id), accountId: ERP_ACCOUNT_ID, subAccount: row.account,
        direction: signed > 0 ? "inflow" : "outflow", amountCents: Math.abs(signed), currency,
        bookedAt: utcDate(row.date, row.id), clearing: row.clearing === "Cleared" ? "cleared" : "pending",
        reference: row.reference, counterparty: row.sender, ownerHintSourceId: ownerByName.get(row.recipient)?.sourceId ?? null,
        documentSourceIds: doc ? [doc.sourceId] : [], duplicateOfSourceId: row.duplicateOf ? erpIds.bankTxn(row.duplicateOf) : null,
        raw: raw("transaction", row.id, "bank"),
      };
    });
    return normalized ? [normalized] : [];
  });

  const obligations = state.invoices.flatMap((row): NormalizedObligation[] => {
    const normalized = attempt(row.id, (): NormalizedObligation => {
      const amountCents = dollarsToCents(row.amount, row.id);
      const owner = owners.find(candidate => candidate.raw.rawId === row.companyId);
      if (!owner) throw new IntakeError(row.id, `Invoice company ${row.companyId} is unknown`);
      return {
        sourceId: erpIds.invoice(row.id), accountId: ERP_ACCOUNT_ID, kind: "invoice", ownerSourceId: owner.sourceId,
        amountCents, currency, reference: row.reference, status: row.status.toLowerCase(),
        excerpt: `Invoice ${row.id} ${row.reference} for ${row.client}: ${formatCents(amountCents)}, ${row.status}`,
        raw: raw("invoice", row.id),
      };
    });
    return normalized ? [normalized] : [];
  });

  const openingBalances: OpeningBalance[] = [];
  for (const ledger of state.ledgers) {
    const opening = attempt(`ledger:${ledger.owner}`, (): OpeningBalance => {
      const owner = ownerByName.get(ledger.owner);
      if (!owner) throw new IntakeError(ledger.owner, "Ledger owner does not match any company client");
      const amountCents = dollarsToCents(ledger.closing, ledger.owner);
      const clearedCents = dollarsToCents(ledger.cleared, ledger.owner);
      if (clearedCents < 0 || clearedCents > amountCents) throw new IntakeError(ledger.owner, "Cleared balance must be between zero and the closing balance");
      return {
        sourceId: erpIds.ledger(owner.raw.rawId), accountId: ERP_ACCOUNT_ID, ownerId: owner.ownerId,
        amountCents, clearedCents, asOf: openingAsOf, bankSourceId: null, raw: raw("ledger", ledger.owner),
      };
    });
    if (opening) openingBalances.push(opening);
  }

  const suspenseIds = options.suspenseTransactionIds ?? ["TX-001", "TX-002"];
  const suspenseCents = attempt("suspenseBalance", () => dollarsToCents(state.suspenseBalance, "suspenseBalance"));
  const suspenseTxns = suspenseIds.map(id => bankTransactions.find(row => row.raw.rawId === id));
  const suspenseTotal = suspenseTxns.reduce((sum, row) => sum + (row?.direction === "inflow" ? row.amountCents : NaN), 0);
  if (suspenseCents !== null && suspenseTotal === suspenseCents) {
    for (const txn of suspenseTxns as NormalizedBankTransaction[]) {
      openingBalances.push({
        sourceId: txn.sourceId, accountId: ERP_ACCOUNT_ID, ownerId: null, amountCents: txn.amountCents,
        clearedCents: 0, asOf: txn.bookedAt, bankSourceId: txn.sourceId, raw: raw("suspense", txn.raw.rawId),
      });
    }
  } else if (suspenseCents !== null && suspenseCents !== 0) {
    issues.push({ rawId: "suspenseBalance", reason: `Suspense ${formatCents(suspenseCents)} does not equal named deposits ${suspenseIds.join(", ")}; unallocated deposits were not imported` });
  }

  const statement = attempt("bankBalance", () => dollarsToCents(state.bankBalance, "bankBalance"));
  const timing = attempt("timingAdjustments", () => dollarsToCents(state.timingAdjustments, "timingAdjustments"));
  return {
    account: { accountId: ERP_ACCOUNT_ID, sourceId: ERP_ACCOUNT_ID, name: "Sandbox ERP pooled trust accounts (TRUST-01 + TRUST-02)", currency, openingAsOf, synthetic: true, raw: raw("state", `seed-${state.seed}`) },
    owners, bankTransactions, obligations, documents,
    statementBalances: statement === null ? [] : [{ sourceId: erpIds.statement(), accountId: ERP_ACCOUNT_ID, amountCents: statement, asOf: openingAsOf, raw: raw("bankBalance", "bankBalance", "bank") }],
    reconcilingItems: timing ? [{ sourceId: erpIds.timing(), accountId: ERP_ACCOUNT_ID, appliesTo: "bank", amountCents: timing, description: "ERP timingAdjustments figure; the source supplies no line-item detail", detailed: false, raw: raw("timingAdjustments", "timingAdjustments") }] : [],
    openingBalances, issues,
  };
}
