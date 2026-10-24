/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCheckerOutput, type CheckerInput } from "@mangekyo/finance-core/checker";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const accountId = "demo:account:pool-001";
type T = ReturnType<typeof convexTest>;
async function drain(t: T) { for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); } }
const taskOf = (bank: string) => `intake:${accountId}:deposit:demo:bank:txn:${bank}`;
const timeline = (t: T, bank: string) => t.query(api.financeOrchestrator.getTimeline, { taskId: taskOf(bank) });
const path = (events: Array<{ kind: string; to: string }>) => events.filter(e => e.kind === "transition").map(e => e.to);
async function lawFirm(t: T, steps: number) {
  await t.mutation(api.financeIntake.startFreshDemoRun, {});
  for (let i = 0; i < steps; i++) { await t.mutation(api.financeIntake.feedNext, { accountId }); await drain(t); }
}
const synthetic = async () => { const t = convexTest(schema, modules); return { t, ...(await t.mutation(api.finance.seedSyntheticCase, {})) }; };
const scope = () => ({ kind: "deposit_investigation" as const, accountId: "synthetic-bank-account-001", currency: "USD", from: null, cutoff: Date.now() });

describe("one orchestrator per deposit", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("saves every transition with an event, a snapshot and who caused it, and resumes the same orchestrator after an answer", async () => {
    const t = convexTest(schema, modules);
    await lawFirm(t, 4);
    const asked = (await timeline(t, "okafor-retainer"))!;
    expect(asked.orchestration).toMatchObject({ kind: "deposit", state: "needs_person", activeRunId: null, reason: { code: "QUESTION_ASKED" } });
    expect(path(asked.events)).toEqual(["received", "investigating", "validating", "checking", "needs_person"]);
    expect(asked.events.map(e => e.kind)).toContain("budget_check");
    expect(asked.events.every(e => e.snapshotId !== null)).toBe(true);
    expect(asked.events.find(e => e.to === "investigating")?.actor).toEqual({ type: "system", identity: "system:orchestrator" });
    expect(asked.events.find(e => e.to === "validating")?.actor.type).toBe("agent");
    expect(asked.events.find(e => e.to === "checking")?.actor).toEqual({ type: "code", identity: "code:finance-core" });
    expect(asked.events.find(e => e.to === "needs_person")?.actor.identity).toBe("agent:claim-checker:mock");
    const budget = asked.events.find(e => e.kind === "budget_check")!;
    expect(budget.budget).toMatchObject({ allowed: true, code: "BUDGET_NOT_APPLICABLE", needed: 0 });

    const q = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId: taskOf("okafor-retainer") })).questions[0];
    await t.mutation(api.financeInvestigations.answerQuestion, { runId: q.runId, questionId: q.questionId, answer: "Yes, a partial retainer payment." });
    await drain(t);
    const resumed = (await timeline(t, "okafor-retainer"))!;
    expect(resumed.orchestration.orchestrationId).toBe(asked.orchestration.orchestrationId);
    expect(path(resumed.events)).toEqual(["received", "investigating", "validating", "checking", "needs_person", "investigating", "validating", "checking", "ready_for_approval"]);
    expect(resumed.events.find((e, i) => i > asked.events.length - 1 && e.to === "investigating")).toMatchObject({ trigger: "person_answered", actor: { type: "person", identity: "unauthenticated:finance-dev" } });
    // Append-only: the earlier events are exactly as they were.
    expect(resumed.events.slice(0, asked.events.length)).toEqual(asked.events);
    const snapshots = await t.run(async ctx => await ctx.db.query("financeOrchestratorSnapshots").collect());
    expect(snapshots.filter(s => s.orchestrationId === asked.orchestration.orchestrationId).at(-1)).toMatchObject({ orchestration: { state: "ready_for_approval" }, run: { attempt: 2, outcome: "proposal_ready", checker: { status: "passed" } } });
  });

  it("settles a pending check in waiting_to_clear and investigates again when it clears", async () => {
    const t = convexTest(schema, modules);
    await lawFirm(t, 1);
    expect((await timeline(t, "harborline-delgado"))!.orchestration.state).toBe("waiting_to_clear");
    await t.mutation(api.financeIntake.feedNext, { accountId }); await drain(t);
    await t.mutation(api.financeIntake.feedNext, { accountId }); await drain(t);
    const cleared = (await timeline(t, "harborline-delgado"))!;
    expect(path(cleared.events).slice(-5)).toEqual(["waiting_to_clear", "investigating", "validating", "checking", "ready_for_approval"]);
    expect(cleared.events.find(e => e.kind === "transition" && e.trigger === "deposit_cleared")).toMatchObject({ from: "waiting_to_clear", to: "investigating" });
  });

  it("auto-start is idempotent: a second start returns the running attempt and records no second run", async () => {
    const { t, taskId } = await synthetic();
    const first = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    const second = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    expect(second).toEqual({ runId: first.runId, created: false });
    const view = (await t.query(api.financeOrchestrator.getTimeline, { taskId }))!;
    expect(path(view.events)).toEqual(["received", "investigating"]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs).toHaveLength(1);
  });

  it("retries a network error once, records the retry, and finishes normally", async () => {
    vi.stubEnv("MOCK_PROVIDER_FAULT", "network_once");
    const { t, taskId } = await synthetic();
    const { runId } = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    await t.action(internal.financeInvestigationActions.execute, { runId });
    const view = (await t.query(api.financeOrchestrator.getTimeline, { taskId }))!;
    const retries = view.events.filter(e => e.kind === "retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ from: "investigating", to: "investigating", trigger: "provider_error", error: { code: "provider_network_error" } });
    expect(view.orchestration).toMatchObject({ state: "needs_person", retries: 1 });
    expect((await t.query(internal.financeInvestigations.getRun, { runId }))?.providerRetries).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("after the one retry fails too, the run is failed and needs a person", async () => {
    vi.stubEnv("MOCK_PROVIDER_FAULT", "network_always");
    const { t, taskId } = await synthetic();
    const { runId } = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    await t.action(internal.financeInvestigationActions.execute, { runId });
    const view = (await t.query(api.financeOrchestrator.getTimeline, { taskId }))!;
    expect(view.events.filter(e => e.kind === "retry")).toHaveLength(1);
    expect(view.orchestration).toMatchObject({ state: "failed", reason: { code: "provider_network_error", message: expect.stringMatching(/^Failed, needs a person:/) } });
    expect((await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs[0]).toMatchObject({ status: "failed", error: { code: "provider_network_error" } });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("never retries a validation failure", async () => {
    vi.stubEnv("MOCK_PROVIDER_FAULT", "invalid_output");
    const { t, taskId } = await synthetic();
    const { runId } = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    await t.action(internal.financeInvestigationActions.execute, { runId });
    const view = (await t.query(api.financeOrchestrator.getTimeline, { taskId }))!;
    expect(view.events.filter(e => e.kind === "retry")).toEqual([]);
    expect(path(view.events)).toEqual(["received", "investigating", "validating", "failed"]);
    expect(view.events.at(-1)).toMatchObject({ trigger: "validation_failed", actor: { type: "code" }, error: { code: "validation_failed" } });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("times a hung provider out after PROVIDER_TIMEOUT_MS, retries once, then fails for a person", async () => {
    vi.useRealTimers();
    vi.stubEnv("MOCK_PROVIDER_FAULT", "hang");
    vi.stubEnv("PROVIDER_TIMEOUT_MS", "100");
    const { t, taskId } = await synthetic();
    const { runId } = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    const started = Date.now();
    await t.action(internal.financeInvestigationActions.execute, { runId });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    const view = (await t.query(api.financeOrchestrator.getTimeline, { taskId }))!;
    expect(view.events.filter(e => e.kind === "retry").map(e => e.error?.code)).toEqual(["provider_timeout"]);
    expect(view.orchestration.state).toBe("failed");
  });

  it("refuses an invalid CHECKER_MODE before starting anything", async () => {
    vi.stubEnv("CHECKER_MODE", "off");
    const { t, taskId } = await synthetic();
    await expect(t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() })).rejects.toThrow("CHECKER_MODE must be mock or creao");
    expect(await t.query(api.financeOrchestrator.getTimeline, { taskId })).toBeNull();
  });
});

describe("real-run budget (CREAO mode with fake credentials; nothing is sent)", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12));
    vi.stubEnv("FINANCE_AGENT_MODE", "creao"); vi.stubEnv("CREAO_APP_ID", "test-app"); vi.stubEnv("CREAO_API_KEY", "capi_fake_test_only");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("counts real runs per deposit and refuses past MAX_REAL_RUNS_PER_DEPOSIT, saying why", async () => {
    vi.stubEnv("MAX_REAL_RUNS_PER_DEPOSIT", "1");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { t, taskId } = await synthetic();
    const first = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    expect(first.created).toBe(true);
    await t.mutation(internal.financeInvestigations.recordFailure, { runId: first.runId, error: { code: "provider_failed", message: "Test ended this run.", retryable: false } });
    const second = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    expect(second).toMatchObject({ created: false, runId: first.runId, refused: { code: "BUDGET_DEPOSIT_EXCEEDED", message: expect.stringContaining("1 of 1 real runs already used for this deposit") } });
    const view = (await t.query(api.financeOrchestrator.getTimeline, { taskId }))!;
    expect(view.orchestration).toMatchObject({ state: "needs_person", reason: { code: "BUDGET_DEPOSIT_EXCEEDED" } });
    expect(view.events.filter(e => e.kind === "budget_check").map(e => e.budget?.allowed)).toEqual([true, false]);
    expect((await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs).toHaveLength(1);
    expect((await t.query(api.financeOrchestrator.getConfiguration, { now: Date.now() })).budget).toMatchObject({ perDay: 5, perDeposit: 1, usedToday: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses at MAX_REAL_RUNS_PER_DAY; an investigator plus a CREAO checker count as two", async () => {
    vi.stubEnv("MAX_REAL_RUNS_PER_DAY", "1");
    vi.stubEnv("CHECKER_MODE", "creao");
    const { t, taskId } = await synthetic();
    const refused = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    expect(refused).toMatchObject({ created: false, runId: "", refused: { code: "BUDGET_DAY_EXCEEDED", message: expect.stringContaining("this attempt needs 2") } });
    expect(path((await t.query(api.financeOrchestrator.getTimeline, { taskId }))!.events)).toEqual(["received", "needs_person"]);
  });

  it("mock runs never count", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "mock");
    vi.stubEnv("MAX_REAL_RUNS_PER_DAY", "0");
    const { t, taskId } = await synthetic();
    expect((await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() })).created).toBe(true);
    expect(await t.run(async ctx => (await ctx.db.query("financeRealRuns").collect()).length)).toBe(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});

describe("Agent 2 on CREAO (CHECKER_MODE=creao, fake HTTP; the investigator stays mock)", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12));
    vi.stubEnv("FINANCE_AGENT_MODE", "mock"); vi.stubEnv("CHECKER_MODE", "creao");
    vi.stubEnv("CREAO_CHECKER_APP_ID", "checker-app"); vi.stubEnv("CREAO_CHECKER_API_KEY", "capi_fake_checker_key");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("starts the checker app with finance_context, polls it, and applies its validated verdicts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ id: "checker-ext-1" }));
    const { t, taskId } = await synthetic();
    const { runId } = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    await t.action(internal.financeInvestigationActions.execute, { runId });
    expect((await t.query(internal.financeInvestigations.getRun, { runId }))).toMatchObject({ status: "checking", checkerExternalRunId: "checker-ext-1" });
    expect((await t.query(api.financeOrchestrator.getTimeline, { taskId }))!.orchestration.state).toBe("checking");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://agent.creao.ai/api/v1/apps/checker-app/runs");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer capi_fake_checker_key");
    const sent = JSON.parse(JSON.parse(String(init?.body)).inputs.finance_context) as CheckerInput;
    expect(sent).toMatchObject({ schemaVersion: "finance-claim-check-input/v1", runId, investigationInput: { runId } });
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "checker-ext-1", status: "completed", result: { text: JSON.stringify(mockCheckerOutput(sent)) } }));
    await t.action(internal.financeInvestigationActions.pollChecker, { runId });
    const run = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs[0];
    expect(run).toMatchObject({ status: "needs_information", claimCheck: { agentMode: "creao", status: "passed" } });
    expect((await t.query(api.financeOrchestrator.getTimeline, { taskId }))!.orchestration.state).toBe("needs_person");
    expect(await t.run(async ctx => (await ctx.db.query("financeRealRuns").collect()).map(r => r.provider))).toEqual(["checker"]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("an invalid checker answer fails the run for a person; it is never retried or repaired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "checker-ext-2" }))
      .mockResolvedValueOnce(Response.json({ id: "checker-ext-2", status: "completed", result: { text: JSON.stringify({ schemaVersion: "finance-claim-check-output/v1", verdicts: [] }) } }));
    const { t, taskId } = await synthetic();
    const { runId } = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope() });
    await t.action(internal.financeInvestigationActions.execute, { runId });
    await t.action(internal.financeInvestigationActions.pollChecker, { runId });
    const run = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs[0];
    expect(run).toMatchObject({ status: "failed", error: { code: "checker_validation_failed" } });
    const view = (await t.query(api.financeOrchestrator.getTimeline, { taskId }))!;
    expect(view.orchestration.state).toBe("failed");
    expect(view.events.filter(e => e.kind === "retry")).toEqual([]);
    expect((await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).questions).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
