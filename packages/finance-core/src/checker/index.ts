import type { ClaimCheck, ClaimCheckResult, ClaimVerdict, FinanceAgentInput, FinanceAgentOutput } from "@mangekyo/contracts";
import { formatCents } from "../intake/cents";

/** Agent 2. Runs after an investigation output passes validation and before anything reaches a person. */

export type CheckerAgentMode = "off" | "mock" | "creao";

export interface AgentVerdict { findingId: string; verdict: ClaimVerdict; reason: string }

/** Same shape as the investigator's provider: mock now, a separate CREAO agent later. */
export interface ClaimCheckerAgent {
  mode: "mock" | "creao";
  check(input: FinanceAgentInput, output: FinanceAgentOutput, code: ClaimCheck[]): Promise<AgentVerdict[]>;
}

/** Text of every record the investigator could cite, keyed by sourceId. */
export function sourceTexts(input: FinanceAgentInput): Map<string, string> {
  const r = input.records;
  const texts = new Map<string, string>();
  const add = (id: string, text: string) => texts.set(id, `${texts.get(id) ?? ""}\n${text}`.trim());
  for (const t of r.transactions) add(t.sourceId, `${formatCents(t.amountCents, t.currency)} ${t.description} cleared ${new Date(t.clearedAt).toISOString()}`);
  for (const t of r.bankTransactions ?? []) add(t.sourceId, `${formatCents(t.amountCents, t.currency)} ${t.direction} ${t.reference} ${t.counterparty} ${new Date(t.bookedAt).toISOString()}`);
  for (const d of r.documents) add(d.sourceId, `${d.title}\n${d.text}`);
  for (const i of r.invoices) add(i.sourceId, i.excerpt);
  for (const a of r.agreements) add(a.sourceId, a.excerpt);
  for (const o of r.obligations ?? []) add(o.sourceId, o.excerpt);
  for (const b of r.ownerLedgerBalances ?? []) add(b.sourceId, `${b.name} posted ${formatCents(b.postedCents)} available ${formatCents(b.availableCents)}`);
  for (const c of input.humanClarifications) add(c.sourceId, `${c.question}\n${c.answer}`);
  for (const p of input.approvedPolicies) add(p.sourceId, p.statement);
  return texts;
}

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g;
const CENTS = /\b(\d{1,3}(?:,\d{3})+|\d+)\s*(?:integer\s+)?cents\b/gi;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const REFERENCE = /\b(?:[A-Z]+-)*(?:INV|BILL|DOC|PAY)-[A-Z0-9-]*\d[A-Z0-9]*\b/g;

function amounts(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(MONEY)) out.add(Number(m[1].replace(/,/g, "")) * 100 + Number(m[2] ?? 0));
  for (const m of text.matchAll(CENTS)) out.add(Number(m[1].replace(/,/g, "")));
  return out;
}

/** Facts quoted in a claim that its cited records must contain: amounts, dates, invoice/document numbers, owner names. */
export function claimFacts(claim: string, input: FinanceAgentInput): Array<{ label: string; found(text: string): boolean }> {
  const facts: Array<{ label: string; found(text: string): boolean }> = [];
  for (const cents of amounts(claim)) facts.push({ label: formatCents(cents), found: text => amounts(text).has(cents) });
  for (const date of new Set(claim.match(DATE) ?? [])) facts.push({ label: date, found: text => text.includes(date) });
  for (const ref of new Set(claim.match(REFERENCE) ?? [])) facts.push({ label: ref, found: text => text.includes(ref) });
  for (const owner of input.records.owners) if (claim.includes(owner.name)) facts.push({ label: owner.name, found: text => text.includes(owner.name) });
  return facts;
}

/** Code part (always on): every cited sourceId exists, and every quoted fact appears in at least one cited record. */
export function codeCheckClaims(output: FinanceAgentOutput, input: FinanceAgentInput): ClaimCheck[] {
  const texts = sourceTexts(input);
  return output.findings.map(finding => {
    const claim = finding.summary.replace(/^SIMULATED: /, "");
    const base = { findingId: finding.findingId, claim, sourceRefs: finding.sourceRefs, checkedBy: "code" as const };
    const unknown = finding.sourceRefs.filter(ref => !texts.has(ref));
    const firstSays = (texts.get(finding.sourceRefs.find(ref => texts.has(ref)) ?? "") ?? "").replace(/\s+/g, " ").slice(0, 300) || null;
    if (unknown.length) return { ...base, verdict: "not_supported" as const, reason: `Cited sources are not in the frozen input: ${unknown.join(", ")}.`, facts: [], missing: unknown, sourceSays: firstSays };
    const cited = finding.sourceRefs.map(ref => texts.get(ref)!).join("\n");
    const facts = claimFacts(claim, input);
    const missing = facts.filter(f => !f.found(cited)).map(f => f.label);
    if (missing.length) return { ...base, verdict: "not_supported" as const, reason: `The cited records don't contain: ${missing.join(", ")}.`, facts: facts.map(f => f.label), missing, sourceSays: firstSays };
    if (facts.length === 0) return { ...base, checkedBy: "none" as const, verdict: "not_checkable" as const, reason: "The claim quotes no amount, date, reference or name that code can check.", facts: [], missing: [], sourceSays: null };
    return { ...base, verdict: "supported" as const, reason: `Every quoted fact appears in the cited records: ${facts.map(f => f.label).join(", ")}.`, facts: facts.map(f => f.label), missing: [], sourceSays: null };
  });
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{5,}/g) ?? []);

/** Deterministic stand-in for the CREAO checker: judges only claims code couldn't, by word overlap with the cited records. */
export const mockClaimChecker: ClaimCheckerAgent = {
  mode: "mock",
  async check(input, _output, code) {
    const texts = sourceTexts(input);
    return code.filter(c => c.verdict === "not_checkable").map(c => {
      const claimWords = words(c.claim);
      const overlap = c.sourceRefs.some(ref => [...words(texts.get(ref) ?? "")].filter(w => claimWords.has(w)).length >= 2);
      return overlap
        ? { findingId: c.findingId, verdict: "supported", reason: "Mock checker: the cited records discuss the same subject in their own words." }
        : { findingId: c.findingId, verdict: "not_checkable", reason: "Mock checker: the cited records don't address this claim either way." };
    });
  },
};

/** Code verdicts are final when code could decide; the agent only judges what code could not. */
export function combineVerdicts(code: ClaimCheck[], agent: AgentVerdict[]): ClaimCheck[] {
  return code.map(c => {
    if (c.verdict !== "not_checkable") return c;
    const a = agent.find(row => row.findingId === c.findingId);
    return a ? { ...c, verdict: a.verdict, checkedBy: "agent" as const, reason: a.reason } : c;
  });
}

export async function checkClaims(input: FinanceAgentInput, output: FinanceAgentOutput, agentMode: CheckerAgentMode, agent: ClaimCheckerAgent | null, now: number): Promise<ClaimCheckResult> {
  const code = codeCheckClaims(output, input);
  const claims = agent && agentMode !== "off" ? combineVerdicts(code, await agent.check(input, output, code)) : code;
  return { schemaVersion: "finance-claim-check/v1", agentMode, status: claims.some(c => c.verdict === "not_supported") ? "rejected" : "passed", claims, checkedAt: now };
}
