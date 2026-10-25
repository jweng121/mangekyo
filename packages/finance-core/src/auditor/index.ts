import type { LedgerEntry, MoneyProposal, NormalizedBankTransaction, NormalizedDocument, NormalizedObligation, NormalizedOwner, ProposalTransition, TrustDispute } from "@mangekyo/contracts";
import type { AuditFinding, AuditReport, AuditRuleId, AuditorScorecard } from "@mangekyo/contracts/orchestration";
import { FinanceProviderError, type ProviderExecution } from "../agent/types";
import { isObject } from "../agent/creaoClient";
import { contingencyFeeCents } from "../gateway";
import { formatCents } from "../intake/cents";
import { firmOwnerIds, type AccountLedgerState } from "../ledger";

/**
 * Trust Compliance Auditor: reviews POSTED activity for a period against the trust account rules and writes a report.
 * It never changes money. Code applies every rule first; an agent may add findings only when they cite entries from the input.
 */

export const AUDIT_INPUT_VERSION = "finance-trust-audit-input/v1" as const;
export const AUDIT_OUTPUT_VERSION = "finance-trust-audit-output/v1" as const;
export const AUDIT_INSTRUCTION_VERSION = "finance-trust-auditor/v1" as const;
export const AUDIT_REPORT_FIELDS = ["schemaVersion", "summary", "findings", "questions"] as const;
export const AUDIT_RULES: Array<{ ruleId: AuditRuleId; rule: string }> = [
  { ruleId: "A1_NEGATIVE_CLIENT_BALANCE", rule: "No client's balance goes below zero." },
  { ruleId: "A2_GOOD_FUNDS", rule: "No payout leaves trust before the deposit funding it has cleared." },
  { ruleId: "A3_COMMINGLING", rule: "The firm's own money does not sit in the trust account." },
  { ruleId: "A4_FEE_NOT_EARNED", rule: "A fee moves to the firm only once earned: an approved invoice, or a signed settlement fee line matching the signed fee agreement." },
  { ruleId: "A5_DISPUTED_FUNDS_PAID", rule: "Disputed amounts stay in trust until a person records the resolution." },
  { ruleId: "A6_SETTLEMENT_SPLIT", rule: "Settlement payouts match the signed settlement statement exactly." },
  { ruleId: "A7_MONTHLY_RECONCILIATION", rule: "Every month with activity has a monthly reconciliation signed off by a person." },
  { ruleId: "A8_SECOND_APPROVER_AND_EVIDENCE", rule: "Every posted entry has a second approver and evidence; every reversal links its entry." },
];

export interface AuditInput {
  schemaVersion: typeof AUDIT_INPUT_VERSION;
  instructionVersion: typeof AUDIT_INSTRUCTION_VERSION;
  runId: string;
  accountId: string;
  currency: string;
  period: { from: number; to: number };
  owners: Array<Pick<NormalizedOwner, "ownerId" | "sourceId" | "name" | "ownerKind">>;
  entries: LedgerEntry[];
  bankTransactions: NormalizedBankTransaction[];
  proposals: MoneyProposal[];
  transitions: ProposalTransition[];
  documents: Array<Pick<NormalizedDocument, "sourceId" | "title" | "signed" | "matterId" | "lines" | "feeBasisPoints" | "namedOwnerSourceIds">>;
  invoices: NormalizedObligation[];
  disputes: TrustDispute[];
  /** Months (YYYY-MM) with a signed monthly reconciliation. */
  signedMonths: string[];
  codeFindings: AuditFinding[];
}

export interface AuditOutput {
  schemaVersion: typeof AUDIT_OUTPUT_VERSION;
  summary: string;
  findings: Array<Omit<AuditFinding, "foundBy">>;
  questions: Array<{ key: string; question: string; sourceRefs: string[] }>;
}

export const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);

/** Code applies every rule to the posted history in the period. Deterministic, integer cents, nothing changed. */
export function codeAudit(args: Omit<AuditInput, "schemaVersion" | "instructionVersion" | "codeFindings">): AuditFinding[] {
  const money = (cents: number) => formatCents(cents, args.currency);
  const findings: AuditFinding[] = [];
  let n = 0;
  const add = (ruleId: AuditRuleId, severity: AuditFinding["severity"], message: string, entryIds: string[], sourceIds: string[], ownerId: string | null, amountCents: number | null) =>
    findings.push({ findingId: `${ruleId}:${++n}`, ruleId, severity, message, entryIds, sourceIds, ownerId, amountCents, foundBy: "code" });
  const ownerName = (id: string | null) => args.owners.find(o => o.ownerId === id)?.name ?? id ?? "unallocated";
  const ownerSource = (id: string | null) => args.owners.find(o => o.ownerId === id)?.sourceId ?? null;
  const bank = new Map(args.bankTransactions.map(t => [t.sourceId, t]));
  const proposals = new Map(args.proposals.map(p => [p.proposalId, p]));
  const inPeriod = args.entries.filter(e => e.effectiveAt >= args.period.from && e.effectiveAt <= args.period.to && e.currency === args.currency);
  const sorted = [...args.entries].filter(e => e.currency === args.currency).sort((a, b) => a.effectiveAt - b.effectiveAt || a.entryId.localeCompare(b.entryId));
  const firm = firmOwnerIds({ owners: args.owners as NormalizedOwner[] });

  // A1 negative client balance at any point (running balance by owner, over the whole history up to the period end).
  const running = new Map<string, number>();
  const flagged = new Set<string>();
  for (const e of sorted) {
    if (e.ownerId === null || e.effectiveAt > args.period.to) continue;
    const next = (running.get(e.ownerId) ?? 0) + e.amountCents;
    running.set(e.ownerId, next);
    if (next < 0 && e.effectiveAt >= args.period.from && !flagged.has(e.ownerId)) { flagged.add(e.ownerId); add("A1_NEGATIVE_CLIENT_BALANCE", "violation", `${ownerName(e.ownerId)}'s balance went to ${money(next)} after ${e.entryId}; a client's trust balance can never be below zero.`, [e.entryId], [ownerSource(e.ownerId) ?? e.entryId], e.ownerId, next); }
  }

  // A2 good funds: a payout whose owner's cleared money (from deposits cleared at the time) could not cover it.
  for (const e of inPeriod.filter(e => e.kind === "disbursement" && e.ownerId !== null && e.amountCents < 0)) {
    const before = sorted.filter(x => x.ownerId === e.ownerId && (x.effectiveAt < e.effectiveAt || (x.effectiveAt === e.effectiveAt && x.entryId < e.entryId)));
    const cleared = before.reduce((total, x) => {
      if (x.fundsSourceId) { const t = bank.get(x.fundsSourceId); return total + (t && t.clearing === "cleared" && t.bookedAt <= e.effectiveAt ? x.amountCents : 0); }
      return total + (x.clearedCents ?? x.amountCents);
    }, 0);
    if (cleared + e.amountCents < 0) {
      const pending = before.filter(x => x.fundsSourceId && bank.get(x.fundsSourceId)?.clearing !== "cleared").map(x => x.fundsSourceId!);
      add("A2_GOOD_FUNDS", "violation", `${money(-e.amountCents)} was paid out for ${ownerName(e.ownerId)} (${e.entryId}) when only ${money(Math.max(0, cleared))} of their money had cleared${pending.length ? `; ${[...new Set(pending)].join(", ")} had not cleared` : ""}.`, [e.entryId], [...new Set(pending)], e.ownerId, e.amountCents);
    }
  }

  // A3 commingling: firm money in trust at the period end.
  for (const [ownerId, balance] of running) if (firm.has(ownerId) && balance > 0) add("A3_COMMINGLING", "violation", `${money(balance)} of the firm's own money (${ownerName(ownerId)}) was in the trust account at the period end.`, sorted.filter(e => e.ownerId === ownerId).map(e => e.entryId).slice(-5), [ownerSource(ownerId) ?? ownerId], ownerId, balance);

  // A4 fee not earned: fee entries and attorney_fee payouts need an approved invoice or a signed settlement fee line matching the fee agreement.
  const feeEntries = inPeriod.filter(e => e.ownerId !== null && e.amountCents < 0 && (e.kind === "fee" || proposals.get(e.proposalId ?? "")?.payoutKind === "attorney_fee" || /\battorney fee\b/i.test(e.memo)));
  for (const e of feeEntries) {
    const source = ownerSource(e.ownerId);
    const proposal = proposals.get(e.proposalId ?? "");
    const invoices = args.invoices.filter(o => o.kind === "invoice" && o.status === "approved" && o.ownerSourceId === source && (proposal?.matterId === undefined || o.matterId === undefined || o.matterId === proposal.matterId));
    const byInvoice = invoices.length > 0 && -e.amountCents <= invoices.reduce((t, o) => t + (o.amountCents ?? 0), 0);
    const statements = args.documents.filter(d => d.signed && d.lines?.length && (d.namedOwnerSourceIds.includes(source ?? "") || (proposal?.matterId && d.matterId === proposal.matterId)));
    const agreements = args.documents.filter(d => d.signed && d.feeBasisPoints && (d.namedOwnerSourceIds.includes(source ?? "") || (proposal?.matterId && d.matterId === proposal.matterId)));
    const byContingency = statements.some(s => s.lines!.some(l => l.kind === "attorney_fee" && l.amountCents === -e.amountCents && agreements.some(a => contingencyFeeCents(s.lines!.reduce((t, x) => t + x.amountCents, 0), a.feeBasisPoints!) === l.amountCents)));
    if (!byInvoice && !byContingency) add("A4_FEE_NOT_EARNED", "violation", `A ${money(-e.amountCents)} fee left ${ownerName(e.ownerId)}'s trust balance (${e.entryId}) with no approved invoice and no signed settlement fee line matching a signed fee agreement.`, [e.entryId], [...(source ? [source] : []), ...e.sourceRefs], e.ownerId, e.amountCents);
  }

  // A5 disputed funds paid while a dispute was open.
  for (const e of inPeriod.filter(e => e.kind === "disbursement" && e.ownerId !== null && e.amountCents < 0)) {
    const open = args.disputes.filter(d => d.ownerId === e.ownerId && d.recordedAt <= e.effectiveAt && (d.resolvedAt === undefined || d.resolvedAt > e.effectiveAt));
    if (!open.length) continue;
    const disputed = open.reduce((t, d) => t + d.amountCents, 0);
    const balanceAfter = sorted.filter(x => x.ownerId === e.ownerId && (x.effectiveAt < e.effectiveAt || (x.effectiveAt === e.effectiveAt && x.entryId <= e.entryId))).reduce((t, x) => t + x.amountCents, 0);
    if (balanceAfter < disputed) add("A5_DISPUTED_FUNDS_PAID", "violation", `${money(-e.amountCents)} left ${ownerName(e.ownerId)}'s balance (${e.entryId}) while ${money(disputed)} was disputed and unresolved, leaving ${money(balanceAfter)}.`, [e.entryId], open.map(d => d.disputeId), e.ownerId, e.amountCents);
  }

  // A6 settlement split: payouts tagged with a settlement statement must match one of its lines exactly.
  for (const e of inPeriod.filter(e => e.kind === "disbursement" && e.proposalId && proposals.get(e.proposalId)?.settlementSourceId)) {
    const p = proposals.get(e.proposalId!)!;
    const statement = args.documents.find(d => d.sourceId === p.settlementSourceId);
    if (!statement?.signed || !statement.lines?.some(l => l.kind === (p.payoutKind ?? "other") && l.amountCents === -e.amountCents)) add("A6_SETTLEMENT_SPLIT", "violation", `${money(-e.amountCents)} ${(p.payoutKind ?? "other").replace(/_/g, " ")} for ${ownerName(e.ownerId)} (${e.entryId}) does not match a line of the signed settlement statement ${p.settlementSourceId}.`, [e.entryId], [p.settlementSourceId!], e.ownerId, e.amountCents);
  }

  // A7 monthly reconciliation signed for every month with activity.
  const months = [...new Set(inPeriod.filter(e => !e.entryId.startsWith("import:")).map(e => monthOf(e.effectiveAt)))].sort();
  for (const month of months) if (!args.signedMonths.includes(month)) add("A7_MONTHLY_RECONCILIATION", "warning", `${month} has posted activity but no monthly reconciliation signed off by a person.`, inPeriod.filter(e => monthOf(e.effectiveAt) === month).map(e => e.entryId).slice(0, 5), [], null, null);

  // A8 second approver and evidence; reversals must link an entry.
  const entryIds = new Set(args.entries.map(e => e.entryId));
  for (const e of inPeriod) {
    if (e.kind === "reversal" && (!e.reversesEntryId || !entryIds.has(e.reversesEntryId))) add("A8_SECOND_APPROVER_AND_EVIDENCE", "violation", `Reversal ${e.entryId} (${money(e.amountCents)}) does not link to an entry it reverses.`, [e.entryId], e.sourceRefs, e.ownerId, e.amountCents);
    if (e.sourceRefs.length === 0 && !e.entryId.startsWith("import:")) add("A8_SECOND_APPROVER_AND_EVIDENCE", "violation", `Entry ${e.entryId} (${money(e.amountCents)}) cites no evidence.`, [e.entryId], [], e.ownerId, e.amountCents);
    if (e.proposalId) {
      const p = proposals.get(e.proposalId);
      const approval = args.transitions.find(t => t.proposalId === e.proposalId && t.to === "approved");
      const approver = approval?.actor ?? p?.approvedBy ?? null;
      if (!p) add("A8_SECOND_APPROVER_AND_EVIDENCE", "warning", `Entry ${e.entryId} names proposal ${e.proposalId}, which is not in the records.`, [e.entryId], [e.proposalId], e.ownerId, e.amountCents);
      else if (!approver) add("A8_SECOND_APPROVER_AND_EVIDENCE", "violation", `Entry ${e.entryId} posted from ${p.proposalId} with no recorded approval.`, [e.entryId], [p.proposalId], e.ownerId, e.amountCents);
      else if (approver.trim().toLowerCase() === p.requestedBy.trim().toLowerCase() || e.createdBy.trim().toLowerCase() === p.requestedBy.trim().toLowerCase()) add("A8_SECOND_APPROVER_AND_EVIDENCE", "violation", `${p.requestedBy} requested ${p.proposalId} and also approved or posted it (${e.entryId}); a second person must approve every entry.`, [e.entryId], [p.proposalId], e.ownerId, e.amountCents);
    } else if ((e.kind === "disbursement" || e.kind === "allocation" || e.kind === "fee") && !e.approvalId && !e.entryId.startsWith("import:") && !e.entryId.startsWith("correction:") && !e.entryId.startsWith("record:")) {
      add("A8_SECOND_APPROVER_AND_EVIDENCE", "violation", `Entry ${e.entryId} (${money(e.amountCents)}) was posted with no proposal and no recorded approval.`, [e.entryId], e.sourceRefs, e.ownerId, e.amountCents);
    }
  }
  // One finding per entry per rule.
  const seen = new Set<string>();
  return findings.filter(f => { const key = `${f.ruleId}:${f.entryIds.join(",")}:${f.ownerId}`; return !seen.has(key) && !!seen.add(key); });
}

export function buildAuditInput(args: Omit<AuditInput, "schemaVersion" | "instructionVersion" | "codeFindings">): AuditInput {
  return { schemaVersion: AUDIT_INPUT_VERSION, instructionVersion: AUDIT_INSTRUCTION_VERSION, ...args, codeFindings: codeAudit(args) };
}

/** The mock auditor confirms code's findings and adds nothing; a real model may add cited findings. */
export function mockAudit(input: AuditInput): AuditOutput {
  const byRule = new Map<string, number>();
  for (const f of input.codeFindings) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);
  return {
    schemaVersion: AUDIT_OUTPUT_VERSION,
    summary: `Reviewed ${input.entries.length} posted entries, ${input.proposals.length} proposals and ${input.owners.length} owners from ${new Date(input.period.from).toISOString().slice(0, 10)} to ${new Date(input.period.to).toISOString().slice(0, 10)}. ${input.codeFindings.length === 0 ? "No rule was broken." : `${input.codeFindings.length} finding(s): ${[...byRule].map(([r, c]) => `${r} ×${c}`).join(", ")}.`}`,
    findings: input.codeFindings.map(({ foundBy, ...f }) => { void foundBy; return f; }),
    questions: [],
  };
}
export const mockAuditorProvider = {
  mode: "mock" as const,
  async start(input: AuditInput): Promise<ProviderExecution> { return { status: "completed", externalRunId: `mock-auditor:${input.runId}`, output: mockAudit(input) }; },
  async poll(): Promise<ProviderExecution> { throw new FinanceProviderError("mock_poll_unsupported", "The simulated auditor completes without polling."); },
};

export class AuditValidationError extends FinanceProviderError {
  constructor(public readonly details: Array<{ path: string; reason: string }>) { super("validation_failed", `${details[0].path}: ${details[0].reason}`); }
}
function bad(reason: string, path: string): never { throw new AuditValidationError([{ path, reason }]); }
function strict(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!isObject(value)) bad("Expected a JSON object.", path);
  for (const k of keys) if (!(k in value)) bad("Required field is missing.", `${path}.${k}`);
  Object.keys(value).forEach((k, i) => { if (!keys.includes(k)) bad("Unsupported field; only contract fields are allowed.", `${path}[property#${i}]`); });
  return value;
}
const str = (v: unknown, max: number, path: string): string => { if (typeof v !== "string" || !v.trim() || v.length > max) bad(`Expected a nonempty string of at most ${max} characters.`, path); return v; };

/** Strict: every finding names a known rule and cites entries and sources from the input. At most 3 questions. Nothing is repaired. */
export function validateAuditOutput(value: unknown, input: AuditInput): AuditOutput {
  const root = strict(value, [...AUDIT_REPORT_FIELDS], "$");
  if (root.schemaVersion !== AUDIT_OUTPUT_VERSION) bad(`Expected ${AUDIT_OUTPUT_VERSION}.`, "$.schemaVersion");
  const rules = new Set(AUDIT_RULES.map(r => r.ruleId));
  const entryIds = new Set(input.entries.map(e => e.entryId));
  const known = new Set([...input.owners.map(o => o.sourceId), ...input.bankTransactions.map(t => t.sourceId), ...input.proposals.map(p => p.proposalId), ...input.documents.map(d => d.sourceId), ...input.invoices.map(i => i.sourceId), ...input.disputes.map(d => d.disputeId), ...entryIds]);
  const owners = new Set(input.owners.map(o => o.ownerId));
  if (!Array.isArray(root.findings) || root.findings.length > 200) bad("Expected at most 200 findings.", "$.findings");
  const seen = new Set<string>();
  const findings = root.findings.map((f, i) => {
    const p = `$.findings[${i}]`;
    const row = strict(f, ["findingId", "ruleId", "severity", "message", "entryIds", "sourceIds", "ownerId", "amountCents"], p);
    const findingId = str(row.findingId, 200, `${p}.findingId`);
    if (seen.has(findingId)) bad("Duplicate findingId.", `${p}.findingId`); seen.add(findingId);
    if (typeof row.ruleId !== "string" || !rules.has(row.ruleId as AuditRuleId)) bad("Unknown rule ID.", `${p}.ruleId`);
    if (row.severity !== "violation" && row.severity !== "warning") bad("Unsupported severity.", `${p}.severity`);
    if (!Array.isArray(row.entryIds) || row.entryIds.length > 50 || row.entryIds.some(id => typeof id !== "string" || !entryIds.has(id))) bad("entryIds must be ledger entries from the input.", `${p}.entryIds`);
    if (!Array.isArray(row.sourceIds) || row.sourceIds.length > 50 || row.sourceIds.some(id => typeof id !== "string" || !known.has(id))) bad("sourceIds must be records from the input.", `${p}.sourceIds`);
    if ((row.entryIds as string[]).length === 0 && (row.sourceIds as string[]).length === 0 && row.ruleId !== "A7_MONTHLY_RECONCILIATION") bad("A finding must cite at least one entry or source.", `${p}.entryIds`);
    if (row.ownerId !== null && (typeof row.ownerId !== "string" || !owners.has(row.ownerId))) bad("ownerId must be null or an owner from the input.", `${p}.ownerId`);
    if (row.amountCents !== null && (typeof row.amountCents !== "number" || !Number.isSafeInteger(row.amountCents))) bad("amountCents must be null or integer cents.", `${p}.amountCents`);
    return { findingId, ruleId: row.ruleId as AuditRuleId, severity: row.severity as AuditFinding["severity"], message: str(row.message, 1000, `${p}.message`), entryIds: row.entryIds as string[], sourceIds: row.sourceIds as string[], ownerId: row.ownerId as string | null, amountCents: row.amountCents as number | null };
  });
  if (!Array.isArray(root.questions) || root.questions.length > 3) bad("Expected at most 3 questions.", "$.questions");
  const questions = root.questions.map((q, i) => { const p = `$.questions[${i}]`; const row = strict(q, ["key", "question", "sourceRefs"], p); const sourceRefs = row.sourceRefs; if (!Array.isArray(sourceRefs) || sourceRefs.some(id => typeof id !== "string" || !known.has(id))) bad("sourceRefs must be records from the input.", `${p}.sourceRefs`); return { key: str(row.key, 100, `${p}.key`), question: str(row.question, 2000, `${p}.question`), sourceRefs: sourceRefs as string[] }; });
  return { schemaVersion: AUDIT_OUTPUT_VERSION, summary: str(root.summary, 4000, "$.summary"), findings, questions };
}

/** Code's findings always stand; the agent may only add cited ones. Nothing is removed. */
export function combineAuditFindings(code: AuditFinding[], agent: AuditOutput): AuditFinding[] {
  const key = (f: { ruleId: string; entryIds: string[]; ownerId: string | null }) => `${f.ruleId}:${[...f.entryIds].sort().join(",")}:${f.ownerId}`;
  const have = new Set(code.map(key));
  return [...code, ...agent.findings.filter(f => !have.has(key(f))).map(f => ({ ...f, foundBy: "agent" as const }))];
}

export function auditReport(args: { reportId: string; input: AuditInput; findings: AuditFinding[]; summary: string; mode: AuditReport["mode"]; model: string; generatedAt: number; generatedBy: string }): AuditReport {
  const { input } = args;
  const months = new Set(input.entries.filter(e => e.effectiveAt >= input.period.from && e.effectiveAt <= input.period.to).map(e => monthOf(e.effectiveAt)));
  return {
    reportId: args.reportId, accountId: input.accountId, period: input.period, agent: "auditor", mode: args.mode, model: args.model, instructionVersion: AUDIT_INSTRUCTION_VERSION,
    status: args.findings.length ? "findings" : "clean", findings: args.findings, summary: args.summary,
    reviewed: { entries: input.entries.length, proposals: input.proposals.length, owners: input.owners.length, months: months.size }, generatedAt: args.generatedAt, generatedBy: args.generatedBy,
  };
}

/* ---------- Auditor drill: four planted mistakes in posted history ---------- */

export type DrillKey = "self-approved" | "payout-before-cleared" | "fee-no-invoice" | "unlinked-reversal";
export interface DrillPlant { key: DrillKey; label: string; entryId: string; ruleId: AuditRuleId; mistake: string }

/** Entry IDs are fixed so the scorecard can match findings to plants. */
export const DRILL_PLANTS: DrillPlant[] = [
  { key: "self-approved", label: "Self-approved entry", entryId: "drill:self-approved:entry:1", ruleId: "A8_SECOND_APPROVER_AND_EVIDENCE", mistake: "Riley requested a $1,500.00 payment for Westbrook HOA and approved and posted it herself." },
  { key: "payout-before-cleared", label: "Payout before funds cleared", entryId: "drill:uncleared:entry:1", ruleId: "A2_GOOD_FUNDS", mistake: "$56,000.00 was paid to Maria Delgado while Harborline's $85,000.00 check was still pending." },
  { key: "fee-no-invoice", label: "Fee taken with no invoice", entryId: "drill:fee:entry:1", ruleId: "A4_FEE_NOT_EARNED", mistake: "A $3,000.00 attorney fee moved from Chen & Park Holdings to the firm with no approved invoice." },
  { key: "unlinked-reversal", label: "Unlinked reversal", entryId: "drill:reversal:entry:1", ruleId: "A8_SECOND_APPROVER_AND_EVIDENCE", mistake: "A $1,200.00 reversal for James Nguyen names an entry that does not exist." },
];

/** Caught: a finding under the planted rule cites the planted entry. False alarm: a violation on an entry nobody planted. */
export function scoreAudit(accountId: string, report: AuditReport | null, plants: DrillPlant[] = DRILL_PLANTS): AuditorScorecard {
  const planted = plants.map(p => ({ key: p.key, label: p.label, entryId: p.entryId, ruleId: p.ruleId, status: report?.findings.some(f => f.ruleId === p.ruleId && f.entryIds.includes(p.entryId)) ? "caught" as const : "missed" as const }));
  const plantedIds = new Set(plants.map(p => p.entryId));
  const falseAlarmFindings = (report?.findings ?? []).filter(f => f.severity === "violation" && f.ruleId !== "A7_MONTHLY_RECONCILIATION" && !f.entryIds.some(id => plantedIds.has(id))).map(f => ({ findingId: f.findingId, ruleId: f.ruleId, message: f.message }));
  const caught = planted.filter(p => p.status === "caught").length;
  return { accountId, reportId: report?.reportId ?? null, planted, caught, missed: planted.length - caught, falseAlarms: falseAlarmFindings.length, falseAlarmFindings,
    line: report ? `Caught ${caught} of ${planted.length} · missed ${planted.length - caught} · false alarms ${falseAlarmFindings.length}` : "No audit report yet" };
}
