import { FINANCE_OUTPUT_VERSION, type FinanceAgentInput, type FinanceAgentOutput } from "@mangekyo/contracts";
import type { FinanceAgentProvider } from "./types";
import { formatCents } from "../intake/cents";
import { FinanceProviderError } from "./types";

function amountTexts(cents: number): string[] {
  const exact = formatCents(cents);
  return cents % 100 === 0 ? [exact, exact.slice(0, -3)] : [exact];
}

/** Proposes only when linked source documents name exactly one owner and state the exact deposit amount. */
function mockIntakeProposal(input: FinanceAgentInput): FinanceAgentOutput | null {
  const { records } = input;
  if (!records.sourceAdapter || input.scope.kind !== "deposit_investigation" || records.transactions.length !== 1) return null;
  if (input.humanClarifications.some(row => row.questionId.endsWith(":rejection"))) return null;
  const deposit = records.transactions[0];
  const bank = records.bankTransactions?.find(row => row.sourceId === deposit.sourceId);
  if (!bank || bank.duplicateOfSourceId || !records.allocationHistoryComplete || records.existingAllocations.length > 0) return null;
  if (input.deterministicChecks.amounts.status !== "passed") return null;
  const linked = records.documents.filter(doc => bank.documentSourceIds.includes(doc.sourceId));
  const named = records.owners.filter(owner => linked.some(doc => doc.text.includes(owner.name)));
  if (named.length !== 1) return null;
  const [owner] = named;
  const support = linked.filter(doc => doc.text.includes(owner.name) && amountTexts(deposit.amountCents).some(text => doc.text.includes(text)));
  if (support.length === 0) return null;
  const amount = formatCents(deposit.amountCents, deposit.currency);
  const invoiceNotes = (records.obligations ?? []).filter(row => row.kind === "invoice" && row.reference && bank.reference.includes(row.reference));
  return {
    schemaVersion: FINANCE_OUTPUT_VERSION,
    outcome: "proposal_ready",
    summary: `SIMULATED: Reviewed deposit ${deposit.sourceId} (${amount}) in ${input.scope.accountId}, available records only. ${support.map(doc => doc.sourceId).join(", ")} names ${owner.name} and states the deposit amount. Proposed allocation is unapproved and requires human review.`,
    findings: [
      { findingId: "owner-named-in-source", summary: `SIMULATED: ${support[0].title} names ${owner.name} as recipient/beneficiary for ${amount}.`, sourceRefs: [deposit.sourceId, ...support.map(doc => doc.sourceId)] },
      ...invoiceNotes.map(row => ({ findingId: `invoice-${row.raw.rawId}`, summary: `SIMULATED: Reference matches ${row.excerpt}${row.amountCents !== null && row.amountCents !== deposit.amountCents ? `; the invoice amount differs from the ${amount} deposit (possible partial payment).` : "."}`, sourceRefs: [row.sourceId] })),
    ],
    questions: [],
    proposedAllocations: [{ proposalId: `mock-allocation:${deposit.transactionId}`, transactionId: deposit.transactionId, ownerId: owner.ownerId, amountCents: deposit.amountCents, currency: deposit.currency, evidenceSourceIds: [deposit.sourceId, ...support.map(doc => doc.sourceId)] }],
    proposedActions: [],
    candidatePolicies: [],
  };
}

export function mockInvestigation(input: FinanceAgentInput): FinanceAgentOutput {
  const proposal = mockIntakeProposal(input);
  if (proposal) return proposal;
  const clarified = input.humanClarifications.length > 0;
  const refs = input.records.documents.map(row => row.sourceId);
  const answers = input.humanClarifications.map(row => row.sourceId);
  const deposit = input.records.transactions[0];
  const depositAmount = deposit ? new Intl.NumberFormat("en-US", { style: "currency", currency: deposit.currency }).format(deposit.amountCents / 100) : null;
  const period = `${input.scope.from === null ? "available start" : new Date(input.scope.from).toISOString()} through ${new Date(input.scope.cutoff).toISOString()}`;
  return {
    schemaVersion: FINANCE_OUTPUT_VERSION,
    outcome: "needs_information",
    summary: `SIMULATED: Reviewed ${input.records.transactions.length} available transaction(s) for ${input.scope.accountId} in ${input.scope.currency}, ${period}. ${clarified ? "The task-scoped human clarification was included, but independent source evidence is still missing." : "The remittance note suggests a candidate owner but does not establish ownership."} This is not a completed historical audit.`,
    findings: [
      ...(refs.length ? [{ findingId: "unverified-remittance", summary: "SIMULATED: The supplied note is unverified and cannot support an approved allocation.", sourceRefs: refs }] : []),
      ...(answers.length ? [{ findingId: "clarification-received", summary: "SIMULATED: A saved human answer provides task context; it is not financial authorization or an approved company policy.", sourceRefs: answers }] : []),
    ],
    questions: [{
      key: clarified ? "supporting-agreement" : "payer-and-agreement",
      question: !deposit ? "Which bank statements, corresponding control books, and complete owner ledgers are available for this account, currency, and review period? Supply dated source records; no deposit was included in this scope." : clarified ? "What signed agreement, invoice, or independent payer confirmation supports ownership of this deposit? Identify its source and relevant excerpt." : `Who sent the ${depositAmount} deposit, and what bank payer reference plus signed agreement or invoice identifies the beneficial owner? Supply source identifiers or explain what is unavailable.`,
      sourceRefs: refs,
    }],
    proposedAllocations: [],
    proposedActions: [{ kind: "request_evidence", description: "Obtain payer confirmation and the corresponding agreement/invoice before proposing an ownership allocation.", sourceRefs: refs }],
    candidatePolicies: [{ policyId: "ownership-evidence-review", statement: "For human review: require payer identification and supporting contractual evidence before approving a deposit allocation.", sourceRefs: refs, status: "proposed" }],
  };
}

export const mockFinanceAgentProvider: FinanceAgentProvider = {
  mode: "mock",
  async start(input) { return { status: "completed", externalRunId: `mock:${input.runId}`, output: mockInvestigation(input) }; },
  async poll() { throw new FinanceProviderError("mock_poll_unsupported", "The simulated provider completes deterministically without polling."); },
};
