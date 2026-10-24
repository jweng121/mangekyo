import { FINANCE_OUTPUT_VERSION, type FinanceAgentInput, type FinanceAgentOutput } from "@mangekyo/contracts";
import type { FinanceAgentProvider } from "./types";
import { formatCents } from "../intake/cents";
import { FinanceProviderError } from "./types";

function amountTexts(cents: number): string[] {
  const exact = formatCents(cents);
  return cents % 100 === 0 ? [exact, exact.slice(0, -3)] : [exact];
}

const INVOICE_POLICY = "A deposit that quotes an open invoice number for the exact amount goes to that invoice's owner.";

function output(fields: Partial<FinanceAgentOutput> & Pick<FinanceAgentOutput, "outcome" | "summary">): FinanceAgentOutput {
  return { schemaVersion: FINANCE_OUTPUT_VERSION, findings: [], questions: [], proposedAllocations: [], proposedActions: [], candidatePolicies: [], ...fields };
}

/**
 * Deterministic scripted behaviour for the DEMO feed, based only on the frozen input:
 * duplicates and partial payments ask; exact open-invoice matches propose (citing an approved policy when one exists,
 * otherwise proposing that policy); an owner named only in a person's answer is proposed, and unless a correction
 * is on file the mock cites the deposit's memo for it instead of the answer, so the claim checker can be demonstrated.
 */
function mockIntakeRules(input: FinanceAgentInput): FinanceAgentOutput | null {
  const { records } = input;
  if (!records.sourceAdapter || input.scope.kind !== "deposit_investigation" || records.transactions.length !== 1) return null;
  if (input.humanClarifications.some(row => row.questionId.endsWith(":rejection"))) return null;
  const deposit = records.transactions[0];
  const bank = records.bankTransactions?.find(row => row.sourceId === deposit.sourceId);
  if (!bank || !records.allocationHistoryComplete || records.existingAllocations.length > 0 || input.deterministicChecks.amounts.status !== "passed") return null;
  const amount = formatCents(deposit.amountCents, deposit.currency);
  const allocate = (ownerId: string, evidence: string[]) => [{ proposalId: `mock-allocation:${deposit.transactionId}`, transactionId: deposit.transactionId, ownerId, amountCents: deposit.amountCents, currency: deposit.currency, evidenceSourceIds: evidence }];
  const ownerOf = (sourceId: string | null) => records.owners.find(o => sourceId !== null && sourceId.replace("owner-record:", "owner:") === o.ownerId) ?? null;

  if (bank.duplicateOfSourceId) {
    return output({ outcome: "needs_information", summary: `SIMULATED: ${amount} deposit ${deposit.sourceId} shares its reference with an earlier deposit. Not allocated.`,
      findings: [{ findingId: "shared-reference", summary: `SIMULATED: This ${amount} deposit quotes reference ${bank.reference}, which an earlier deposit also quotes.`, sourceRefs: [deposit.sourceId, bank.duplicateOfSourceId].filter(id => records.bankTransactions?.some(t => t.sourceId === id)) }],
      questions: [{ key: "duplicate-or-installment", question: `Is this ${amount} deposit a second installment, or a duplicate of the earlier deposit with reference ${bank.reference}?`, sourceRefs: [deposit.sourceId] }] });
  }

  const invoice = (records.obligations ?? []).find(o => o.kind === "invoice" && o.status === "open" && o.reference && bank.reference.includes(o.reference));
  const invoiceOwner = invoice ? ownerOf(invoice.ownerSourceId) : null;
  if (invoice && invoiceOwner && invoice.amountCents !== null) {
    const invoiceAmount = formatCents(invoice.amountCents, deposit.currency);
    if (invoice.amountCents === deposit.amountCents) {
      const policy = input.approvedPolicies.find(p => p.statement === INVOICE_POLICY);
      return output({ outcome: "proposal_ready",
        summary: `SIMULATED: The ${amount} deposit quotes open invoice ${invoice.reference} for exactly ${invoiceAmount}.${policy ? ` Used policy ${policy.policyId}.` : ""} Unapproved until a person signs off.`,
        findings: [{ findingId: "invoice-exact-match", summary: `SIMULATED: The payer quotes ${invoice.reference}, an open ${invoiceAmount} invoice for ${invoiceOwner.name}.`, sourceRefs: [invoice.sourceId, deposit.sourceId] }],
        proposedAllocations: allocate(invoiceOwner.ownerId, [deposit.sourceId, invoice.sourceId, ...(policy ? [policy.sourceId] : [])]),
        candidatePolicies: policy ? [] : [{ policyId: "invoice-exact-match", statement: INVOICE_POLICY, sourceRefs: [invoice.sourceId], status: "proposed" }] });
    }
    const answered = input.humanClarifications.filter(c => c.questionId.endsWith(":question:partial-payment"));
    if (answered.length && deposit.amountCents < invoice.amountCents) {
      return output({ outcome: "proposal_ready", summary: `SIMULATED: A person confirmed the ${amount} deposit is a partial payment of ${invoice.reference}. Unapproved until a person signs off.`,
        findings: [{ findingId: "partial-payment-confirmed", summary: `SIMULATED: A person answered that this is a partial payment of ${invoiceOwner.name}'s invoice ${invoice.reference}.`, sourceRefs: [invoice.sourceId, ...answered.map(c => c.sourceId)] }],
        proposedAllocations: allocate(invoiceOwner.ownerId, [deposit.sourceId, invoice.sourceId, ...answered.map(c => c.sourceId)]) });
    }
    return output({ outcome: "needs_information", summary: `SIMULATED: The ${amount} deposit quotes ${invoice.reference}, but that invoice is ${invoiceAmount}. Asked instead of guessing.`,
      findings: [{ findingId: "invoice-amount-differs", summary: `SIMULATED: The payer quotes ${invoice.reference}; the deposit is ${amount} and the invoice is ${invoiceAmount}.`, sourceRefs: [deposit.sourceId, invoice.sourceId] }],
      questions: [{ key: "partial-payment", question: `Is the ${amount} deposit a partial payment of ${invoiceOwner.name}'s ${invoiceAmount} invoice ${invoice.reference}?`, sourceRefs: [deposit.sourceId, invoice.sourceId] }] });
  }

  const linked = records.documents.filter(doc => bank.documentSourceIds.includes(doc.sourceId));
  const answers = input.humanClarifications.filter(c => !c.questionId.endsWith(":rejection"));
  const named = records.owners.filter(o => answers.some(c => c.answer.includes(o.name)));
  if (named.length === 1 && linked.length > 0 && !linked.some(doc => records.owners.some(o => doc.text.includes(o.name)))) {
    const [owner] = named;
    const corrected = answers.some(c => c.questionId.endsWith(":correction") && !c.question.startsWith("A person disputes"));
    const sources = corrected ? answers.filter(c => c.answer.includes(owner.name) || c.questionId.endsWith(":correction")).map(c => c.sourceId) : linked.map(doc => doc.sourceId);
    const ownerSources = corrected ? answers.filter(c => c.answer.includes(owner.name)).map(c => c.sourceId) : sources;
    return output({ outcome: "proposal_ready", summary: `SIMULATED: Proposes ${owner.name} for the ${amount} deposit${corrected ? ", citing the person's answer" : ""}. Unapproved until a person signs off.`,
      findings: [{ findingId: "owner-identified", summary: `SIMULATED: ${corrected ? "A person's answer" : linked[0].title} names ${owner.name} as the owner of this deposit.`, sourceRefs: ownerSources }],
      proposedAllocations: allocate(owner.ownerId, [deposit.sourceId, ...sources]) });
  }
  return null;
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
      ...invoiceNotes.map(row => ({ findingId: `invoice-${row.raw.rawId}`, summary: `SIMULATED: Reference matches ${row.excerpt}${row.amountCents !== null && row.amountCents !== deposit.amountCents ? `; the invoice amount differs from the ${amount} deposit (possible partial payment).` : "."}`, sourceRefs: [row.sourceId, deposit.sourceId] })),
    ],
    questions: [],
    proposedAllocations: [{ proposalId: `mock-allocation:${deposit.transactionId}`, transactionId: deposit.transactionId, ownerId: owner.ownerId, amountCents: deposit.amountCents, currency: deposit.currency, evidenceSourceIds: [deposit.sourceId, ...support.map(doc => doc.sourceId)] }],
    proposedActions: [],
    candidatePolicies: [],
  };
}

export function mockInvestigation(input: FinanceAgentInput): FinanceAgentOutput {
  const scripted = mockIntakeRules(input);
  if (scripted) return scripted;
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
