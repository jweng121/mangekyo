import type { LedgerEntry, NormalizedBankTransaction, ThreeWayCause, ThreeWayCheckResult } from "@mangekyo/contracts";
import { FinanceProviderError, type ProviderExecution } from "../agent/types";
import { isObject } from "../agent/creaoClient";
import { factsIn } from "../checker";
import { formatCents } from "../intake/cents";
import { activeAllocations, buildReversalEntries, type AccountLedgerState } from "../ledger";

/**
 * Reconciliation mode: when the three-way check fails, an agent explains the code-found cause and proposes
 * one correcting entry. The entry goes to a person and through the correction lock; it never posts itself.
 */

export const RECON_INPUT_VERSION = "finance-reconciliation-input/v1" as const;
export const RECON_OUTPUT_VERSION = "finance-reconciliation-output/v1" as const;
export const RECON_INSTRUCTION_VERSION = "finance-reconciler/v1" as const;

/** Mismatches an agent can explain. Warnings never start one. */
const RECONCILABLE = new Set<ThreeWayCause["code"]>(["BANK_TXN_WITHOUT_LEDGER_ENTRY", "LEDGER_ENTRY_WITHOUT_BANK_TXN", "AMOUNT_MISMATCH", "DUPLICATE_POSTING", "UNKNOWN_OWNER_ENTRY", "OUTSTANDING_ITEM_AGED"]);

export function causeKey(cause: ThreeWayCause): string {
  return `${cause.code}:${cause.sourceIds[0] ?? "account"}`;
}
export function reconcilableCauses(threeWay: ThreeWayCheckResult): ThreeWayCause[] {
  const seen = new Set<string>();
  return threeWay.causes.filter(c => c.severity === "mismatch" && RECONCILABLE.has(c.code) && !seen.has(causeKey(c)) && !!seen.add(causeKey(c)));
}

export interface ReconciliationInput {
  schemaVersion: typeof RECON_INPUT_VERSION;
  instructionVersion: typeof RECON_INSTRUCTION_VERSION;
  runId: string;
  accountId: string;
  currency: string;
  causeKey: string;
  /** The code-found cause, exactly as the three-way check reported it. */
  cause: ThreeWayCause;
  threeWay: { status: ThreeWayCheckResult["status"]; bankMinusBook: number | null; bookMinusOwners: number };
  /** Only the records the cause involves: its bank items and entries, a returned item's original deposit, owners and linked documents. */
  records: {
    bankTransactions: NormalizedBankTransaction[];
    ledgerEntries: LedgerEntry[];
    owners: Array<{ ownerId: string; sourceId: string; name: string }>;
    documents: Array<{ sourceId: string; title: string; text: string }>;
  };
}

export interface CorrectingEntry {
  kind: "record_bank_item" | "reverse_entry";
  bankSourceId: string | null;
  reversesEntryId: string | null;
  ownerId: string | null;
  /** Signed integer cents, as it will appear in the ledger. */
  amountCents: number;
  memo: string;
  evidenceSourceIds: string[];
}

export interface ReconciliationOutput {
  schemaVersion: typeof RECON_OUTPUT_VERSION;
  outcome: "correction_proposed" | "needs_information";
  explanation: string;
  findings: Array<{ findingId: string; summary: string; sourceRefs: string[] }>;
  questions: Array<{ key: string; question: string }>;
  proposedEntry: CorrectingEntry | null;
}

const returnedOriginal = (sourceId: string) => sourceId.endsWith(":returned") ? sourceId.slice(0, -":returned".length) : null;

export function buildReconciliationInput(args: { runId: string; state: AccountLedgerState; documents: Array<{ sourceId: string; title: string; text: string }>; threeWay: ThreeWayCheckResult; cause: ThreeWayCause }): ReconciliationInput {
  const { state, cause } = args;
  const ids = new Set(cause.sourceIds);
  for (const id of cause.sourceIds) { const original = returnedOriginal(id); if (original) ids.add(original); }
  const bank = state.bankTransactions.filter(t => ids.has(t.sourceId));
  const bankIds = new Set(bank.map(t => t.sourceId));
  const entries = state.entries.filter(e => ids.has(e.entryId) || (e.fundsSourceId !== undefined && bankIds.has(e.fundsSourceId)) || e.sourceRefs.some(ref => bankIds.has(ref)));
  const ownerIds = new Set([...cause.ownerIds, ...entries.flatMap(e => e.ownerId ? [e.ownerId] : [])]);
  const hinted = new Set(bank.flatMap(t => t.ownerHintSourceId ? [t.ownerHintSourceId] : []));
  const owners = state.owners.filter(o => ownerIds.has(o.ownerId) || hinted.has(o.sourceId)).map(o => ({ ownerId: o.ownerId, sourceId: o.sourceId, name: o.name }));
  const docIds = new Set(bank.flatMap(t => t.documentSourceIds));
  return {
    schemaVersion: RECON_INPUT_VERSION, instructionVersion: RECON_INSTRUCTION_VERSION, runId: args.runId, accountId: state.account.accountId, currency: state.account.currency,
    causeKey: causeKey(cause), cause, threeWay: { status: args.threeWay.status, bankMinusBook: args.threeWay.differences.bankMinusBook, bookMinusOwners: args.threeWay.differences.bookMinusOwners },
    records: { bankTransactions: bank, ledgerEntries: entries, owners, documents: args.documents.filter(d => docIds.has(d.sourceId)).map(d => ({ sourceId: d.sourceId, title: d.title, text: d.text })) },
  };
}

/** Text of every record the reconciler may cite, keyed by sourceId (entries by entryId). */
export function reconciliationTexts(input: ReconciliationInput): Map<string, string> {
  const texts = new Map<string, string>();
  for (const t of input.records.bankTransactions) texts.set(t.sourceId, `${formatCents(t.amountCents, t.currency)} ${t.direction} ${t.reference} ${t.counterparty} ${t.clearing} ${t.raw.recordType}`);
  for (const e of input.records.ledgerEntries) texts.set(e.entryId, `${formatCents(e.amountCents, e.currency)} ${e.kind} ${e.memo}${e.ownerId ? ` ${input.records.owners.find(o => o.ownerId === e.ownerId)?.name ?? e.ownerId}` : ""}`);
  for (const o of input.records.owners) texts.set(o.sourceId, o.name);
  for (const d of input.records.documents) texts.set(d.sourceId, `${d.title}\n${d.text}`);
  return texts;
}

function out(fields: Omit<ReconciliationOutput, "schemaVersion">): ReconciliationOutput { return { schemaVersion: RECON_OUTPUT_VERSION, ...fields }; }

/** Deterministic stand-in for a CREAO reconciler. It only explains what code found and proposes the matching entry. */
export function mockReconciliation(input: ReconciliationInput): ReconciliationOutput {
  const { cause, records } = input;
  const amount = formatCents(Math.abs(cause.amountCents ?? 0), input.currency);
  if (cause.code === "BANK_TXN_WITHOUT_LEDGER_ENTRY") {
    const txn = records.bankTransactions.find(t => t.sourceId === cause.sourceIds[0]);
    if (!txn) return out({ outcome: "needs_information", explanation: `The bank shows an item with no ledger entry, but it isn't in the records supplied.`, findings: [], questions: [{ key: "missing-bank-item", question: "Which bank item is unrecorded?" }], proposedEntry: null });
    const owner = records.owners.find(o => o.ownerId === cause.ownerIds[0]) ?? records.owners.find(o => o.sourceId === txn.ownerHintSourceId) ?? null;
    const original = returnedOriginal(txn.sourceId);
    const deposit = original ? records.bankTransactions.find(t => t.sourceId === original) : undefined;
    if (txn.direction === "outflow" && txn.raw.recordType === "client-check-return" && deposit && owner) {
      const allocation = records.ledgerEntries.find(e => e.kind === "allocation" && e.ownerId === owner.ownerId && e.fundsSourceId === deposit.sourceId);
      return out({ outcome: "correction_proposed",
        explanation: `The bank returned ${deposit.counterparty}'s ${formatCents(deposit.amountCents, input.currency)} check (${deposit.reference}), so that money never arrived. The books still count it as ${owner.name}'s money, which is why bank and books differ by ${amount}. Recording the return against ${owner.name} reverses the bounced check.`,
        findings: [
          { findingId: "bank-returned-check", summary: `The bank returned ${formatCents(txn.amountCents, input.currency)} with reference ${txn.reference}.`, sourceRefs: [txn.sourceId] },
          ...(allocation ? [{ findingId: "books-still-credit-owner", summary: `The books allocated ${formatCents(allocation.amountCents, input.currency)} of the deposit to ${owner.name}.`, sourceRefs: [allocation.entryId] }] : []),
        ],
        questions: [],
        proposedEntry: { kind: "record_bank_item", bankSourceId: txn.sourceId, reversesEntryId: null, ownerId: owner.ownerId, amountCents: -txn.amountCents, memo: `Bounced check: bank returned ${deposit.counterparty}'s ${formatCents(deposit.amountCents, input.currency)} (${deposit.reference})`, evidenceSourceIds: [txn.sourceId, deposit.sourceId, ...(allocation ? [allocation.entryId] : [])] } });
    }
    // An outflow the bank attributes to a client, with nothing saying why it moved: the records don't fully support an entry, so ask one short question.
    if (txn.direction === "outflow" && owner) return out({ outcome: "needs_information",
      explanation: `The bank is ${formatCents(txn.amountCents, input.currency)} short: ${txn.reference} left the account with no ledger entry. The bank names ${owner.name}, but nothing in the records says whether a check bounced, a fee was charged or a payment was issued, so no entry is proposed.`,
      findings: [{ findingId: "unrecorded-outflow", summary: `The bank paid out ${formatCents(txn.amountCents, input.currency)} with reference ${txn.reference}.`, sourceRefs: [txn.sourceId] }],
      questions: [{ key: "bounce-or-fee", question: `The bank is ${formatCents(txn.amountCents, input.currency)} short. Did ${owner.name}'s check bounce, or is this a bank fee?` }], proposedEntry: null });
    if (txn.direction === "inflow") return out({ outcome: "correction_proposed",
      explanation: `${formatCents(txn.amountCents, input.currency)} arrived at the bank (${txn.reference}) with no ledger entry. Recording it as unallocated keeps every dollar visible until a person assigns it.`,
      findings: [{ findingId: "unrecorded-deposit", summary: `The bank received ${formatCents(txn.amountCents, input.currency)} with reference ${txn.reference}.`, sourceRefs: [txn.sourceId] }],
      questions: [], proposedEntry: { kind: "record_bank_item", bankSourceId: txn.sourceId, reversesEntryId: null, ownerId: null, amountCents: txn.amountCents, memo: `Recorded from bank feed (${txn.reference}); unallocated`, evidenceSourceIds: [txn.sourceId] } });
    return out({ outcome: "needs_information", explanation: `${formatCents(txn.amountCents, input.currency)} left the bank (${txn.reference}) with no ledger entry, and nothing says whose money it was.`,
      findings: [{ findingId: "unrecorded-outflow", summary: `The bank paid out ${formatCents(txn.amountCents, input.currency)} with reference ${txn.reference}.`, sourceRefs: [txn.sourceId] }],
      questions: [{ key: "whose-outflow", question: `Whose money paid the ${formatCents(txn.amountCents, input.currency)} outflow ${txn.reference}?` }], proposedEntry: null });
  }
  if (cause.code === "DUPLICATE_POSTING") {
    const [txnId, , duplicate] = cause.sourceIds;
    const entry = records.ledgerEntries.find(e => e.entryId === duplicate);
    if (entry) return out({ outcome: "correction_proposed", explanation: `${txnId} is recorded twice. Reversing the second entry leaves exactly one.`,
      findings: [{ findingId: "recorded-twice", summary: `${entry.entryId} repeats the ${formatCents(Math.abs(entry.amountCents), input.currency)} entry for the same bank item.`, sourceRefs: [entry.entryId] }],
      questions: [], proposedEntry: { kind: "reverse_entry", bankSourceId: null, reversesEntryId: entry.entryId, ownerId: entry.ownerId, amountCents: -entry.amountCents, memo: `Reverse duplicate posting ${entry.entryId}`, evidenceSourceIds: [entry.entryId] } });
  }
  if (cause.code === "LEDGER_ENTRY_WITHOUT_BANK_TXN" || cause.code === "OUTSTANDING_ITEM_AGED") {
    const entry = records.ledgerEntries.find(e => cause.sourceIds.includes(e.entryId));
    if (entry) return out({ outcome: "needs_information", explanation: `The books show ${formatCents(Math.abs(entry.amountCents), input.currency)} (${entry.entryId}) that the bank has not shown. No entry is proposed: the records don't say whether the payment was issued, is still in the mail or was voided.`,
      findings: [{ findingId: "entry-not-at-bank", summary: `The ledger records ${formatCents(Math.abs(entry.amountCents), input.currency)} ${entry.kind}: ${entry.memo}.`, sourceRefs: [entry.entryId] }],
      questions: [{ key: "issued-or-voided", question: `The bank has not shown the ${formatCents(Math.abs(entry.amountCents), input.currency)} entry ${entry.entryId}. Was the payment issued and still outstanding, or was it voided?` }], proposedEntry: null });
  }
  return out({ outcome: "needs_information", explanation: `Code found: ${cause.message} The agent has no safe correcting entry for this; a person decides.`, findings: [], questions: [{ key: "how-to-correct", question: `How should ${cause.code.toLowerCase().replace(/_/g, " ")} (${amount}) be corrected?` }], proposedEntry: null });
}

export const RECON_REPORT_FIELDS = ["schemaVersion", "outcome", "explanation", "findings", "questions", "proposedEntry"] as const;
export interface ReconciliationProvider { mode: "mock" | "creao" | "external"; start(input: ReconciliationInput): Promise<ProviderExecution>; poll(externalRunId: string): Promise<ProviderExecution> }

/** Same provider interface as the investigator. Mock only for now; a CREAO reconciler would plug in here. */
export const mockReconciliationProvider: ReconciliationProvider = {
  mode: "mock",
  async start(input) { return { status: "completed", externalRunId: `mock-reconciler:${input.runId}`, output: mockReconciliation(input) }; },
  async poll() { throw new FinanceProviderError("mock_poll_unsupported", "The simulated reconciler completes without polling."); },
};

export class ReconciliationValidationError extends FinanceProviderError {
  constructor(public readonly details: Array<{ path: string; reason: string }>) { super("validation_failed", `${details[0].path}: ${details[0].reason}`); }
}
function bad(reason: string, path: string): never { throw new ReconciliationValidationError([{ path, reason }]); }
function strict(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!isObject(value)) bad("Expected a JSON object.", path);
  for (const k of keys) if (!(k in value)) bad("Required field is missing.", `${path}.${k}`);
  Object.keys(value).forEach((k, i) => { if (!keys.includes(k)) bad("Unsupported field; only contract fields are allowed.", `${path}[property#${i}]`); });
  return value;
}
const str = (v: unknown, max: number, path: string): string => { if (typeof v !== "string" || !v.trim() || v.length > max) bad(`Expected a nonempty string of at most ${max} characters.`, path); return v; };

/** Strict decoding: every citation must be a record in the frozen input. Nothing is repaired. */
export function validateReconciliationOutput(value: unknown, input: ReconciliationInput): ReconciliationOutput {
  const root = strict(value, ["schemaVersion", "outcome", "explanation", "findings", "questions", "proposedEntry"], "$");
  if (root.schemaVersion !== RECON_OUTPUT_VERSION) bad(`Expected ${RECON_OUTPUT_VERSION}.`, "$.schemaVersion");
  if (root.outcome !== "correction_proposed" && root.outcome !== "needs_information") bad("Unsupported outcome.", "$.outcome");
  const sources = reconciliationTexts(input);
  const refs = (v: unknown, path: string): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.length > 20) bad("Expected 1–20 sourceIds.", path);
    v.forEach((ref, i) => { if (typeof ref !== "string" || !sources.has(ref)) bad("Citation does not exist in the frozen input.", `${path}[${i}]`); });
    return v as string[];
  };
  if (!Array.isArray(root.findings) || root.findings.length > 20) bad("Expected at most 20 findings.", "$.findings");
  const findings = root.findings.map((f, i) => { const p = `$.findings[${i}]`; const row = strict(f, ["findingId", "summary", "sourceRefs"], p); return { findingId: str(row.findingId, 200, `${p}.findingId`), summary: str(row.summary, 2000, `${p}.summary`), sourceRefs: refs(row.sourceRefs, `${p}.sourceRefs`) }; });
  if (!Array.isArray(root.questions) || root.questions.length > 3) bad("Expected at most 3 questions.", "$.questions");
  const questions = root.questions.map((q, i) => { const p = `$.questions[${i}]`; const row = strict(q, ["key", "question"], p); return { key: str(row.key, 100, `${p}.key`), question: str(row.question, 2000, `${p}.question`) }; });
  let proposedEntry: CorrectingEntry | null = null;
  if (root.outcome === "correction_proposed") {
    const e = strict(root.proposedEntry, ["kind", "bankSourceId", "reversesEntryId", "ownerId", "amountCents", "memo", "evidenceSourceIds"], "$.proposedEntry");
    if (e.kind !== "record_bank_item" && e.kind !== "reverse_entry") bad("Unsupported entry kind.", "$.proposedEntry.kind");
    if (e.kind === "record_bank_item" && !input.records.bankTransactions.some(t => t.sourceId === e.bankSourceId)) bad("Must name a bank item from the input.", "$.proposedEntry.bankSourceId");
    if (e.kind === "reverse_entry" && !input.records.ledgerEntries.some(x => x.entryId === e.reversesEntryId)) bad("Must name a ledger entry from the input.", "$.proposedEntry.reversesEntryId");
    if (e.ownerId !== null && !input.records.owners.some(o => o.ownerId === e.ownerId)) bad("Owner must be null or an owner from the input.", "$.proposedEntry.ownerId");
    if (typeof e.amountCents !== "number" || !Number.isSafeInteger(e.amountCents) || e.amountCents === 0) bad("Expected nonzero integer cents.", "$.proposedEntry.amountCents");
    proposedEntry = { kind: e.kind, bankSourceId: e.kind === "record_bank_item" ? e.bankSourceId as string : null, reversesEntryId: e.kind === "reverse_entry" ? e.reversesEntryId as string : null,
      ownerId: e.ownerId as string | null, amountCents: e.amountCents, memo: str(e.memo, 500, "$.proposedEntry.memo"), evidenceSourceIds: refs(e.evidenceSourceIds, "$.proposedEntry.evidenceSourceIds") };
  } else {
    if (root.proposedEntry !== null) bad("needs_information must not propose an entry.", "$.proposedEntry");
    if (questions.length === 0) bad("needs_information requires a question.", "$.questions");
  }
  return { schemaVersion: RECON_OUTPUT_VERSION, outcome: root.outcome, explanation: str(root.explanation, 4000, "$.explanation"), findings, questions, proposedEntry };
}

/** Code check of the explanation's findings: every quoted amount and owner name must be in a cited record. */
export function checkReconciliationFindings(output: ReconciliationOutput, input: ReconciliationInput): Array<{ findingId: string; supported: boolean; missing: string[]; sourceSays: string | null }> {
  const texts = reconciliationTexts(input);
  const names = input.records.owners.map(o => o.name);
  return output.findings.map(f => {
    const cited = f.sourceRefs.map(ref => texts.get(ref) ?? "").join("\n");
    const missing = factsIn(f.summary, names).filter(fact => !fact.found(cited)).map(fact => fact.label);
    return { findingId: f.findingId, supported: missing.length === 0, missing, sourceSays: missing.length ? (texts.get(f.sourceRefs[0]) ?? null) : null };
  });
}

/* ---------- The correction lock ---------- */

export interface CorrectionFailure { rule: "L3" | "L4" | "L6" | "L7" | "R1"; code: string; message: string; sourceIds: string[] }
export interface CorrectionLockResult { allowed: boolean; failures: CorrectionFailure[]; evaluated: CorrectionFailure["rule"][]; resolves: boolean }

/**
 * Ledger rows the correction writes. Append-only: a record entry or a reversal, never an edit.
 * sourceRefs link an entry to bank items, so a recorded item cites only itself; the evidence stays on the correction.
 */
export function correctionEntries(entry: CorrectingEntry, state: AccountLedgerState, correctionId: string, actor: string, now: number, approvalId: string): LedgerEntry[] {
  if (entry.kind === "reverse_entry") {
    const original = state.entries.find(e => e.entryId === entry.reversesEntryId);
    return original ? buildReversalEntries([original], entry.memo, actor, now, approvalId) : [];
  }
  const txn = state.bankTransactions.find(t => t.sourceId === entry.bankSourceId);
  if (!txn) return [];
  return [{ entryId: `correction:${correctionId}`, accountId: state.account.accountId, ownerId: entry.ownerId, amountCents: entry.amountCents, currency: state.account.currency,
    kind: txn.direction === "outflow" ? "disbursement" : "deposit_received", status: "posted", sourceRefs: [txn.sourceId],
    ...(txn.direction === "inflow" ? { fundsSourceId: txn.sourceId } : {}), approvalId, memo: entry.memo, effectiveAt: txn.bookedAt, createdAt: now, createdBy: actor }];
}

/**
 * Runs before a correction is proposed to a person (stage "check", no actor) and again when a person approves it.
 * L3 evidence exists · L4 a different person than the one who requested or recorded the bank item · L6 exact signed cents ·
 * L7 still proposed and not already recorded · R1 the entry actually removes the code-found cause.
 */
export function evaluateCorrection(args: {
  state: AccountLedgerState; known: ReadonlySet<string>; entry: CorrectingEntry; causeKey: string; status: string;
  recheck(state: AccountLedgerState): ThreeWayCheckResult; approver?: string; requestedBy: string; recordedBy?: string | null; now: number;
}): CorrectionLockResult {
  const { state, entry } = args;
  const failures: CorrectionFailure[] = [];
  const evaluated: CorrectionFailure["rule"][] = ["L7", "L3", "L6", "R1"];
  if (args.status !== "proposed") failures.push({ rule: "L7", code: "STATE", message: `This correction is ${args.status}; only a proposed correction can be approved.`, sourceIds: [] });
  if (args.approver !== undefined) {
    evaluated.splice(1, 0, "L4");
    if (args.approver === args.requestedBy) failures.push({ rule: "L4", code: "SELF_APPROVAL", message: "The person who requested this correction can't approve it.", sourceIds: [] });
    else if (args.recordedBy && args.approver === args.recordedBy) failures.push({ rule: "L4", code: "SELF_APPROVAL", message: "A different person must approve the entry than the one who recorded the bank item.", sourceIds: entry.bankSourceId ? [entry.bankSourceId] : [] });
  }
  const unknown = entry.evidenceSourceIds.filter(id => !args.known.has(id));
  if (entry.evidenceSourceIds.length === 0 || unknown.length) failures.push({ rule: "L3", code: "MISSING_EVIDENCE", message: unknown.length ? `Cited evidence is not in our records: ${unknown.join(", ")}.` : "At least one supporting sourceId is required.", sourceIds: unknown });
  if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents === 0) failures.push({ rule: "L6", code: "AMOUNT_INTEGRITY", message: "The entry must be a nonzero whole number of cents.", sourceIds: [] });
  if (entry.kind === "record_bank_item") {
    const txn = state.bankTransactions.find(t => t.sourceId === entry.bankSourceId);
    if (!txn) failures.push({ rule: "L3", code: "MISSING_EVIDENCE", message: "The bank item isn't in this account's bank feed.", sourceIds: entry.bankSourceId ? [entry.bankSourceId] : [] });
    else {
      const signed = txn.direction === "outflow" ? -txn.amountCents : txn.amountCents;
      if (entry.amountCents !== signed) failures.push({ rule: "L6", code: "AMOUNT_INTEGRITY", message: `The bank item is ${formatCents(signed)}; the entry says ${formatCents(entry.amountCents)}.`, sourceIds: [txn.sourceId] });
      if (txn.direction === "outflow" && !state.owners.some(o => o.ownerId === entry.ownerId)) failures.push({ rule: "L3", code: "MISSING_EVIDENCE", message: "An outflow must name the owner whose money it was.", sourceIds: [txn.sourceId] });
      if (state.entries.some(e => e.sourceRefs.includes(txn.sourceId) || e.fundsSourceId === txn.sourceId)) failures.push({ rule: "L7", code: "STATE", message: "This bank item is already recorded in the ledger.", sourceIds: [txn.sourceId] });
    }
  } else {
    const original = state.entries.find(e => e.entryId === entry.reversesEntryId);
    if (!original) failures.push({ rule: "L3", code: "MISSING_EVIDENCE", message: "The entry to reverse isn't in the ledger.", sourceIds: entry.reversesEntryId ? [entry.reversesEntryId] : [] });
    else {
      if (entry.amountCents !== -original.amountCents) failures.push({ rule: "L6", code: "AMOUNT_INTEGRITY", message: `A reversal of ${formatCents(original.amountCents)} must be ${formatCents(-original.amountCents)}.`, sourceIds: [original.entryId] });
      if (state.entries.some(e => e.reversesEntryId === original.entryId)) failures.push({ rule: "L7", code: "STATE", message: "That entry is already reversed.", sourceIds: [original.entryId] });
      if (original.kind === "allocation" && activeAllocations(state.entries, original.fundsSourceId ?? "").length === 0) failures.push({ rule: "L7", code: "STATE", message: "That allocation is no longer active.", sourceIds: [original.entryId] });
    }
  }
  let resolves = false;
  if (failures.length === 0) {
    const mismatches = (result: ThreeWayCheckResult) => new Set(result.causes.filter(c => c.severity === "mismatch").map(causeKey));
    const before = mismatches(args.recheck(state));
    const after = mismatches(args.recheck({ ...state, entries: [...state.entries, ...correctionEntries(entry, state, "dry-run", args.approver ?? "system:correction-check", args.now, "dry-run")] }));
    const introduced = [...after].filter(key => !before.has(key));
    resolves = !after.has(args.causeKey) && introduced.length === 0;
    if (after.has(args.causeKey)) failures.push({ rule: "R1", code: "DOES_NOT_RESOLVE", message: "Code re-ran the three-way check with this entry and the mismatch is still there.", sourceIds: [] });
    else if (introduced.length) failures.push({ rule: "R1", code: "INTRODUCES_MISMATCH", message: `The entry would create a new mismatch: ${introduced.join(", ")}.`, sourceIds: [] });
  }
  return { allowed: failures.length === 0, failures, evaluated, resolves };
}
