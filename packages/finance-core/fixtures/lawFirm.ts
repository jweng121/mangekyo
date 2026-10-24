import type { NormalizedAccountBundle, NormalizedDocument, RawPointer } from "@mangekyo/contracts";
import { DEMO_ACCOUNT_ID, forDemoAccount } from "./demoMoney";

const AS_OF = Date.UTC(2026, 9, 1);
const raw = (recordType: string, rawId: string): RawPointer => ({ system: "demo", recordType, rawId, datasetVersion: "law-firm-demo-v1" });
const clients = [
  ["westbrook", "Westbrook HOA", 21_000_000],
  ["chen-park", "Chen & Park Holdings", 12_000_000],
  ["linh-nguyen", "Linh Nguyen", 350_000],
  ["james-nguyen", "James Nguyen", 420_000],
  ["raymond-cho", "Raymond Cho", 180_000],
  ["maria-delgado", "Maria Delgado", 0],
] as const;

/** Fictional sources in the existing finance contract. No ERP generator or old fixture is changed. */
export function lawFirmBundle(accountId = DEMO_ACCOUNT_ID): NormalizedAccountBundle {
  const owners = clients.map(([key, name]) => ({ sourceId: `demo:owner-record:${key}`, ownerId: `demo:owner:${key}`, accountId: DEMO_ACCOUNT_ID, subAccount: "IOLTA", name, raw: raw("owner", key) }));
  const document = (key: string, documentType: string, title: string, text: string): NormalizedDocument => ({
    sourceId: `demo:document:${key}:v1`, accountId: DEMO_ACCOUNT_ID, documentType, title, text, excerpt: text, version: "v1",
    namedOwnerSourceIds: owners.filter(owner => text.includes(owner.name)).map(owner => owner.sourceId), raw: raw("document", key),
  });
  return forDemoAccount({
    account: { accountId: DEMO_ACCOUNT_ID, sourceId: DEMO_ACCOUNT_ID, name: "Hartwell & Moreno LLP client trust account (IOLTA)", currency: "USD", openingAsOf: AS_OF, synthetic: true, raw: raw("account", "law-firm") },
    owners, bankTransactions: [], obligations: [], reconcilingItems: [], issues: [],
    documents: [
      document("delgado-settlement", "Settlement agreement", "Delgado v. Ridgeway Logistics settlement agreement", "Maria Delgado receives an $85,000.00 settlement from Harborline Insurance, claim HL-44812. Client share: $56,000.00."),
      document("okafor-engagement", "Engagement letter", "Daniel Okafor engagement letter", "New client Daniel Okafor. Estate matter. Retainer: $5,000.00."),
      document("bayview-escrow", "Escrow instruction", "Bayview Title escrow instruction ESC-2291", "Bayview Title will send $40,000.00 for Chen & Park Holdings under escrow instruction ESC-2291."),
      document("cho-expert", "Expert witness invoice", "Raymond Cho expert witness invoice", "Expert witness services for Raymond Cho's contract case: $6,000.00."),
      document("westbrook-settlement", "Settlement letter", "Harborline settlement letter HL-50210", "Harborline Insurance settlement for Westbrook HOA, claim HL-50210: $18,000.00."),
    ],
    statementBalances: [{ sourceId: "demo:bank-statement:law-firm", accountId: DEMO_ACCOUNT_ID, amountCents: 33_950_000, asOf: AS_OF, raw: raw("bank-statement", "opening") }],
    openingBalances: clients.map(([key, , amountCents]) => ({ sourceId: `demo:opening:${key}`, accountId: DEMO_ACCOUNT_ID, ownerId: `demo:owner:${key}`, amountCents, clearedCents: amountCents, asOf: AS_OF, bankSourceId: null, raw: raw("opening", key) })),
  }, accountId);
}
