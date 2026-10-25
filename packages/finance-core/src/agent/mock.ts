import { FINANCE_OUTPUT_VERSION, type FinanceAgentInput, type FinanceAgentOutput } from "@mangekyo/contracts";
import type { FinanceAgentProvider } from "./types";
import { formatCents } from "../intake/cents";
import { FinanceProviderError } from "./types";
import { INSURANCE_POLICY } from "../../fixtures/lawFirmFeed";
import { INVOICE_POLICY, PARTIAL_RETAINER_POLICY, retainerCents, usedPolicyLabel } from "../policy";

function amountTexts(cents: number): string[] {
  const exact = formatCents(cents);
  return cents % 100 === 0 ? [exact, exact.slice(0, -3)] : [exact];
}

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

/**
 * Scorecard plants only (raw.recordType "scorecard-plant"): the mistakes the checker exists to catch.
 * wrong-client believes the bank's owner hint over the linked document; unsupported-claim quotes an invoice the memo never mentions.
 */
function mockPlanted(input: FinanceAgentInput): FinanceAgentOutput | null {
  const deposit = input.records.transactions[0];
  const bank = deposit && input.records.bankTransactions?.find(t => t.sourceId === deposit.sourceId);
  if (!bank || bank.raw.recordType !== "scorecard-plant") return null;
  const amount = formatCents(deposit.amountCents, deposit.currency);
  const doc = input.records.documents.find(d => bank.documentSourceIds.includes(d.sourceId));
  const propose = (ownerId: string, finding: string) => output({ outcome: "proposal_ready", summary: "SIMULATED (planted mistake): proposed ownership for a person's approval.",
    findings: [{ findingId: "ownership-evidence", summary: finding, sourceRefs: doc ? [doc.sourceId] : [deposit.sourceId] }],
    proposedAllocations: [{ proposalId: `mock-allocation:${deposit.transactionId}`, transactionId: deposit.transactionId, ownerId, amountCents: deposit.amountCents, currency: deposit.currency, evidenceSourceIds: [deposit.sourceId, ...(doc ? [doc.sourceId] : [])] }] });
  if (bank.raw.rawId === "wrong-client" || bank.raw.rawId.startsWith("planted:")) {
    const hinted = input.records.owners.find(o => bank.ownerHintSourceId?.replace("owner-record:", "owner:") === o.ownerId);
    if (hinted && doc) return propose(hinted.ownerId, `The ${doc.title} names ${hinted.name} for ${amount}.`);
  }
  if (bank.raw.rawId === "unsupported-claim") {
    const owner = input.records.owners.find(o => o.name === "James Nguyen");
    if (owner && doc) return propose(owner.ownerId, `The ${doc.title} quotes invoice INV-7781 for ${owner.name}: ${amount}.`);
  }
  return null;
}

/**
 * A deposit smaller than the retainer in a linked engagement letter, from a payer whose surname matches the client the letter names.
 * The first time, the agent asks. Once a person has confirmed the pattern (on this deposit, or earlier on another deposit of the
 * account: memory), it proposes and offers the pattern as a candidate policy; with the policy approved, it says which policy it used.
 */
function mockPartialRetainer(input: FinanceAgentInput, bank: NonNullable<FinanceAgentInput["records"]["bankTransactions"]>[number]): FinanceAgentOutput | null {
  const { records } = input;
  const deposit = records.transactions[0];
  const surname = bank.counterparty.trim().split(/\s+/).at(-1)?.toLowerCase() ?? "";
  const letters = records.documents.filter(d => bank.documentSourceIds.includes(d.sourceId) && /engagement letter/i.test(d.title));
  for (const letter of letters) {
    const retainer = retainerCents(letter.text);
    if (retainer === null || deposit.amountCents >= retainer) continue;
    const named = records.owners.filter(o => letter.text.includes(o.name) && o.name.trim().split(/\s+/).at(-1)?.toLowerCase() === surname);
    if (named.length !== 1) continue;
    const [owner] = named;
    const amount = formatCents(deposit.amountCents, deposit.currency);
    const retainerText = formatCents(retainer, deposit.currency);
    const confirmed = (c: FinanceAgentInput["humanClarifications"][number]) => c.questionId.endsWith(":question:partial-retainer") && /^(yes|confirmed)\b/i.test(c.answer.trim());
    const answers = input.humanClarifications.filter(c => !c.questionId.endsWith(":rejection"));
    const ownAnswer = answers.find(c => c.taskId === input.taskId && confirmed(c));
    const memory = answers.find(c => c.taskId !== input.taskId && confirmed(c));
    const policy = input.approvedPolicies.find(p => p.statement === PARTIAL_RETAINER_POLICY);
    const propose = (finding: string, refs: string[], summaryPrefix: string, candidate: boolean) => output({ outcome: "proposal_ready",
      summary: `${summaryPrefix}Proposed ownership requires a person's approval before posting.`,
      findings: [{ findingId: "ownership-evidence", summary: finding, sourceRefs: refs }],
      proposedAllocations: [{ proposalId: `mock-allocation:${deposit.transactionId}`, transactionId: deposit.transactionId, ownerId: owner.ownerId, amountCents: deposit.amountCents, currency: deposit.currency, evidenceSourceIds: [deposit.sourceId, ...refs] }],
      candidatePolicies: candidate && !policy ? [{ policyId: "partial-retainer", statement: PARTIAL_RETAINER_POLICY, sourceRefs: [letter.sourceId, deposit.sourceId], status: "proposed" as const }] : [] });
    if (policy) return propose(`${letter.title} names ${owner.name} with a ${retainerText} retainer; the ${amount} deposit is a partial payment under the approved policy.`, [letter.sourceId, deposit.sourceId, policy.sourceId], `${usedPolicyLabel(policy)}. `, false);
    if (ownAnswer) return propose(`A person confirmed the ${amount} deposit as a partial payment of ${owner.name}'s ${retainerText} retainer.`, [letter.sourceId, deposit.sourceId, ownAnswer.sourceId], "", true);
    if (memory) return propose(`${letter.title} names ${owner.name} with a ${retainerText} retainer; the ${amount} deposit is smaller. A person confirmed the same partial-retainer pattern on an earlier deposit of this account.`, [letter.sourceId, deposit.sourceId, memory.sourceId], "From memory of an earlier answer. ", true);
    return output({ outcome: "needs_information", summary: "The deposit is smaller than the agreed retainer. Ownership needs confirmation.", questions: [{ key: "partial-retainer", question: `Is ${amount} a partial payment of ${owner.name}'s ${retainerText} retainer?`, sourceRefs: [deposit.sourceId, ...bank.documentSourceIds] }] });
  }
  return null;
}

function mockLawFirm(input: FinanceAgentInput): FinanceAgentOutput | null {
  if (input.records.sourceAdapter?.datasetVersion !== "law-firm-demo-v1") return null;
  const { records } = input;
  const deposit = records.transactions[0];
  if (!deposit) return null;
  const bank = records.bankTransactions?.find(t => t.sourceId === deposit.sourceId);
  if (!bank) return null;
  const policy = input.approvedPolicies.find(p => p.statement === INSURANCE_POLICY);
  if (bank.reference === "Claim HL-44812" && records.existingAllocations.length) return output({
    outcome: "findings", summary: "Maria Delgado's allocation is recorded. A person can review this proposed insurance policy.",
    findings: [{ findingId: "claim-document", summary: "The settlement agreement names Maria Delgado for $85,000.00.", sourceRefs: bank.documentSourceIds }],
    candidatePolicies: policy ? [] : [{ policyId: "insurance-claim-owner", statement: INSURANCE_POLICY, sourceRefs: bank.documentSourceIds, status: "proposed" }],
  });
  const answers = input.humanClarifications.filter(c => !c.questionId.endsWith(":rejection"));
  const propose = (ownerId: string, finding: string, refs: string[]) => output({ outcome: "proposal_ready", summary: "Proposed ownership requires a person's approval before posting.",
    findings: [{ findingId: "ownership-evidence", summary: finding, sourceRefs: refs }],
    proposedAllocations: [{ proposalId: `mock-allocation:${deposit.transactionId}`, transactionId: deposit.transactionId, ownerId, amountCents: deposit.amountCents, currency: deposit.currency, evidenceSourceIds: [deposit.sourceId, ...refs] }] });
  const retainer = mockPartialRetainer(input, bank);
  if (retainer) return retainer;
  if (bank.counterparty === "J NGUYEN") {
    const answer = answers.find(c => c.questionId.endsWith(":question:which-nguyen"));
    const choice = answer?.answer.trim().toLowerCase();
    const owner = records.owners.find(o => (choice === "james" || choice === "james nguyen") ? o.name === "James Nguyen" : (choice === "linh" || choice === "linh nguyen") ? o.name === "Linh Nguyen" : false);
    if (owner && answer) {
      const corrected = answers.some(c => c.questionId.endsWith(":correction") && !c.question.startsWith("A person disputes"));
      return propose(owner.ownerId, corrected ? `For the $1,200.00 deposit, a person answered ${answer.answer.trim()}.` : `The memo names ${owner.name} for this deposit.`, corrected ? [deposit.sourceId, answer.sourceId] : bank.documentSourceIds);
    }
    return output({ outcome: "needs_information", summary: "The payer and memo do not distinguish the two Nguyen clients.", questions: [{ key: "which-nguyen", question: "Which Nguyen is this for, Linh or James?", sourceRefs: [deposit.sourceId, ...bank.documentSourceIds] }] });
  }
  const proposal = mockIntakeRules(input) ?? mockIntakeProposal(input);
  if (!proposal) return output({ outcome: "needs_information", summary: "Ownership needs supporting evidence.", questions: [{ key: "ownership-evidence", question: "Which client does this deposit belong to?", sourceRefs: [deposit.sourceId] }] });
  proposal.candidatePolicies = [];
  if (bank.reference === "Claim HL-50210" && policy) {
    proposal.proposedAllocations.forEach(p => p.evidenceSourceIds.push(policy.sourceId));
    proposal.summary = `${usedPolicyLabel(policy)}. ${proposal.summary}`;
  }
  return proposal;
}

export function mockInvestigation(input: FinanceAgentInput): FinanceAgentOutput {
  const pending = input.records.bankTransactions?.find(t => t.direction === "inflow" && t.clearing === "pending" && t.bookedAt <= input.scope.cutoff && (input.scope.from === null || t.bookedAt >= input.scope.from));
  if (input.records.sourceAdapter && input.records.transactions.length === 0 && pending) {
    return output({ outcome: "findings", summary: "Waiting for the check to clear. Ownership evidence can be reviewed now; an allocation can only be proposed after clearing.",
      findings: [{ findingId: "waiting-for-clearance", summary: `The ${formatCents(pending.amountCents)} deposit from ${pending.counterparty} has not cleared.`, sourceRefs: [pending.sourceId] }] });
  }
  const planted = mockPlanted(input);
  if (planted) return planted;
  const lawFirm = mockLawFirm(input);
  if (lawFirm) return lawFirm;
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
