import type { NormalizedAccountBundle, NormalizedBankTransaction, NormalizedDocument, NormalizedObligation, RawPointer } from "@mangekyo/contracts";
import { demoMoneyBundle, demoRunOf, forDemoAccount } from "./demoMoney";
import { namedOwners } from "../src/intake/erp";

/**
 * DEMO live feed: a scripted, repeatable sequence of bank activity for one DEMO run, imported through the
 * normal import path. Mock mode only. Same order and same records every time; only bookedAt is "now".
 */
const raw = (recordType: string, rawId: string): RawPointer => ({ system: "demo", recordType, rawId, datasetVersion: "demo-live-feed-v1" });
const ACCOUNT = "demo:account:pool-001";
const POOL = "DEMO-POOL";

function txn(id: string, amountCents: number, reference: string, counterparty: string, bookedAt: number, documentSourceIds: string[] = [], duplicateOfSourceId: string | null = null): NormalizedBankTransaction {
  return { sourceId: `demo:bank:txn:${id}`, accountId: ACCOUNT, subAccount: POOL, direction: "inflow", amountCents, currency: "USD", bookedAt, clearing: "cleared", reference, counterparty, ownerHintSourceId: null, documentSourceIds, duplicateOfSourceId, raw: raw("bank-transaction", id) };
}
function invoice(ref: string, ownerKey: string, ownerName: string, amountCents: number, dollars: string): NormalizedObligation {
  return { sourceId: `demo:invoice:${ref}`, accountId: ACCOUNT, kind: "invoice", ownerSourceId: `demo:owner-record:${ownerKey}`, amountCents, currency: "USD", reference: ref, status: "open", excerpt: `DEMO invoice ${ref} for ${ownerName}: ${dollars}, open`, raw: raw("invoice", ref) };
}
function doc(key: string, title: string, lines: string[], documentType: string): NormalizedDocument {
  const text = [title, ...lines].join("\n");
  const owners = demoMoneyBundle().owners;
  return { sourceId: `demo:document:${key}:v1`, accountId: ACCOUNT, documentType, title, version: "v1", text, excerpt: lines.join("; "), namedOwnerSourceIds: namedOwners(text, owners), raw: raw("document", key) };
}

export type FeedStep =
  | { kind: "import"; label: string; marker: string; bankTransactions: NormalizedBankTransaction[]; documents: NormalizedDocument[]; obligations: NormalizedObligation[] }
  | { kind: "payment"; label: string; marker: string; ownerId: string; amountCents: number; purpose: string; evidenceSourceIds: string[] };

export const FEED_PAYMENT_PURPOSE = "Live feed: scripted payment request";

function baseSteps(now: number): FeedStep[] {
  return [
    { kind: "import", label: "A clear deposit with a remittance naming its owner", marker: "demo:bank:txn:F-001",
      bankTransactions: [txn("F-001", 220_000, "DEMO-REMIT-Y-55", "DEMO Yankee Payer Co", now, ["demo:document:remit-f-001:v1"])],
      documents: [doc("remit-f-001", "DEMO remittance advice DEMO-REMIT-Y-55", ["Beneficial owner: DEMO Owner Y — Yankee Trust", "Amount: $2,200.00", "Reference: DEMO-REMIT-Y-55"], "Remittance advice")], obligations: [] },
    { kind: "import", label: "A partial payment of an open invoice", marker: "demo:bank:txn:F-002",
      bankTransactions: [txn("F-002", 75_000, "DEMO-INV-A-2002", "DEMO Alpha Payer LLC", now)], documents: [],
      obligations: [invoice("DEMO-INV-A-2002", "alpha", "DEMO Alpha Holdings Trust", 150_000, "$1,500.00")] },
    { kind: "import", label: "A deposit matching an open invoice exactly", marker: "demo:bank:txn:F-003",
      bankTransactions: [txn("F-003", 120_000, "DEMO-INV-Y-3003", "DEMO Yankee Payer Co", now)], documents: [],
      obligations: [invoice("DEMO-INV-Y-3003", "yankee", "DEMO Owner Y — Yankee Trust", 120_000, "$1,200.00")] },
    { kind: "import", label: "Two deposits sharing one reference", marker: "demo:bank:txn:F-005",
      bankTransactions: [txn("F-004", 30_000, "DEMO-DUP-77", "DEMO Delta Tenant", now), txn("F-005", 30_000, "DEMO-DUP-77", "DEMO Delta Tenant", now, [], "demo:bank:txn:F-004")], documents: [], obligations: [] },
    { kind: "import", label: "An unclear deposit with only a vague memo", marker: "demo:bank:txn:F-006",
      bankTransactions: [txn("F-006", 61_500, "TRANSFER 5521", "DEMO J SMITH", now, ["demo:document:memo-f-006:v1"])],
      documents: [doc("memo-f-006", "DEMO bank memo for TRANSFER 5521", ["Memo: rent, see email", "Payer: DEMO J SMITH", "Amount: $615.00"], "Bank memo")], obligations: [] },
    { kind: "import", label: "A second exact invoice match, where an approved policy applies", marker: "demo:bank:txn:F-007",
      bankTransactions: [txn("F-007", 64_000, "DEMO-INV-X-4004", "DEMO Xavier Payer Inc", now)], documents: [],
      obligations: [invoice("DEMO-INV-X-4004", "xavier", "DEMO Owner X — Xavier Trust", 64_000, "$640.00")] },
    { kind: "payment", label: "A payment request the lock blocks", marker: FEED_PAYMENT_PURPOSE, ownerId: "demo:owner:xavier", amountCents: 500_000, purpose: FEED_PAYMENT_PURPOSE, evidenceSourceIds: ["demo:document:instruction-x-001:v1"] },
  ];
}

export const FEED_LENGTH = 7;

/** Step `index` (0-based) for the DEMO run that owns accountId, with every ID in that run's namespace. */
export function demoFeedStep(index: number, accountId: string, now: number): FeedStep | null {
  if (demoRunOf(accountId) === null) throw new Error(`${accountId} is not a DEMO pooled account`);
  const step = baseSteps(now)[index];
  if (!step) return null;
  const mapped = forDemoAccount(step, accountId);
  return mapped.kind === "payment" ? { ...mapped, marker: FEED_PAYMENT_PURPOSE, purpose: FEED_PAYMENT_PURPOSE } : mapped;
}

/** A partial bundle for the normal import path: only the new feed records plus the run's account. */
export function feedBundle(step: Extract<FeedStep, { kind: "import" }>, accountId: string): NormalizedAccountBundle {
  const run = demoRunOf(accountId)!;
  return { account: demoMoneyBundle(run).account, owners: [], bankTransactions: step.bankTransactions, obligations: step.obligations, documents: step.documents, statementBalances: [], reconcilingItems: [], openingBalances: [], issues: [] };
}
