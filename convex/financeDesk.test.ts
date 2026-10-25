/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const DEMO = "demo:account:pool-001";

describe("desk read queries", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  async function drained() {
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    for (let round = 0; round < 5; round++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); }
    return t;
  }

  it("collects open agent questions, candidate policies, counts and merged activity for an account", async () => {
    const t = await drained();
    const desk = await t.query(api.financeDesk.getDeskData, { accountId: DEMO });
    expect(desk.counts).toEqual({ autoStarted: 2, blocked: 0, posted: 0 });
    expect(desk.tasks.map(task => [task.bankSourceId, task.latestRun?.outcome])).toEqual(expect.arrayContaining([["demo:bank:txn:A-001", "proposal_ready"], ["demo:bank:txn:B-001", "needs_information"]]));
    expect(desk.questions).toEqual([expect.objectContaining({ bankSourceId: "demo:bank:txn:B-001", question: expect.stringContaining("$980.00") })]);
    expect(desk.policies.length).toBeGreaterThan(0);
    expect(new Set(desk.policies.map(p => p.statement)).size).toBe(desk.policies.length);
    const types = desk.activity.map(e => e.type);
    expect(types).toEqual(expect.arrayContaining(["finance.money.auto_investigation", "finance.investigation.completed", "finance.money.proposal_transitioned"]));
    expect(desk.activity.map(e => e.timestamp)).toEqual([...desk.activity.map(e => e.timestamp)].sort((a, b) => b - a));
    expect(await t.query(api.financeDesk.getDeskData, { accountId: "demo:account:none" })).toMatchObject({ tasks: [], questions: [], activity: [] });
  });

  it("shows a run with every attempt for the deposit and its frozen steps", async () => {
    const t = await drained();
    const desk = await t.query(api.financeDesk.getDeskData, { accountId: DEMO });
    const question = desk.questions[0];
    const resumed = await t.mutation(api.financeInvestigations.answerQuestion, { runId: question.runId, questionId: question.questionId, answer: "J Smith pays for DEMO Alpha." });
    for (let round = 0; round < 5; round++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); }
    const view = await t.query(api.financeDesk.getRunView, { runId: resumed.runId });
    expect(view?.runs.map(r => [r.attempt, r.parentRunId])).toEqual([[1, null], [2, question.runId]]);
    expect(view?.run.providerInput?.humanClarifications.map(c => c.answer)).toEqual(["J Smith pays for DEMO Alpha."]);
    expect(view?.steps.map(s => s.type)).toEqual(expect.arrayContaining(["finance.investigation.started", "finance.evidence.retrieved", "finance.checks.completed", "finance.investigation.completed"]));
    expect(view?.steps.every(s => s.snapshotId !== null)).toBe(true);
    expect(view).toMatchObject({ accountId: DEMO, bankSourceId: "demo:bank:txn:B-001" });
    expect(await t.query(api.financeDesk.getRunView, { runId: "nope" })).toBeNull();
  });
});
