import { FINANCE_INPUT_VERSION, FINANCE_INSTRUCTION_VERSION, type FinanceAgentInput } from "@mangekyo/contracts";
import { runDeterministicChecks } from "../src/checks";

export function sampleInput(): FinanceAgentInput {
  const base = { synthetic: true as const, caseId: "test-case" };
  const scope = { kind: "deposit_investigation" as const, accountId: "test-bank", currency: "USD", from: null, cutoff: 1000 };
  const records: FinanceAgentInput["records"] = {
    transactions: [{ ...base, transactionId: "deposit-1", sourceId: "bank:1", accountId: "test-bank", amountCents: 125000, currency: "USD", direction: "deposit", bankStatus: "cleared", allocationStatus: "unallocated", clearedAt: 900, description: "SYNTHETIC test deposit" }],
    owners: [{ ...base, ownerId: "owner-1", name: "SYNTHETIC candidate" }],
    documents: [{ ...base, documentId: "doc-1", sourceId: "note:1", title: "SYNTHETIC unverified note", mimeType: "text/plain", version: "v1", effectiveAt: null, text: "May belong to the candidate owner.", excerpt: "May belong to the candidate owner." }],
    invoices: [], agreements: [], bankBalance: null, controlBalance: null,
    ownerBalances: null, ownerBalancesComplete: false, timingDifferences: [], existingAllocations: [],
    allocationHistoryComplete: false, missingEvidence: ["Invoices unavailable", "Complete allocation history unavailable"], coverage: "available_records_only",
  };
  return {
    schemaVersion: FINANCE_INPUT_VERSION, instructionVersion: FINANCE_INSTRUCTION_VERSION,
    caseId: base.caseId, taskId: "task-1", runId: "run-1", scope, records,
    evidenceRefs: [{ sourceId: "note:1", documentId: "doc-1", excerpt: records.documents[0].excerpt }],
    deterministicChecks: runDeterministicChecks(records, scope), approvedPolicies: [], humanClarifications: [],
  };
}
