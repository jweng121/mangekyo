import type { NormalizedAccountBundle, NormalizedDocument, NormalizedOwner, RawPointer } from "@mangekyo/contracts";
import { DEMO_ACCOUNT_ID, forDemoAccount, demoRunOf } from "./demoMoney";

const AS_OF = Date.UTC(2026, 9, 1);
const raw = (recordType: string, rawId: string): RawPointer => ({ system: "demo", recordType, rawId, datasetVersion: "law-firm-demo-v1" });
const clients = [
  ["westbrook", "Westbrook HOA", 21_000_000],
  ["chen-park", "Chen & Park Holdings", 12_000_000],
  ["linh-nguyen", "Linh Nguyen", 350_000],
  ["james-nguyen", "James Nguyen", 420_000],
  ["raymond-cho", "Raymond Hayes", 27_000_000],
  ["maria-delgado", "Maria Delgado", 0],
] as const;

/** The firm's own money, kept as a separate owner so the lock can flag it (L8) and fees can be paid to it (L9). Opens at zero. */
export const FIRM_OWNER: NormalizedOwner = { sourceId: "demo:owner-record:firm", ownerId: "demo:owner:firm", accountId: DEMO_ACCOUNT_ID, subAccount: "IOLTA", name: "Hartwell & Moreno LLP operating account", ownerKind: "firm", raw: raw("owner", "firm") };
export const DELGADO_MATTER = "matter:delgado-v-ridgeway";
export const DELGADO_STATEMENT = "demo:document:delgado-settlement-statement:v1";
export const DELGADO_FEE_AGREEMENT = "demo:document:delgado-fee-agreement:v1";

/** Fictional sources in the existing finance contract. No ERP generator or old fixture is changed. */
export function lawFirmBundle(accountId = DEMO_ACCOUNT_ID): NormalizedAccountBundle {
  const owners: NormalizedOwner[] = [...clients.map(([key, name]) => ({ sourceId: `demo:owner-record:${key}`, ownerId: `demo:owner:${key}`, accountId: DEMO_ACCOUNT_ID, subAccount: "IOLTA", name, raw: raw("owner", key) })), FIRM_OWNER];
  const document = (key: string, documentType: string, title: string, text: string, extra: Partial<NormalizedDocument> = {}): NormalizedDocument => ({
    sourceId: `demo:document:${key}:v1`, accountId: DEMO_ACCOUNT_ID, documentType, title, text, excerpt: text, version: "v1",
    namedOwnerSourceIds: owners.filter(owner => text.includes(owner.name)).map(owner => owner.sourceId), raw: raw("document", key), ...extra,
  });
  return forDemoAccount({
    account: { accountId: DEMO_ACCOUNT_ID, sourceId: DEMO_ACCOUNT_ID, name: `Hartwell & Moreno LLP client trust account (IOLTA) (run ${String(demoRunOf(accountId)).padStart(3, "0")})`, currency: "USD", openingAsOf: AS_OF, synthetic: true, raw: raw("account", "law-firm") },
    owners, bankTransactions: [], obligations: [], reconcilingItems: [], issues: [],
    documents: [
      document("delgado-settlement", "Settlement agreement", "Delgado v. Ridgeway Logistics settlement agreement", "Maria Delgado receives an $85,000.00 settlement from Harborline Insurance, claim HL-44812. Client share: $56,000.00.", { signed: true, matterId: DELGADO_MATTER }),
      // Signed settlement statement: the only document a payout may rest on. Lines are structured so the lock compares payouts exactly (L11) and the fee against the fee agreement (L9).
      document("delgado-settlement-statement", "Settlement statement", "Delgado v. Ridgeway Logistics settlement statement", "Settlement statement for Maria Delgado, matter Delgado v. Ridgeway Logistics. Gross settlement from Harborline Insurance, claim HL-44812: $85,000.00. Attorney fee (33%): $28,050.00. Costs advanced: $950.00. Net to client Maria Delgado: $56,000.00. Signed by Maria Delgado and the responsible attorney.", {
        signed: true, matterId: DELGADO_MATTER,
        lines: [
          { kind: "attorney_fee", label: "Attorney fee (33%)", amountCents: 2_805_000, payeeOwnerSourceId: FIRM_OWNER.sourceId },
          { kind: "costs", label: "Costs advanced", amountCents: 95_000, payeeOwnerSourceId: FIRM_OWNER.sourceId },
          { kind: "client_share", label: "Net to client Maria Delgado", amountCents: 5_600_000, payeeOwnerSourceId: null },
        ],
      }),
      document("delgado-fee-agreement", "Fee agreement", "Maria Delgado contingency fee agreement", "Maria Delgado agrees to a contingency fee of 33% of any gross recovery in Delgado v. Ridgeway Logistics, plus reimbursement of costs advanced. Signed by Maria Delgado.", { signed: true, matterId: DELGADO_MATTER, feeBasisPoints: 3300 }),
      document("okafor-engagement", "Engagement letter", "Daniel Okafor engagement letter", "New client Daniel Okafor. Estate matter. Retainer: $5,000.00."),
      document("bayview-escrow", "Escrow instruction", "Bayview Title escrow instruction ESC-2291", "Bayview Title will send $40,000.00 for Chen & Park Holdings under escrow instruction ESC-2291."),
      document("cho-expert", "Expert witness invoice", "Raymond Hayes expert witness invoice", "Expert witness services for Raymond Hayes's contract case: $900,000.00."),
      document("westbrook-settlement", "Settlement letter", "Harborline settlement letter HL-50210", "Harborline Insurance settlement for Westbrook HOA, claim HL-50210: $18,000.00."),
    ],
    statementBalances: [{ sourceId: "demo:bank-statement:law-firm", accountId: DEMO_ACCOUNT_ID, amountCents: 60_770_000, asOf: AS_OF, raw: raw("bank-statement", "opening") }],
    openingBalances: clients.map(([key, , amountCents]) => ({ sourceId: `demo:opening:${key}`, accountId: DEMO_ACCOUNT_ID, ownerId: `demo:owner:${key}`, amountCents, clearedCents: amountCents, asOf: AS_OF, bankSourceId: null, raw: raw("opening", key) })),
  }, accountId);
}
