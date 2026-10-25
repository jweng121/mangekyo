import type { ApprovedFinancePolicy, ClaimCheck, HumanClarification, NormalizedBankTransaction, NormalizedDocument, NormalizedObligation, OwnerBalance, PayoutKind, TrustDispute } from "@mangekyo/contracts";
import type { PayoutLine } from "@mangekyo/contracts/orchestration";
import { FinanceProviderError, type ProviderExecution } from "../agent/types";
import { isObject } from "../agent/creaoClient";
import { factsIn } from "../checker";
import { contingencyFeeCents } from "../gateway";
import { formatCents } from "../intake/cents";
import { ownerBalances, type AccountLedgerState } from "../ledger";

/**
 * Disbursement agent: given a matter's signed settlement statement, fee agreement and approved invoices, it proposes
 * payout lines (attorney fee, costs, liens, client share), each backed by a signed document. It never proposes a payout
 * a signed document does not state; when anything is missing or doesn't add up it asks a person.
 */

export const DISBURSEMENT_INPUT_VERSION = "finance-disbursement-input/v1" as const;
export const DISBURSEMENT_OUTPUT_VERSION = "finance-disbursement-output/v1" as const;
export const DISBURSEMENT_INSTRUCTION_VERSION = "finance-disbursement/v1" as const;
export const DISBURSEMENT_REPORT_FIELDS = ["schemaVersion", "outcome", "summary", "findings", "questions", "lines"] as const;

export interface DisbursementInput {
  schemaVersion: typeof DISBURSEMENT_INPUT_VERSION;
  instructionVersion: typeof DISBURSEMENT_INSTRUCTION_VERSION;
  runId: string;
  accountId: string;
  currency: string;
  matterId: string;
  client: { ownerId: string; sourceId: string; name: string };
  firm: { ownerId: string; sourceId: string; name: string } | null;
  settlementDeposit: NormalizedBankTransaction | null;
  documents: NormalizedDocument[];
  invoices: NormalizedObligation[];
  clientBalance: OwnerBalance | null;
  disputes: TrustDispute[];
  approvedPolicies: ApprovedFinancePolicy[];
  humanClarifications: HumanClarification[];
}

export interface DisbursementOutput {
  schemaVersion: typeof DISBURSEMENT_OUTPUT_VERSION;
  outcome: "proposal_ready" | "needs_information";
  summary: string;
  findings: Array<{ findingId: string; summary: string; sourceRefs: string[] }>;
  questions: Array<{ key: string; question: string; sourceRefs: string[] }>;
  lines: PayoutLine[];
}

const isSigned = (d: NormalizedDocument) => d.signed === true;
export const isSettlementStatement = (d: NormalizedDocument) => isSigned(d) && Array.isArray(d.lines) && d.lines.length > 0;
export const isFeeAgreement = (d: NormalizedDocument) => isSigned(d) && Number.isSafeInteger(d.feeBasisPoints) && (d.feeBasisPoints ?? 0) > 0;
export const lineTotal = (lines: Array<{ amountCents: number }>) => lines.reduce((total, line) => total + line.amountCents, 0);

/** The matter a signed settlement statement belongs to, for one deposit (the statement is linked to the deposit by the source system). */
export function matterForDeposit(deposit: NormalizedBankTransaction, documents: NormalizedDocument[]): { matterId: string; statement: NormalizedDocument } | null {
  const statement = documents.find(d => deposit.documentSourceIds.includes(d.sourceId) && isSettlementStatement(d) && d.matterId);
  return statement ? { matterId: statement.matterId!, statement } : null;
}

/** Only the matter's records: the client, the firm, the settlement deposit, the matter's documents and approved invoices. */
export function buildDisbursementInput(args: {
  runId: string; state: AccountLedgerState; documents: NormalizedDocument[]; obligations: NormalizedObligation[]; matterId: string; clientOwnerId: string;
  settlementDeposit: NormalizedBankTransaction | null; cutoff: number; approvedPolicies: ApprovedFinancePolicy[]; humanClarifications: HumanClarification[];
}): DisbursementInput {
  const { state } = args;
  const client = state.owners.find(o => o.ownerId === args.clientOwnerId);
  if (!client) throw new Error(`Unknown client ${args.clientOwnerId}`);
  const firm = state.owners.find(o => o.ownerKind === "firm") ?? null;
  const documents = args.documents.filter(d => d.matterId === args.matterId || (d.matterId === undefined && d.namedOwnerSourceIds.includes(client.sourceId))).slice(0, 20);
  const invoices = args.obligations.filter(o => o.kind === "invoice" && o.ownerSourceId === client.sourceId && (o.matterId === undefined || o.matterId === args.matterId)).slice(0, 20);
  const balance = ownerBalances(state, args.cutoff).find(b => b.ownerId === client.ownerId) ?? null;
  return {
    schemaVersion: DISBURSEMENT_INPUT_VERSION, instructionVersion: DISBURSEMENT_INSTRUCTION_VERSION, runId: args.runId, accountId: state.account.accountId, currency: state.account.currency,
    matterId: args.matterId, client: { ownerId: client.ownerId, sourceId: client.sourceId, name: client.name }, firm: firm ? { ownerId: firm.ownerId, sourceId: firm.sourceId, name: firm.name } : null,
    settlementDeposit: args.settlementDeposit, documents, invoices, clientBalance: balance,
    disputes: (state.disputes ?? []).filter(d => d.ownerId === client.ownerId && d.status === "open"), approvedPolicies: args.approvedPolicies, humanClarifications: args.humanClarifications,
  };
}

/** Text of every record the agent may cite, keyed by sourceId; the Evidence Checker reads the same texts. */
export function disbursementTexts(input: DisbursementInput): Map<string, string> {
  const texts = new Map<string, string>();
  const add = (id: string, text: string) => texts.set(id, `${texts.get(id) ?? ""}\n${text}`.trim());
  for (const d of input.documents) add(d.sourceId, `${d.title}\n${d.text}${d.signed ? "\nSigned." : "\nNot signed."}${d.lines ? `\n${d.lines.map(l => `${l.label}: ${formatCents(l.amountCents, input.currency)}`).join("\n")}` : ""}${d.feeBasisPoints ? `\nFee: ${d.feeBasisPoints / 100}%` : ""}`);
  for (const i of input.invoices) add(i.sourceId, `${i.excerpt} (${i.status})`);
  if (input.settlementDeposit) { const t = input.settlementDeposit; add(t.sourceId, `${formatCents(t.amountCents, t.currency)} ${t.direction} ${t.reference} ${t.counterparty} ${t.clearing}`); }
  add(input.client.sourceId, input.client.name);
  if (input.firm) add(input.firm.sourceId, input.firm.name);
  for (const c of input.humanClarifications) add(c.sourceId, `${c.question}\n${c.answer}`);
  for (const p of input.approvedPolicies) add(p.sourceId, p.statement);
  return texts;
}

function out(fields: Omit<DisbursementOutput, "schemaVersion">): DisbursementOutput { return { schemaVersion: DISBURSEMENT_OUTPUT_VERSION, ...fields }; }
const ask = (summary: string, key: string, question: string, sourceRefs: string[]): DisbursementOutput => out({ outcome: "needs_information", summary, findings: [], questions: [{ key, question, sourceRefs }], lines: [] });

/** Deterministic stand-in: reads the signed statement's lines exactly, checks them against the signed fee agreement and the deposit, and otherwise asks. */
export function mockDisbursement(input: DisbursementInput): DisbursementOutput {
  const money = (cents: number) => formatCents(cents, input.currency);
  const statements = input.documents.filter(isSettlementStatement);
  const unsignedStatement = input.documents.find(d => !isSigned(d) && Array.isArray(d.lines) && d.lines.length > 0);
  if (statements.length === 0) {
    if (unsignedStatement) return ask(`The settlement statement for ${input.client.name} is not signed, so nothing can be paid out yet.`, "unsigned-statement", `The settlement statement "${unsignedStatement.title}" is not marked signed. Is there a signed copy?`, [unsignedStatement.sourceId]);
    return ask(`No signed settlement statement for ${input.client.name}'s matter ${input.matterId}; no payout can be proposed.`, "missing-statement", `Which signed settlement statement sets out the payouts for ${input.client.name}'s matter ${input.matterId}?`, [input.client.sourceId]);
  }
  if (statements.length > 1) return ask(`Two signed settlement statements apply to ${input.client.name}'s matter.`, "which-statement", `Two signed settlement statements apply (${statements.map(s => s.sourceId).join(", ")}). Which one governs the payout?`, statements.map(s => s.sourceId));
  const statement = statements[0];
  const lines = statement.lines!;
  const total = lineTotal(lines);
  if (input.settlementDeposit && total !== input.settlementDeposit.amountCents) {
    return ask(`The signed settlement statement's lines total ${money(total)} but the deposit is ${money(input.settlementDeposit.amountCents)}.`, "statement-does-not-add-up", `The signed settlement statement's lines total ${money(total)} but the deposit is ${money(input.settlementDeposit.amountCents)}. Which line is wrong, or is there a missing line?`, [statement.sourceId, input.settlementDeposit.sourceId]);
  }
  const feeLines = lines.filter(l => l.kind === "attorney_fee");
  const agreement = input.documents.find(isFeeAgreement);
  if (feeLines.length) {
    if (!agreement) {
      const unsigned = input.documents.find(d => !isSigned(d) && Number.isSafeInteger(d.feeBasisPoints));
      return ask(`The statement has a fee line but there is no signed fee agreement to check it against.`, "missing-fee-agreement", unsigned ? `The fee agreement "${unsigned.title}" is not marked signed. Is there a signed copy?` : `Which signed fee agreement sets ${input.client.name}'s fee for matter ${input.matterId}?`, [statement.sourceId, ...(unsigned ? [unsigned.sourceId] : [])]);
    }
    const expected = contingencyFeeCents(total, agreement.feeBasisPoints!);
    const fee = lineTotal(feeLines);
    if (fee !== expected) return ask(`The statement's fee ${money(fee)} does not equal ${agreement.feeBasisPoints! / 100}% of ${money(total)} (${money(expected)}) from the signed fee agreement.`, "fee-does-not-match-agreement", `The statement's attorney fee is ${money(fee)} but the signed fee agreement's ${agreement.feeBasisPoints! / 100}% of ${money(total)} is ${money(expected)}. Which is right?`, [statement.sourceId, agreement.sourceId]);
  }
  const payeeFor = (payeeSourceId: string | null): string | null | undefined => {
    if (payeeSourceId === null) return null;
    if (input.firm && payeeSourceId === input.firm.sourceId) return input.firm.ownerId;
    return undefined;
  };
  const unknownPayee = lines.find(l => payeeFor(l.payeeOwnerSourceId) === undefined);
  if (unknownPayee) return ask(`The statement line "${unknownPayee.label}" names a payee that is not in our records.`, "unknown-payee", `Who is the payee "${unknownPayee.payeeOwnerSourceId}" on the line "${unknownPayee.label}" (${money(unknownPayee.amountCents)})?`, [statement.sourceId]);
  if (lines.some(l => (l.kind === "attorney_fee" || l.kind === "costs") && l.payeeOwnerSourceId === null)) return ask("A fee or costs line names no payee.", "fee-payee", `Who receives the fee and costs lines on the signed settlement statement? The statement names no payee.`, [statement.sourceId]);
  const refs = (l: typeof lines[number]) => [statement.sourceId, ...(l.kind === "attorney_fee" && agreement ? [agreement.sourceId] : [])];
  return out({
    outcome: "proposal_ready",
    summary: `Proposed ${lines.length} payout lines for ${input.client.name}'s matter ${input.matterId} from the signed settlement statement${agreement ? ` and the signed ${agreement.feeBasisPoints! / 100}% fee agreement` : ""}. Each line needs the Evidence Checker, a person's approval and the lock before anything moves.`,
    findings: lines.map((l, i) => ({ findingId: `line-${i + 1}`, summary: `${l.label}: ${money(l.amountCents)}.`, sourceRefs: refs(l) })),
    questions: [],
    lines: lines.map((l, i) => ({ lineId: `line-${i + 1}`, kind: l.kind, label: l.label, amountCents: l.amountCents, payeeOwnerId: payeeFor(l.payeeOwnerSourceId) ?? null, sourceRefs: refs(l) })),
  });
}

export const mockDisbursementProvider = {
  mode: "mock" as const,
  async start(input: DisbursementInput): Promise<ProviderExecution> { return { status: "completed", externalRunId: `mock-disbursement:${input.runId}`, output: mockDisbursement(input) }; },
  async poll(): Promise<ProviderExecution> { throw new FinanceProviderError("mock_poll_unsupported", "The simulated disbursement agent completes without polling."); },
};

export class DisbursementValidationError extends FinanceProviderError {
  constructor(public readonly details: Array<{ path: string; reason: string }>) { super("validation_failed", `${details[0].path}: ${details[0].reason}`); }
}
function bad(reason: string, path: string): never { throw new DisbursementValidationError([{ path, reason }]); }
function strict(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!isObject(value)) bad("Expected a JSON object.", path);
  for (const k of keys) if (!(k in value)) bad("Required field is missing.", `${path}.${k}`);
  Object.keys(value).forEach((k, i) => { if (!keys.includes(k)) bad("Unsupported field; only contract fields are allowed.", `${path}[property#${i}]`); });
  return value;
}
const str = (v: unknown, max: number, path: string): string => { if (typeof v !== "string" || !v.trim() || v.length > max) bad(`Expected a nonempty string of at most ${max} characters.`, path); return v; };
const KINDS = new Set<PayoutKind>(["client_share", "attorney_fee", "costs", "lien", "refund", "other"]);

/** Strict: raw JSON only, sourceId-only citations, every line backed by a signed document, at most 3 questions. Nothing is repaired. */
export function validateDisbursementOutput(value: unknown, input: DisbursementInput): DisbursementOutput {
  const root = strict(value, [...DISBURSEMENT_REPORT_FIELDS], "$");
  if (root.schemaVersion !== DISBURSEMENT_OUTPUT_VERSION) bad(`Expected ${DISBURSEMENT_OUTPUT_VERSION}.`, "$.schemaVersion");
  if (root.outcome !== "proposal_ready" && root.outcome !== "needs_information") bad("Unsupported outcome.", "$.outcome");
  const texts = disbursementTexts(input);
  const signed = new Set(input.documents.filter(isSigned).map(d => d.sourceId));
  const refs = (v: unknown, path: string, min = 1): string[] => {
    if (!Array.isArray(v) || v.length < min || v.length > 20) bad(`Expected ${min}–20 sourceIds.`, path);
    v.forEach((ref, i) => { if (typeof ref !== "string" || !texts.has(ref)) bad("Citation does not exist in the frozen input.", `${path}[${i}]`); });
    return v as string[];
  };
  if (!Array.isArray(root.findings) || root.findings.length > 20) bad("Expected at most 20 findings.", "$.findings");
  const findings = root.findings.map((f, i) => { const p = `$.findings[${i}]`; const row = strict(f, ["findingId", "summary", "sourceRefs"], p); return { findingId: str(row.findingId, 200, `${p}.findingId`), summary: str(row.summary, 2000, `${p}.summary`), sourceRefs: refs(row.sourceRefs, `${p}.sourceRefs`) }; });
  if (!Array.isArray(root.questions) || root.questions.length > 3) bad("Expected at most 3 questions.", "$.questions");
  const questions = root.questions.map((q, i) => { const p = `$.questions[${i}]`; const row = strict(q, ["key", "question", "sourceRefs"], p); const key = str(row.key, 100, `${p}.key`); if (!/^[a-zA-Z0-9_-]+$/.test(key)) bad("Question keys must use letters, digits, underscores, or hyphens.", `${p}.key`); return { key, question: str(row.question, 2000, `${p}.question`), sourceRefs: refs(row.sourceRefs, `${p}.sourceRefs`, 0) }; });
  if (!Array.isArray(root.lines) || root.lines.length > 10) bad("Expected at most 10 lines.", "$.lines");
  const seen = new Set<string>();
  const lines: PayoutLine[] = root.lines.map((l, i) => {
    const p = `$.lines[${i}]`;
    const row = strict(l, ["lineId", "kind", "label", "amountCents", "payeeOwnerId", "sourceRefs"], p);
    const lineId = str(row.lineId, 100, `${p}.lineId`);
    if (seen.has(lineId)) bad("Duplicate lineId.", `${p}.lineId`); seen.add(lineId);
    if (typeof row.kind !== "string" || !KINDS.has(row.kind as PayoutKind)) bad("Unsupported payout kind.", `${p}.kind`);
    if (typeof row.amountCents !== "number" || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) bad("Expected positive integer cents.", `${p}.amountCents`);
    if (row.payeeOwnerId !== null && row.payeeOwnerId !== input.firm?.ownerId && row.payeeOwnerId !== input.client.ownerId) bad("payeeOwnerId must be null, the client or the firm from the input.", `${p}.payeeOwnerId`);
    const sourceRefs = refs(row.sourceRefs, `${p}.sourceRefs`);
    if (!sourceRefs.some(ref => signed.has(ref))) bad("Every payout line must cite a signed document.", `${p}.sourceRefs`);
    return { lineId, kind: row.kind as PayoutKind, label: str(row.label, 200, `${p}.label`), amountCents: row.amountCents, payeeOwnerId: row.payeeOwnerId as string | null, sourceRefs };
  });
  if (root.outcome === "proposal_ready" && (lines.length === 0 || questions.length > 0)) bad("proposal_ready requires at least one line and no questions.", "$.outcome");
  if (root.outcome === "needs_information" && (lines.length > 0 || questions.length === 0)) bad("needs_information requires 1–3 questions and no lines.", "$.outcome");
  return { schemaVersion: DISBURSEMENT_OUTPUT_VERSION, outcome: root.outcome, summary: str(root.summary, 4000, "$.summary"), findings, questions, lines };
}

/**
 * Code check before the Evidence Checker and the lock: every proposed line is a line of a signed settlement statement in the
 * input (same kind, same amount), the lines are exactly the statement's lines, and a fee line matches the signed fee agreement.
 */
export function codeCheckPayoutLines(output: DisbursementOutput, input: DisbursementInput): Array<{ lineId: string; supported: boolean; reason: string; sourceIds: string[] }> {
  const money = (cents: number) => formatCents(cents, input.currency);
  const statements = input.documents.filter(isSettlementStatement);
  const agreements = input.documents.filter(isFeeAgreement);
  const results = output.lines.map(line => {
    const statement = statements.find(s => line.sourceRefs.includes(s.sourceId));
    if (!statement) return { lineId: line.lineId, supported: false, reason: "The line cites no signed settlement statement from the input.", sourceIds: line.sourceRefs };
    const match = statement.lines!.find(l => l.kind === line.kind && l.amountCents === line.amountCents);
    if (!match) return { lineId: line.lineId, supported: false, reason: `The signed statement has no ${line.kind.replace(/_/g, " ")} line of ${money(line.amountCents)}.`, sourceIds: [statement.sourceId] };
    if (line.kind === "attorney_fee") {
      const agreement = agreements.find(a => line.sourceRefs.includes(a.sourceId));
      if (!agreement) return { lineId: line.lineId, supported: false, reason: "A fee line must cite the signed fee agreement.", sourceIds: [statement.sourceId] };
      const expected = contingencyFeeCents(lineTotal(statement.lines!), agreement.feeBasisPoints!);
      if (expected !== line.amountCents) return { lineId: line.lineId, supported: false, reason: `${agreement.feeBasisPoints! / 100}% of ${money(lineTotal(statement.lines!))} is ${money(expected)}, not ${money(line.amountCents)}.`, sourceIds: [statement.sourceId, agreement.sourceId] };
    }
    return { lineId: line.lineId, supported: true, reason: "The line is exactly a line of the signed settlement statement.", sourceIds: line.sourceRefs };
  });
  if (output.lines.length) {
    const statement = statements.find(s => output.lines.every(l => l.sourceRefs.includes(s.sourceId)));
    if (statement && (statement.lines!.length !== output.lines.length || lineTotal(statement.lines!) !== lineTotal(output.lines))) {
      results.push({ lineId: "all-lines", supported: false, reason: `The statement has ${statement.lines!.length} lines totalling ${money(lineTotal(statement.lines!))}; the proposal has ${output.lines.length} totalling ${money(lineTotal(output.lines))}.`, sourceIds: [statement.sourceId] });
    }
  }
  return results;
}

/** The Evidence Checker's claims for a disbursement answer: its findings plus one claim per line, checked by code first. */
export function disbursementClaims(output: DisbursementOutput, input: DisbursementInput): ClaimCheck[] {
  const texts = disbursementTexts(input);
  const names = [input.client.name, ...(input.firm ? [input.firm.name] : [])];
  const claims = [
    ...output.findings.map(f => ({ findingId: f.findingId, claim: f.summary, sourceRefs: f.sourceRefs })),
    ...output.lines.map(l => ({ findingId: `payout:${l.lineId}`, claim: `${l.label}: ${formatCents(l.amountCents, input.currency)}.`, sourceRefs: l.sourceRefs })),
  ];
  const seen = new Set<string>();
  return claims.filter(c => !seen.has(c.findingId) && !!seen.add(c.findingId)).map(c => {
    const unknown = c.sourceRefs.filter(ref => !texts.has(ref));
    const cited = c.sourceRefs.map(ref => texts.get(ref) ?? "").join("\n");
    const firstSays = (texts.get(c.sourceRefs.find(ref => texts.has(ref)) ?? "") ?? "").replace(/\s+/g, " ").slice(0, 300) || null;
    const base = { findingId: c.findingId, claim: c.claim, sourceRefs: c.sourceRefs, checkedBy: "code" as const };
    if (unknown.length) return { ...base, verdict: "not_supported" as const, reason: `Cited sources are not in the frozen input: ${unknown.join(", ")}.`, facts: [], missing: unknown, sourceSays: firstSays };
    const facts = factsIn(c.claim, names);
    const missing = facts.filter(f => !f.found(cited)).map(f => f.label);
    if (missing.length) return { ...base, verdict: "not_supported" as const, reason: `The cited records don't contain: ${missing.join(", ")}.`, facts: facts.map(f => f.label), missing, sourceSays: firstSays };
    if (facts.length === 0) return { ...base, checkedBy: "none" as const, verdict: "not_checkable" as const, reason: "The claim quotes no amount, date, reference or name that code can check.", facts: [], missing: [], sourceSays: null };
    return { ...base, verdict: "supported" as const, reason: `Every quoted fact appears in the cited records: ${facts.map(f => f.label).join(", ")}.`, facts: facts.map(f => f.label), missing: [], sourceSays: null };
  });
}
