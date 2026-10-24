import type { NormalizedAccountBundle, NormalizedBankTransaction, NormalizedDocument, NormalizedOwner, RawPointer } from "@mangekyo/contracts";
import { namedOwners } from "../src/intake/erp";

/**
 * DEMO fixture for scenarios the sandbox ERP cannot show (see docs/erp-data-notes.md).
 * Every ID starts with "demo:" and every name with "DEMO". Fabricated, synthetic, and labelled as such.
 */
export const DEMO_ACCOUNT_ID = "demo:account:pool-001";
const DATASET = "demo-money-fixture-v1";
const OPENING_AS_OF = Date.UTC(2026, 9, 1);
const raw = (recordType: string, rawId: string): RawPointer => ({ system: "demo", recordType, rawId, datasetVersion: DATASET });

export const demoIds = {
  alpha: "demo:owner:alpha", xavier: "demo:owner:xavier", delta: "demo:owner:delta", yankee: "demo:owner:yankee",
  depositA: "demo:bank:txn:A-001", depositB: "demo:bank:txn:B-001", depositD: "demo:bank:txn:D-001",
  unrecordedOutflow: "demo:bank:txn:E-001",
};

const owner = (key: string, name: string): NormalizedOwner => ({
  sourceId: `demo:owner-record:${key}`, ownerId: `demo:owner:${key}`, accountId: DEMO_ACCOUNT_ID, subAccount: "DEMO-POOL", name, raw: raw("owner", key),
});

const owners = [
  owner("alpha", "DEMO Alpha Holdings Trust"),
  owner("xavier", "DEMO Owner X — Xavier Trust"),
  owner("delta", "DEMO Owner D — Delta Trust"),
  owner("yankee", "DEMO Owner Y — Yankee Trust"),
];

function doc(key: string, documentType: string, title: string, lines: string[]): NormalizedDocument {
  const text = [title, ...lines].join("\n");
  return { sourceId: `demo:document:${key}:v1`, accountId: DEMO_ACCOUNT_ID, documentType, title, version: "v1", text, excerpt: lines.join("; "), namedOwnerSourceIds: namedOwners(text, owners), raw: raw("document", key) };
}

const documents = [
  doc("remit-a-001", "Remittance advice", "DEMO remittance advice for DEMO-INV-A-1001", ["Beneficial owner: DEMO Alpha Holdings Trust", "Payer: DEMO Alpha Payer LLC", "Amount: $1,500.00", "Reference: DEMO-INV-A-1001"]),
  doc("note-b-001", "Bank memo", "DEMO bank memo for TRANSFER 4471", ["Memo: payment for the trust, see email", "Payer: DEMO J SMITH", "Amount: $980.00"]),
  doc("agreement-alpha", "Client agreement", "DEMO Alpha servicing agreement", ["Client: DEMO Alpha Holdings Trust", "Disbursements: on written instruction from the client"]),
  doc("instruction-x-001", "Payment instruction", "DEMO payment instruction from DEMO Owner X — Xavier Trust", ["Pay: DEMO Vendor Xylo Ltd", "Amount: $5,000.00", "Purpose: annual property tax"]),
  doc("instruction-d-001", "Payment instruction", "DEMO payment instruction from DEMO Owner D — Delta Trust", ["Pay: DEMO Vendor Delta Repairs", "Amount: $2,000.00", "Purpose: roof repair"]),
  doc("instruction-y-001", "Payment instruction", "DEMO payment instruction from DEMO Owner Y — Yankee Trust", ["Pay: DEMO Vendor Yankee Movers", "Amount: $1,000.00", "Purpose: relocation"]),
];

function txn(id: string, fields: Omit<NormalizedBankTransaction, "sourceId" | "accountId" | "subAccount" | "currency" | "raw" | "duplicateOfSourceId">): NormalizedBankTransaction {
  return { sourceId: `demo:bank:txn:${id}`, accountId: DEMO_ACCOUNT_ID, subAccount: "DEMO-POOL", currency: "USD", duplicateOfSourceId: null, raw: raw("bank-transaction", id), ...fields };
}

const pad = (run: number) => String(run).padStart(3, "0");
export const demoAccountId = (run: number) => `demo:account:pool-${pad(run)}`;

/** Run number of a DEMO pooled account ID, or null for anything else. */
export function demoRunOf(accountId: string): number | null {
  const match = /^demo:account:pool-(\d{3,})$/.exec(accountId);
  return match ? Number(match[1]) : null;
}

/** Run 1 keeps the original IDs; later runs namespace every demo: ID so no row of an earlier run is touched. */
function forRun<T>(value: T, run: number): T {
  if (run === 1) return value;
  const map = (item: unknown): unknown => {
    if (typeof item === "string") return item === DEMO_ACCOUNT_ID ? demoAccountId(run) : item.startsWith("demo:") ? `demo:run-${pad(run)}:${item.slice(5)}` : item;
    if (Array.isArray(item)) return item.map(map);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, map(v)]));
    return item;
  };
  return map(value) as T;
}

function runFor(accountId: string): number {
  const run = demoRunOf(accountId);
  if (run === null) throw new Error(`${accountId} is not a DEMO pooled account`);
  return run;
}

/** Maps fixture IDs ("demo:...") into the namespace of the DEMO run that owns accountId. */
export function forDemoAccount<T>(value: T, accountId: string): T {
  return forRun(value, runFor(accountId));
}

export function demoMoneyBundle(run = 1): NormalizedAccountBundle {
  const bundle = forRun(baseDemoBundle(), run);
  return run === 1 ? bundle : { ...bundle, account: { ...bundle.account, name: `${bundle.account.name} (run ${pad(run)})` } };
}

function baseDemoBundle(): NormalizedAccountBundle {
  return {
    account: { accountId: DEMO_ACCOUNT_ID, sourceId: DEMO_ACCOUNT_ID, name: "DEMO pooled client account", currency: "USD", openingAsOf: OPENING_AS_OF, synthetic: true, raw: raw("account", "pool-001") },
    owners,
    bankTransactions: [
      txn("D-001", { direction: "inflow", amountCents: 250_000, bookedAt: Date.UTC(2026, 8, 29), clearing: "pending", reference: "DEMO-DELTA-CHQ-88", counterparty: "DEMO Delta Tenant", ownerHintSourceId: "demo:owner-record:delta", documentSourceIds: [] }),
      txn("A-001", { direction: "inflow", amountCents: 150_000, bookedAt: Date.UTC(2026, 9, 20), clearing: "cleared", reference: "DEMO-INV-A-1001", counterparty: "DEMO Alpha Payer LLC", ownerHintSourceId: null, documentSourceIds: ["demo:document:remit-a-001:v1"] }),
      txn("B-001", { direction: "inflow", amountCents: 98_000, bookedAt: Date.UTC(2026, 9, 21), clearing: "cleared", reference: "TRANSFER 4471", counterparty: "DEMO J SMITH", ownerHintSourceId: null, documentSourceIds: ["demo:document:note-b-001:v1"] }),
    ],
    obligations: [
      { sourceId: "demo:invoice:INV-A-1001", accountId: DEMO_ACCOUNT_ID, kind: "invoice", ownerSourceId: "demo:owner-record:alpha", amountCents: 150_000, currency: "USD", reference: "DEMO-INV-A-1001", status: "open", excerpt: "DEMO invoice DEMO-INV-A-1001 for DEMO Alpha Holdings Trust: $1,500.00, open", raw: raw("invoice", "INV-A-1001") },
    ],
    documents,
    // Opening statement equals opening owner balances; D-001 is pending and inside the bank ledger balance.
    statementBalances: [{ sourceId: "demo:bank-statement:pool-001", accountId: DEMO_ACCOUNT_ID, amountCents: 26_812_000, asOf: OPENING_AS_OF, raw: raw("bank-statement", "2026-10-01") }],
    reconcilingItems: [],
    openingBalances: [
      { sourceId: "demo:opening:alpha", accountId: DEMO_ACCOUNT_ID, ownerId: demoIds.alpha, amountCents: 25_000_000, clearedCents: 25_000_000, asOf: OPENING_AS_OF, bankSourceId: null, raw: raw("opening", "alpha") },
      { sourceId: "demo:opening:xavier", accountId: DEMO_ACCOUNT_ID, ownerId: demoIds.xavier, amountCents: 12_000, clearedCents: 12_000, asOf: OPENING_AS_OF, bankSourceId: null, raw: raw("opening", "xavier") },
      { sourceId: "demo:opening:delta", accountId: DEMO_ACCOUNT_ID, ownerId: demoIds.delta, amountCents: 50_000, clearedCents: 50_000, asOf: OPENING_AS_OF, bankSourceId: null, raw: raw("opening", "delta") },
      { sourceId: "demo:opening:delta-pending", accountId: DEMO_ACCOUNT_ID, ownerId: demoIds.delta, amountCents: 250_000, clearedCents: 0, asOf: OPENING_AS_OF, bankSourceId: demoIds.depositD, raw: raw("opening", "delta-pending") },
      { sourceId: "demo:opening:yankee", accountId: DEMO_ACCOUNT_ID, ownerId: demoIds.yankee, amountCents: 1_500_000, clearedCents: 1_500_000, asOf: OPENING_AS_OF, bankSourceId: null, raw: raw("opening", "yankee") },
    ],
    issues: [],
  };
}

/** Scenario E: an outflow on the bank feed that nobody recorded in the ledger. */
export function demoUnrecordedOutflow(bookedAt: number, accountId = DEMO_ACCOUNT_ID): NormalizedBankTransaction {
  return forRun(txn("E-001", { direction: "outflow", amountCents: 200_000, bookedAt, clearing: "cleared", reference: "DEMO-WIRE-Y-9001", counterparty: "DEMO Vendor Yankee Movers", ownerHintSourceId: "demo:owner-record:yankee", documentSourceIds: [] }), runFor(accountId));
}

/** Simulated bank settlement of a posted payment, carrying the reference the ledger entry expects. */
export function demoSettlement(proposalId: string, amountCents: number, bookedAt: number, ownerSourceId: string | null, accountId = DEMO_ACCOUNT_ID): NormalizedBankTransaction {
  const settlement = forRun(txn(`SETTLE-${proposalId.replace(/[^A-Za-z0-9-]/g, "-")}`, { direction: "outflow", amountCents, bookedAt, clearing: "cleared", reference: "", counterparty: "DEMO simulated payee bank", ownerHintSourceId: null, documentSourceIds: [] }), runFor(accountId));
  return { ...settlement, reference: `PAY:${proposalId}`, ownerHintSourceId: ownerSourceId };
}
