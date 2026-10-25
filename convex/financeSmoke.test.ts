/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinanceAgentInput } from "@mangekyo/contracts";
import { mockInvestigation } from "@mangekyo/finance-core/agent";
import { mockAudit, type AuditInput } from "@mangekyo/finance-core/auditor";
import { mockCheckerOutput, type CheckerInput } from "@mangekyo/finance-core/checker";
import { mockDisbursement, type DisbursementInput } from "@mangekyo/finance-core/disbursement";
import { mockReconciliation, type ReconciliationInput } from "@mangekyo/finance-core/reconciliation";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
type T = ReturnType<typeof convexTest>;
type Agent = "intake" | "disbursement" | "evidence_checker" | "reconciler" | "auditor";

/** The action sleeps between CREAO polls; fake timers move it along until it returns. */
async function settle<R>(promise: Promise<R>): Promise<R> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  while (!done) await vi.advanceTimersByTimeAsync(1000);
  return await promise;
}
const smoke = (t: T, agent: Agent) => settle(t.action(internal.financeSmoke.runAgentOnce, { agent }));
const realRuns = (t: T) => t.run(async ctx => (await ctx.db.query("financeRealRuns").collect()).map(r => ({ provider: r.provider, taskId: r.taskId })));
const accounts = (t: T) => t.run(async ctx => (await ctx.db.query("financeAccounts").collect()).map(a => a.accountId));

/** What every smoke account must look like afterwards: import entries only, no proposals, nothing scheduled. */
async function expectNothingMoved(t: T, accountId: string) {
  const { entries, proposals, scheduled } = await t.run(async ctx => ({
    entries: (await ctx.db.query("financeLedgerEntries").collect()).filter(e => e.accountId === accountId),
    proposals: (await ctx.db.query("financeProposals").collect()).filter(p => p.accountId === accountId),
    scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
  }));
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every(e => e.createdBy === "import:demo-adapter")).toBe(true);
  expect(proposals).toEqual([]);
  expect(scheduled).toEqual([]);
}

/** The finance_context a fake provider received: CREAO's inputs, or the user message of Claude, Gemini or GPT. */
function contextOf(url: string, body: Record<string, any>): unknown {
  if (url.includes("agent.creao.ai")) return JSON.parse(body.inputs.finance_context);
  if (url.includes("anthropic")) return JSON.parse(body.messages[0].content);
  if (url.includes("googleapis")) return JSON.parse(body.contents[0].parts[0].text);
  return JSON.parse(body.messages[1].content);
}
const envelope = (url: string, text: string) =>
  url.includes("anthropic") ? { id: "msg_smoke", content: [{ type: "text", text }] }
  : url.includes("googleapis") ? { candidates: [{ content: { parts: [{ text }] } }] }
  : { id: "chatcmpl-smoke", choices: [{ message: { content: text } }] };

/** A fake external model that answers with `answer(context)` (raw JSON text unless `text` overrides it). */
function fakeExternal(answer: (context: any) => unknown, text?: (context: any) => string) {
  const seen: Array<{ url: string; context: any }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const context = contextOf(String(url), JSON.parse(String(init?.body)));
    seen.push({ url: String(url), context });
    return Response.json(envelope(String(url), text ? text(context) : JSON.stringify(answer(context))));
  });
  return { spy, seen };
}

describe("financeSmoke.runAgentOnce", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("refuses unless the agent's mode is creao or external, before anything is created or sent", async () => {
    const t = convexTest(schema, modules);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(smoke(t, "intake")).rejects.toThrow("INTAKE_MODE is mock");
    vi.stubEnv("DISBURSEMENT_MODE", "mock");
    await expect(smoke(t, "disbursement")).rejects.toThrow("DISBURSEMENT_MODE is mock");
    vi.stubEnv("AUDITOR_MODE", "nonsense");
    await expect(smoke(t, "auditor")).rejects.toThrow("AUDITOR_MODE is invalid");
    vi.stubEnv("RECONCILER_MODE", "creao");
    await expect(smoke(t, "reconciler")).rejects.toThrow("RECONCILER_MODE=creao needs CREAO_RECONCILER_APP_ID");
    await expect(t.mutation(internal.financeSmoke.prepare, { agent: "intake" })).rejects.toThrow("INTAKE_MODE is mock");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await accounts(t)).toEqual([]);
    expect(await realRuns(t)).toEqual([]);
  });

  it("Trust Intake on CREAO: starts the app with finance_context, polls it, validates, and moves no money", async () => {
    vi.stubEnv("INTAKE_MODE", "creao"); vi.stubEnv("CREAO_INTAKE_APP_ID", "intake-app"); vi.stubEnv("CREAO_INTAKE_API_KEY", "capi_fake_smoke");
    const t = convexTest(schema, modules);
    let sent: FinanceAgentInput | null = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (init?.method === "POST") { sent = JSON.parse(JSON.parse(String(init.body)).inputs.finance_context); return Response.json({ id: "creao-run-1" }); }
      return Response.json({ id: "creao-run-1", status: "completed", result: { text: JSON.stringify(mockInvestigation(sent!)) } });
    });
    const result = await smoke(t, "intake");
    expect(result).toMatchObject({ agent: "intake", mode: "creao", model: "creao:intake-app", appId: "intake-app", ok: true, outcome: "proposal_ready", validationErrors: [], error: null });
    expect(result.rawOutputPreview!.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(result)).not.toContain("capi_");
    const [startUrl, startInit] = fetchSpy.mock.calls[0];
    expect(startUrl).toBe("https://agent.creao.ai/api/v1/apps/intake-app/runs");
    expect((startInit?.headers as Record<string, string>).Authorization).toBe("Bearer capi_fake_smoke");
    expect(fetchSpy.mock.calls[1][0]).toBe("https://agent.creao.ai/api/v1/apps/intake-app/runs/creao-run-1");
    // The normal frozen input for the cleared $85,000.00 Harborline deposit.
    expect(sent!).toMatchObject({ runId: result.runId, scope: { kind: "deposit_investigation", accountId: result.accountId } });
    expect(sent!.records.transactions).toEqual([expect.objectContaining({ amountCents: 8_500_000 })]);
    expect(await realRuns(t)).toEqual([{ provider: "intake", taskId: `smoke:${result.accountId}:intake` }]);
    const steps = await t.query(api.financeAgentApi.getRunSteps, { runId: result.runId! });
    expect(steps.map(s => [s.kind, s.mode, s.model])).toEqual([["input_frozen", "creao", "creao:intake-app"], ["output_validated", "creao", "creao:intake-app"]]);
    await expectNothingMoved(t, result.accountId!);
  });

  it("Trust Intake on an external model: a fenced answer fails validation and the raw reply is shown", async () => {
    vi.stubEnv("INTAKE_MODE", "external"); vi.stubEnv("INTAKE_EXTERNAL_API_KEY", "sk-ant-fake");
    const t = convexTest(schema, modules);
    fakeExternal(() => null, () => "```json\n{\"outcome\":\"proposal_ready\"}\n```");
    const result = await smoke(t, "intake");
    expect(result).toMatchObject({ mode: "external", model: "claude-opus-5-5", appId: null, ok: false, outcome: null, error: { code: "validation_failed" }, validationErrors: [{ path: "$", reason: expect.stringContaining("one raw JSON object") }] });
    expect(result.rawOutputPreview).toContain("```json");
    expect((await t.query(api.financeAgentApi.getRunSteps, { runId: result.runId! })).map(s => s.kind)).toEqual(["input_frozen", "failed"]);
    await expectNothingMoved(t, result.accountId!);
  });

  it("Disbursement on Claude: the Delgado matter after allocation, three lines, validated and never queued", async () => {
    vi.stubEnv("DISBURSEMENT_MODE", "external"); vi.stubEnv("DISBURSEMENT_EXTERNAL_API_KEY", "sk-ant-fake");
    const t = convexTest(schema, modules);
    const { seen } = fakeExternal((input: DisbursementInput) => mockDisbursement(input));
    const result = await smoke(t, "disbursement");
    expect(result).toMatchObject({ agent: "disbursement", mode: "external", model: "claude-opus-5-5", ok: true, outcome: "proposal_ready" });
    const input = seen[0].context as DisbursementInput;
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(input).toMatchObject({ matterId: "matter:delgado-v-ridgeway", client: { name: "Maria Delgado" }, settlementDeposit: { amountCents: 8_500_000, clearing: "cleared" }, clientBalance: { postedCents: 8_500_000 } });
    expect(JSON.parse(result.rawOutputPreview!).lines.map((l: { amountCents: number }) => l.amountCents)).toEqual([2_805_000, 95_000, 5_600_000]);
    await expectNothingMoved(t, result.accountId!);
  });

  it("Disbursement: an answer with an extra field is refused by the normal validator, with its details", async () => {
    vi.stubEnv("DISBURSEMENT_MODE", "external"); vi.stubEnv("DISBURSEMENT_EXTERNAL_API_KEY", "sk-ant-fake");
    const t = convexTest(schema, modules);
    fakeExternal((input: DisbursementInput) => ({ ...mockDisbursement(input), confidence: 0.99 }));
    const result = await smoke(t, "disbursement");
    expect(result).toMatchObject({ ok: false, outcome: null, error: { code: "validation_failed" } });
    expect(result.validationErrors.length).toBeGreaterThan(0);
    expect(result.rawOutputPreview).toContain("confidence");
  });

  it("Evidence Checker on Gemini: judges the mock Intake's claims for the Harborline deposit; only the checker counts", async () => {
    vi.stubEnv("EVIDENCE_CHECKER_MODE", "external"); vi.stubEnv("EVIDENCE_CHECKER_EXTERNAL_API_KEY", "g-fake");
    const t = convexTest(schema, modules);
    const { seen } = fakeExternal((input: CheckerInput) => mockCheckerOutput(input));
    const result = await smoke(t, "evidence_checker");
    expect(result).toMatchObject({ mode: "external", model: "gemini-2.5-pro", ok: true, outcome: "passed" });
    expect(seen[0].url).toContain("generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
    expect((seen[0].context as CheckerInput).claims.length).toBeGreaterThan(0);
    expect(await realRuns(t)).toEqual([{ provider: "evidence_checker", taskId: `smoke:${result.accountId}:evidence_checker` }]);
  });

  it("Three-Way Reconciler: a bounced Okafor check, corrected only from the records", async () => {
    vi.stubEnv("RECONCILER_MODE", "external"); vi.stubEnv("RECONCILER_EXTERNAL_API_KEY", "sk-ant-fake");
    const t = convexTest(schema, modules);
    const { seen } = fakeExternal((input: ReconciliationInput) => mockReconciliation(input));
    const result = await smoke(t, "reconciler");
    expect(result).toMatchObject({ agent: "reconciler", ok: true, outcome: "correction_proposed" });
    const input = seen[0].context as ReconciliationInput;
    expect(input.records.bankTransactions.map(b => [b.raw.recordType, b.direction, b.amountCents])).toEqual(expect.arrayContaining([["client-check-return", "outflow", 250_000]]));
    // The return lives only in the frozen input: the account's bank feed never saw it, so nothing else will start on it.
    expect(await t.run(async ctx => (await ctx.db.query("financeBankTransactions").collect()).some(b => b.accountId === result.accountId && b.sourceId.endsWith(":returned")))).toBe(false);
    await expectNothingMoved(t, result.accountId!);
  });

  it("Trust Compliance Auditor on GPT: the drill's posted history, frozen without writing it", async () => {
    vi.stubEnv("AUDITOR_MODE", "external"); vi.stubEnv("AUDITOR_EXTERNAL_API_KEY", "oa-fake");
    const t = convexTest(schema, modules);
    const { seen } = fakeExternal((input: AuditInput) => mockAudit(input));
    const result = await smoke(t, "auditor");
    expect(result).toMatchObject({ mode: "external", model: "gpt-5", ok: true, outcome: "findings" });
    expect(seen[0].url).toBe("https://api.openai.com/v1/chat/completions");
    const input = seen[0].context as AuditInput;
    expect(input.entries.map(e => e.entryId)).toEqual(expect.arrayContaining(["drill:self-approved:entry:1", "drill:uncleared:entry:1", "drill:fee:entry:1", "drill:reversal:entry:1"]));
    expect(input.codeFindings.length).toBeGreaterThanOrEqual(4);
    await expectNothingMoved(t, result.accountId!);
  });

  it("counts against MAX_REAL_RUNS_PER_DAY and refuses past it without calling anything", async () => {
    vi.stubEnv("AUDITOR_MODE", "external"); vi.stubEnv("AUDITOR_EXTERNAL_API_KEY", "oa-fake"); vi.stubEnv("MAX_REAL_RUNS_PER_DAY", "1");
    const t = convexTest(schema, modules);
    const { spy } = fakeExternal((input: AuditInput) => mockAudit(input));
    expect((await smoke(t, "auditor")).ok).toBe(true);
    const refused = await smoke(t, "auditor");
    expect(refused).toMatchObject({ ok: false, runId: null, accountId: null, error: { code: "BUDGET_DAY_EXCEEDED", message: expect.stringContaining("1 of 1 real runs already used today") } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await accounts(t)).toHaveLength(1);
  });

  it("a CREAO run that never finishes is reported as a timeout with its external run ID", async () => {
    vi.stubEnv("AUDITOR_MODE", "creao"); vi.stubEnv("CREAO_AUDITOR_APP_ID", "audit-app"); vi.stubEnv("CREAO_AUDITOR_API_KEY", "capi_fake_smoke");
    const t = convexTest(schema, modules);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => Response.json(init?.method === "POST" ? { id: "creao-slow" } : { id: "creao-slow", status: "running" }));
    const result = await smoke(t, "auditor");
    expect(result).toMatchObject({ ok: false, error: { code: "provider_timeout", message: expect.stringContaining("creao-slow") } });
    expect(result.rawOutputPreview).toContain("running");
  });
});
