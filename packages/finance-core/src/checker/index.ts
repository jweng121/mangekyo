import type { ClaimCheck, ClaimCheckResult, ClaimVerdict, FinanceAgentInput, FinanceAgentOutput } from "@mangekyo/contracts";
import { formatCents } from "../intake/cents";
import { FinanceProviderError, type ProviderExecution } from "../agent/types";
import { CreaoAppClient, isObject } from "../agent/creaoClient";
import { extractCreaoReport } from "../agent/creaoResult";

/** Agent 2. Runs after an investigation output passes validation and before anything reaches a person. */

/** "off" only appears on runs saved before CHECKER_MODE existed; new runs are checked by mock or creao. */
export type CheckerAgentMode = "off" | "mock" | "creao";

export interface AgentVerdict { findingId: string; verdict: ClaimVerdict; reason: string; sourceSays?: string | null }

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

export interface ClaimFact { label: string; found(text: string): boolean }

/** Facts quoted in a claim that its cited records must contain: amounts, dates, invoice/document numbers, owner names. */
export function factsIn(claim: string, ownerNames: string[]): ClaimFact[] {
  const facts: ClaimFact[] = [];
  for (const cents of amounts(claim)) facts.push({ label: formatCents(cents), found: text => amounts(text).has(cents) });
  for (const date of new Set(claim.match(DATE) ?? [])) facts.push({ label: date, found: text => text.includes(date) });
  for (const ref of new Set(claim.match(REFERENCE) ?? [])) facts.push({ label: ref, found: text => text.includes(ref) });
  for (const name of new Set(ownerNames)) if (claim.includes(name)) facts.push({ label: name, found: text => text.includes(name) });
  return facts;
}

export function claimFacts(claim: string, input: FinanceAgentInput): ClaimFact[] {
  return factsIn(claim, input.records.owners.map(o => o.name));
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

/**
 * A code-found contradiction is final. The agent may also find one code missed (the stricter answer wins),
 * and it decides the claims code could not check. It never upgrades a claim code couldn't confirm by itself.
 */
export function combineVerdicts(code: ClaimCheck[], agent: AgentVerdict[]): ClaimCheck[] {
  return code.map(c => {
    if (c.verdict === "not_supported") return c;
    const a = agent.find(row => row.findingId === c.findingId);
    if (!a) return c;
    if (a.verdict === "not_supported") return { ...c, verdict: "not_supported" as const, checkedBy: "agent" as const, reason: a.reason, sourceSays: a.sourceSays ?? c.sourceSays };
    if (c.verdict !== "not_checkable") return c;
    return { ...c, verdict: a.verdict, checkedBy: "agent" as const, reason: a.reason };
  });
}

export function claimCheckResult(claims: ClaimCheck[], agentMode: CheckerAgentMode, now: number): ClaimCheckResult {
  return { schemaVersion: "finance-claim-check/v1", agentMode, status: claims.some(c => c.verdict === "not_supported") ? "rejected" : "passed", claims, checkedAt: now };
}

export async function checkClaims(input: FinanceAgentInput, output: FinanceAgentOutput, agentMode: CheckerAgentMode, agent: ClaimCheckerAgent | null, now: number): Promise<ClaimCheckResult> {
  const code = codeCheckClaims(output, input);
  const claims = agent && agentMode !== "off" ? combineVerdicts(code, await agent.check(input, output, code)) : code;
  return claimCheckResult(claims, agentMode, now);
}

/* ---------- The checker agent behind a provider: CHECKER_MODE=mock|creao ---------- */

export const CHECKER_INPUT_VERSION = "finance-claim-check-input/v1" as const;
export const CHECKER_OUTPUT_VERSION = "finance-claim-check-output/v1" as const;
export const CHECKER_INSTRUCTION_VERSION = "finance-claim-checker/v1" as const;

/** What the checker agent receives: the investigator's frozen input, unchanged, plus its claims. */
export interface CheckerInput {
  schemaVersion: typeof CHECKER_INPUT_VERSION;
  instructionVersion: typeof CHECKER_INSTRUCTION_VERSION;
  runId: string;
  investigationInput: FinanceAgentInput;
  claims: Array<{ findingId: string; claim: string; sourceRefs: string[]; codeVerdict: ClaimVerdict; codeReason: string }>;
}
export interface CheckerVerdict { findingId: string; verdict: ClaimVerdict; sourceIds: string[]; sourceSays: string | null; reason: string }
export interface CheckerOutput { schemaVersion: typeof CHECKER_OUTPUT_VERSION; verdicts: CheckerVerdict[] }

export interface ClaimCheckerProvider {
  mode: "mock" | "creao";
  start(input: CheckerInput): Promise<ProviderExecution>;
  poll(externalRunId: string): Promise<ProviderExecution>;
}

export function buildCheckerInput(runId: string, investigationInput: FinanceAgentInput, code: ClaimCheck[]): CheckerInput {
  return { schemaVersion: CHECKER_INPUT_VERSION, instructionVersion: CHECKER_INSTRUCTION_VERSION, runId, investigationInput,
    claims: code.map(c => ({ findingId: c.findingId, claim: c.claim, sourceRefs: c.sourceRefs, codeVerdict: c.verdict, codeReason: c.reason })) };
}

export class CheckerOutputValidationError extends FinanceProviderError {
  constructor(public readonly details: Array<{ path: string; reason: string }>) {
    super("checker_validation_failed", `${details[0]?.path ?? "$"}: ${details[0]?.reason ?? "Checker output failed validation."}`);
  }
}
function invalid(reason: string, path: string): never { throw new CheckerOutputValidationError([{ path, reason }]); }
function exactKeys(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!isObject(value)) invalid("Expected a JSON object.", path);
  const missing = keys.filter(k => !(k in value)).map(k => ({ path: `${path}.${k}`, reason: "Required field is missing." }));
  // Unknown key names may themselves contain secrets; report their position, never their text.
  const extra = Object.keys(value).flatMap((k, i) => keys.includes(k) ? [] : [{ path: `${path}[property#${i}]`, reason: "Unsupported field; only contract fields are allowed." }]);
  if (missing.length || extra.length) throw new CheckerOutputValidationError([...missing, ...extra].slice(0, 50));
  return value;
}

/** Strict: raw JSON only, one verdict per claim in order, sourceId-only citations, verbatim quotes. Nothing is repaired. */
export function validateCheckerOutput(value: unknown, input: CheckerInput): CheckerOutput {
  const root = exactKeys(value, ["schemaVersion", "verdicts"], "$");
  if (root.schemaVersion !== CHECKER_OUTPUT_VERSION) invalid(`Expected ${CHECKER_OUTPUT_VERSION}.`, "$.schemaVersion");
  if (!Array.isArray(root.verdicts)) invalid("Expected an array.", "$.verdicts");
  if (root.verdicts.length !== input.claims.length) invalid(`Expected exactly ${input.claims.length} verdict(s), one per claim.`, "$.verdicts");
  const texts = sourceTexts(input.investigationInput);
  const verdicts = root.verdicts.map((row, index): CheckerVerdict => {
    const path = `$.verdicts[${index}]`;
    const item = exactKeys(row, ["findingId", "verdict", "sourceIds", "sourceSays", "reason"], path);
    const claim = input.claims[index];
    if (item.findingId !== claim.findingId) invalid("Verdicts must keep the claims' order and findingIds.", `${path}.findingId`);
    if (item.verdict !== "supported" && item.verdict !== "not_supported" && item.verdict !== "not_checkable") invalid("Unsupported verdict.", `${path}.verdict`);
    if (typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 400) invalid("Expected a nonempty reason of at most 400 characters.", `${path}.reason`);
    if (!Array.isArray(item.sourceIds) || item.sourceIds.length > 20 || item.sourceIds.some(id => typeof id !== "string" || !claim.sourceRefs.includes(id))) invalid("sourceIds must be sourceIds this claim cites.", `${path}.sourceIds`);
    const sourceIds = item.sourceIds as string[];
    if (item.verdict === "supported" && sourceIds.length === 0) invalid("A supported verdict must name the sourceId(s) it relied on.", `${path}.sourceIds`);
    const cited = claim.sourceRefs.filter(ref => texts.has(ref));
    if (item.sourceSays !== null) {
      if (typeof item.sourceSays !== "string" || !item.sourceSays.trim() || item.sourceSays.length > 300) invalid("sourceSays must be null or 1–300 characters.", `${path}.sourceSays`);
      const quote = item.sourceSays;
      const from = sourceIds.length ? sourceIds : cited;
      if (!from.some(ref => (texts.get(ref) ?? "").includes(quote))) invalid("sourceSays must be copied verbatim from a cited record.", `${path}.sourceSays`);
    } else if (item.verdict === "not_supported" && cited.length > 0) invalid("A not_supported verdict must quote what the cited record actually says.", `${path}.sourceSays`);
    return { findingId: claim.findingId, verdict: item.verdict, sourceIds, sourceSays: item.sourceSays as string | null, reason: item.reason };
  });
  return { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts };
}

/** The final, stored result: code verdicts plus validated agent verdicts. */
export function finalizeClaimCheck(code: ClaimCheck[], output: CheckerOutput, mode: "mock" | "creao", now: number): ClaimCheckResult {
  return claimCheckResult(combineVerdicts(code, output.verdicts.map(v => ({ findingId: v.findingId, verdict: v.verdict, reason: v.reason, sourceSays: v.sourceSays }))), mode, now);
}

/** Deterministic mock behind the provider interface: answers every claim, judging only what code couldn't. */
export function mockCheckerOutput(input: CheckerInput): CheckerOutput {
  const texts = sourceTexts(input.investigationInput);
  return { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: input.claims.map(c => {
    const cited = c.sourceRefs.filter(ref => texts.has(ref));
    if (c.codeVerdict === "not_supported") {
      const says = cited.length ? texts.get(cited[0])!.slice(0, 300) : null;
      return { findingId: c.findingId, verdict: "not_supported" as const, sourceIds: cited.slice(0, 1), sourceSays: says, reason: `Mock checker agrees with code: ${c.codeReason}`.slice(0, 400) };
    }
    if (c.codeVerdict === "supported") return { findingId: c.findingId, verdict: "supported" as const, sourceIds: cited, sourceSays: null, reason: "Mock checker: code confirmed every quoted fact in the cited records." };
    const claimWords = words(c.claim);
    const overlapping = cited.filter(ref => [...words(texts.get(ref)!)].filter(w => claimWords.has(w)).length >= 2);
    return overlapping.length
      ? { findingId: c.findingId, verdict: "supported" as const, sourceIds: overlapping, sourceSays: null, reason: "Mock checker: the cited records discuss the same subject in their own words." }
      : { findingId: c.findingId, verdict: "not_checkable" as const, sourceIds: [], sourceSays: null, reason: "Mock checker: the cited records don't address this claim either way." };
  }) };
}

export const mockClaimCheckerProvider: ClaimCheckerProvider = {
  mode: "mock",
  async start(input) { return { status: "completed", externalRunId: `mock-checker:${input.runId}`, output: mockCheckerOutput(input) }; },
  async poll() { throw new FinanceProviderError("mock_poll_unsupported", "The simulated checker completes deterministically without polling."); },
};

/** Same app-scoped API Trigger pattern as the investigator, with its own app (CREAO_CHECKER_APP_ID) and input field finance_context. */
export class CreaoClaimCheckerProvider implements ClaimCheckerProvider {
  readonly mode = "creao" as const;
  private readonly client: CreaoAppClient;
  constructor(appId: string, apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 20000) {
    this.client = new CreaoAppClient(appId, apiKey, fetchImpl, timeoutMs, "CREAO_CHECKER_APP_ID and an app-scoped checker API key");
  }
  async start(input: CheckerInput): Promise<ProviderExecution> {
    return await this.client.start("finance_context", JSON.stringify(input));
  }
  async poll(externalRunId: string): Promise<ProviderExecution> {
    const status = await this.client.status(externalRunId);
    if (status.status !== "completed") return status;
    return { status: "completed", externalRunId, ...extractCreaoReport(status.result, ["schemaVersion", "verdicts"]) };
  }
}

/** CHECKER_MODE: mock (default) or creao. Anything else is a configuration error; there is no silent fallback. */
export function parseCheckerMode(raw: string | undefined): "mock" | "creao" | null {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "") return "mock";
  return value === "mock" || value === "creao" ? value : null;
}

export function createClaimCheckerProvider(config: { mode: "mock" | "creao"; appId?: string; apiKey?: string; timeoutMs?: number }, fetchImpl?: typeof fetch): ClaimCheckerProvider {
  return config.mode === "mock" ? mockClaimCheckerProvider : new CreaoClaimCheckerProvider(config.appId ?? "", config.apiKey ?? "", fetchImpl, config.timeoutMs);
}
