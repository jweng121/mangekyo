import type { NormalizedAccountBundle, NormalizedBankTransaction, RawPointer } from "@mangekyo/contracts";
import { DEMO_ACCOUNT_ID, forDemoAccount } from "./demoMoney";
import { DELGADO_STATEMENT, lawFirmBundle } from "./lawFirm";

export const LAW_FIRM_FEED_LENGTH = 10;
export const INSURANCE_POLICY = "Insurance checks that quote a claim number go to the client on that claim.";
/** The paralegal's fee transfer in step 10: no approved invoice, no settlement statement, so the lock blocks it (L9). */
export const PARALEGAL_FEE_PURPOSE = "Chen & Park fees to the firm (paralegal transfer, no invoice)";
export const PARALEGAL = "dev-unverified:priya";
const raw = (recordType: string, rawId: string): RawPointer => ({ system: "demo", recordType, rawId, datasetVersion: "law-firm-demo-v1" });
export const lawId = (accountId: string, suffix: string): string => forDemoAccount(`demo:${suffix}`, accountId);

export const lawFirmSteps = [
  "Harborline's $85,000.00 check arrives pending",
  "Disbursement prepares Delgado's three payout lines; the lock blocks them until the check clears",
  "Harborline's check clears; approve the allocation, then Disbursement prepares the payout again",
  "Daniel Okafor sends $2,500.00 toward his retainer",
  "J NGUYEN sends $1,200.00 with the memo case fees",
  "Two Bayview Title wires quote the same escrow instruction",
  "Riley requests $6,000.00 for Raymond Cho's expert witness",
  "The agent proposes an insurance claim-number policy",
  "Harborline sends $18,000.00 for Westbrook HOA",
  "A paralegal moves $3,000.00 of Chen & Park fees to the firm with no invoice",
] as const;

/** Only new source records, so advancing the feed never rewrites earlier financial history. */
export function lawFirmFeedBundle(step: number, accountId: string, now: number): NormalizedAccountBundle {
  const opening = lawFirmBundle();
  const bundle: NormalizedAccountBundle = { ...opening, owners: [], documents: [], bankTransactions: [], obligations: [], statementBalances: [], openingBalances: [], reconcilingItems: [] };
  const txn = (id: string, amountCents: number, counterparty: string, reference: string, documents: string | string[], clearing: "pending" | "cleared" = "cleared", duplicateOfSourceId: string | null = null): NormalizedBankTransaction => ({
    sourceId: `demo:bank:txn:${id}`, accountId: DEMO_ACCOUNT_ID, subAccount: "IOLTA", direction: "inflow", amountCents, currency: "USD", bookedAt: now,
    clearing, reference, counterparty, ownerHintSourceId: null, documentSourceIds: (Array.isArray(documents) ? documents : [documents]).map(d => d.startsWith("demo:") ? d : `demo:document:${d}:v1`), duplicateOfSourceId, raw: raw("bank-transaction", id),
  });
  // The settlement deposit links both the agreement (ownership) and the signed statement (payout lines).
  if (step === 1) bundle.bankTransactions = [txn("harborline-delgado", 8_500_000, "Harborline Insurance", "Claim HL-44812", ["delgado-settlement", DELGADO_STATEMENT], "pending")];
  if (step === 4) {
    bundle.owners = [{ sourceId: "demo:owner-record:daniel-okafor", ownerId: "demo:owner:daniel-okafor", accountId: DEMO_ACCOUNT_ID, subAccount: "IOLTA", name: "Daniel Okafor", raw: raw("owner", "daniel-okafor") }];
    bundle.documents = opening.documents.filter(d => d.sourceId === "demo:document:okafor-engagement:v1").map(d => ({ ...d, namedOwnerSourceIds: ["demo:owner-record:daniel-okafor"] }));
    bundle.bankTransactions = [txn("okafor-retainer", 250_000, "D OKAFOR", "Estate retainer", "okafor-engagement")];
  }
  if (step === 5) {
    bundle.bankTransactions = [txn("nguyen-zelle", 120_000, "J NGUYEN", "case fees", "nguyen-memo")];
    bundle.documents = [{ sourceId: "demo:document:nguyen-memo:v1", accountId: DEMO_ACCOUNT_ID, documentType: "Bank memo", title: "Zelle memo", text: "Payer: J NGUYEN. Memo: case fees. Amount: $1,200.00.", excerpt: "J NGUYEN: case fees", version: "v1", namedOwnerSourceIds: [], raw: raw("document", "nguyen-memo") }];
  }
  if (step === 6) bundle.bankTransactions = [txn("bayview-first", 4_000_000, "Bayview Title", "ESC-2291", "bayview-escrow"), txn("bayview-second", 4_000_000, "Bayview Title", "ESC-2291", "bayview-escrow", "cleared", "demo:bank:txn:bayview-first")];
  if (step === 9) bundle.bankTransactions = [txn("harborline-westbrook", 1_800_000, "Harborline Insurance", "Claim HL-50210", "westbrook-settlement")];
  return { ...forDemoAccount(bundle, accountId), account: lawFirmBundle(accountId).account };
}
