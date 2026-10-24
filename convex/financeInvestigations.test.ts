/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { investigationPeriod } from "../packages/finance-core/src/investigationPeriod";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);

function scope(cutoff: number, kind: "deposit_investigation" | "historical_onboarding" = "deposit_investigation") {
  return { kind, accountId: "synthetic-bank-account-001", currency: "USD", from: null, cutoff };
}

describe("finance investigation workflow", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  async function fixture() {
    const t = convexTest(schema, modules);
    const seed = await t.mutation(api.finance.seedSyntheticCase, {});
    return { t, ...seed };
  }

  it("uses server time for a blank cutoff despite a fast client clock and preserves it on resume", async () => {
    const { t, taskId } = await fixture();
    const serverNow = Date.now();
    vi.setSystemTime(serverNow + 60_000);
    const formScope = { kind: "deposit_investigation" as const, accountId: "synthetic-bank-account-001", currency: "USD", ...investigationPeriod("", "") };
    vi.setSystemTime(serverNow);
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: formScope });
    await t.action(internal.financeInvestigationActions.execute, { runId: started.runId });
    const original = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(original.runs[0].scope.cutoff).toBe(serverNow);
    expect(original.runs[0].providerInput?.scope.cutoff).toBe(serverNow);
    expect(original.runs[0].createdAt).toBe(serverNow);
    vi.setSystemTime(serverNow + 60_000);
    await t.mutation(api.financeInvestigations.answerQuestion, { runId: started.runId, questionId: original.questions[0].questionId, answer: "The agreement is still missing." });
    const resumed = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(resumed.runs[0].scope.cutoff).toBe(serverNow);
    expect(resumed.runs[1]).toEqual(original.runs[0]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("rejects an explicit cutoff even one millisecond in the future without writing history", async () => {
    const { t, taskId } = await fixture();
    const before = await t.query(api.finance.listTaskEvents, { taskId });
    await expect(t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now() + 1) })).rejects.toThrow("cutoff cannot be in the future");
    expect((await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs).toEqual([]);
    expect(await t.query(api.finance.listTaskEvents, { taskId })).toEqual(before);
  });

  it("supplies actual frozen evidence and requests information without allocating", async () => {
    const { t, taskId } = await fixture();
    const before = await t.query(api.finance.getSyntheticCase, {});
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.action(internal.financeInvestigationActions.execute, { runId: started.runId });
    const view = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    const [run] = view.runs;
    expect(run).toMatchObject({ mode: "mock", simulated: true, status: "needs_information", attempt: 1, parentRunId: null });
    expect(run.result?.summary).toContain("SIMULATED");
    expect(run.result?.proposedAllocations).toEqual([]);
    expect(run.providerInput?.records.transactions[0].amountCents).toBe(125000);
    expect(run.providerInput?.records.documents[0].text).toBe(before!.document.text);
    expect(run.providerInput?.records.coverage).toBe("available_records_only");
    expect(run.providerInput?.deterministicChecks.reconciliation.status).toBe("insufficient_data");
    expect(run.resultChecks?.proposedAllocations.status).toBe("not_applicable");
    expect(view.questions).toHaveLength(1);
    expect(view.auditHandoff?.visualAuditStatus).toBe("not_connected");
    expect((await t.query(api.finance.getSyntheticCase, {}))?.transaction).toEqual(before?.transaction);
    const events = await t.query(api.finance.listTaskEvents, { taskId });
    const snapshots = await t.query(api.finance.listTaskSnapshots, { taskId });
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events).toHaveLength(snapshots.length);
    expect(events[0].type).toBe("finance.task.created");
    expect(snapshots.every((snapshot) => snapshot.output.approved === false && snapshot.output.allocatedAmountCents === 0)).toBe(true);
    expect((await t.query(api.finance.listTaskEvents, { taskId, afterSequence: 3 })).every((event) => event.sequence > 3)).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("prevents duplicate active starts and duplicate provider claims", async () => {
    const { t, taskId } = await fixture();
    const args = { taskId, scope: scope(Date.now()) };
    const first = await t.mutation(api.financeInvestigations.startInvestigation, args);
    const second = await t.mutation(api.financeInvestigations.startInvestigation, args);
    expect(first.created).toBe(true);
    expect(second).toEqual({ runId: first.runId, created: false });
    const claim = await t.mutation(internal.financeInvestigations.claimExecution, { runId: first.runId });
    expect(claim?.runId).toBe(first.runId);
    expect(await t.mutation(internal.financeInvestigations.claimExecution, { runId: first.runId })).toBeNull();
    expect((await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("persists honest respondent identity and resumes with a distinct immutable parent-linked context", async () => {
    const { t, taskId } = await fixture();
    const first = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.action(internal.financeInvestigationActions.execute, { runId: first.runId });
    const original = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    const question = original.questions[0];
    vi.advanceTimersByTime(1);
    const resumed = await t.mutation(api.financeInvestigations.answerQuestion, { runId: first.runId, questionId: question.questionId, answer: "The payer is Example Client A; the agreement is still missing." });
    expect(resumed.runId).not.toBe(first.runId);
    await t.action(internal.financeInvestigationActions.execute, { runId: resumed.runId });
    const view = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(view.runs[0]).toMatchObject({ parentRunId: first.runId, attempt: 2, mode: "mock" });
    expect(view.runs[0].providerInput?.humanClarifications[0]).toMatchObject({ runId: first.runId, questionId: question.questionId, respondent: { authenticated: false, identity: "unauthenticated:finance-dev" } });
    expect(view.runs[0].providerInput!.scope.cutoff).toBe(original.runs[0].scope.cutoff);
    expect(view.runs[0].providerInput!.contextAsOf).toBeGreaterThanOrEqual(view.clarifications[0].timestamp);
    expect(view.runs.find((run) => run.runId === first.runId)).toEqual(original.runs[0]);
    expect(view.questions.find((item) => item.questionId === question.questionId)?.status).toBe("answered");
    expect(view.runs[0].result?.proposedAllocations).toEqual([]);
    await expect(t.mutation(api.financeInvestigations.answerQuestion, { runId: first.runId, questionId: question.questionId, answer: "Repeated" })).rejects.toThrow("already");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("derives authenticated identity server-side and rejects invented clarification evidence", async () => {
    const { t, taskId } = await fixture();
    const first = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.action(internal.financeInvestigationActions.execute, { runId: first.runId });
    const view = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    const args = { runId: first.runId, questionId: view.questions[0].questionId, answer: "We need the signed agreement." };
    await expect(t.mutation(api.financeInvestigations.answerQuestion, { ...args, evidenceRefs: [{ sourceId: "invented", documentId: "invented", excerpt: "invented" }] })).rejects.toThrow("evidence references");
    const authenticated = t.withIdentity({ tokenIdentifier: "issuer|verified-user", subject: "ignored-subject" });
    await authenticated.mutation(api.financeInvestigations.answerQuestion, args);
    expect((await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).clarifications[0].respondent).toEqual({ identity: "issuer|verified-user", authenticated: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("fails CREAO configuration explicitly instead of returning simulated success", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "creao");
    vi.stubEnv("CREAO_APP_ID", "");
    vi.stubEnv("CREAO_API_KEY", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { t, taskId } = await fixture();
    expect(await t.query(api.financeInvestigations.getProviderConfiguration, {})).toMatchObject({ mode: "creao", configured: false });
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.action(internal.financeInvestigationActions.execute, { runId: started.runId });
    const [run] = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs;
    expect(run).toMatchObject({ mode: "creao", simulated: false, status: "failed", result: null, error: { code: "configuration_error" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("rejects unsupported model evidence and preserves the external run ID", async () => {
    const { t, taskId } = await fixture();
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.mutation(internal.financeInvestigations.claimExecution, { runId: started.runId });
    const badOutput = { schemaVersion: "finance-investigation-output/v1", outcome: "findings", summary: "Unsupported claim", findings: [{ findingId: "one", summary: "Found", sourceRefs: ["nonexistent-source"] }], questions: [], proposedAllocations: [], proposedActions: [], candidatePolicies: [] };
    await t.mutation(internal.financeInvestigations.recordResult, { runId: started.runId, externalRunId: "external-existing-123", outputJson: JSON.stringify(badOutput) });
    const [run] = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs;
    expect(run).toMatchObject({ status: "failed", externalRunId: "external-existing-123", result: null, error: { code: "validation_failed" } });
    expect(run.error?.details).toEqual([{ path: "$.findings[0].sourceRefs[0]", reason: "Citation does not exist in the frozen provider context." }]);
    expect(JSON.stringify(run.error)).not.toContain("nonexistent-source");
    const failedSnapshot = (await t.query(api.finance.listTaskSnapshots, { taskId })).at(-1)!;
    expect(failedSnapshot.output).toMatchObject({ error: run.error });
    expect((await t.query(api.finance.listTaskEvents, { taskId })).at(-1)?.type).toBe("finance.validation.failed");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("saves sanitized missing-field details for CREAO's count-only result without altering a failed attempt", async () => {
    const { t, taskId } = await fixture();
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.mutation(internal.financeInvestigations.claimExecution, { runId: started.runId });
    const output = { outcome: "needs_information", findings_count: 6, questions_count: 6, proposed_allocations_count: 0, total_amount_cents: 0, secret_key_name: "capi_do_not_store" };
    const args = { runId: started.runId, externalRunId: "existing-run", outputJson: JSON.stringify(output) };
    await t.mutation(internal.financeInvestigations.recordResult, args);
    const original = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(original.runs[0].error?.details?.filter(item => item.reason === "Required field is missing.").map(item => item.path)).toEqual(["$.schemaVersion", "$.summary", "$.findings", "$.questions", "$.proposedAllocations", "$.proposedActions", "$.candidatePolicies"]);
    expect(JSON.stringify(original.runs[0].error)).not.toMatch(/secret_key_name|capi_do_not_store/);
    await t.mutation(internal.financeInvestigations.recordResult, args);
    expect(await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).toEqual(original);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("polls the persisted external ID through a transient failure without starting another paid run", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "creao");
    vi.stubEnv("CREAO_APP_ID", "test-app");
    vi.stubEnv("CREAO_API_KEY", "capi_fake_test_only");
    const output = { schemaVersion: "finance-investigation-output/v1", outcome: "needs_information", summary: "Additional agreement evidence is required.", findings: [], questions: [{ key: "agreement", question: "Where is the signed agreement?", sourceRefs: [] }], proposedAllocations: [], proposedActions: [], candidatePolicies: [] };
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "existing-external-run", appId: "test-app" }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: "existing-external-run", status: "completed", result: { text: JSON.stringify(output) } }));
    const { t, taskId } = await fixture();
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.action(internal.financeInvestigationActions.execute, { runId: started.runId });
    expect((await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs[0]).toMatchObject({ status: "provider_pending", externalRunId: "existing-external-run" });
    await t.action(internal.financeInvestigationActions.poll, { runId: started.runId });
    expect((await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs[0]).toMatchObject({ status: "provider_pending", externalRunId: "existing-external-run" });
    await t.action(internal.financeInvestigationActions.poll, { runId: started.runId });
    const [run] = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs;
    expect(run).toMatchObject({ status: "needs_information", simulated: false, externalRunId: "existing-external-run", result: output });
    expect(run.reportSource).toEqual({ field: "result.text", format: "json" });
    expect((await t.query(api.finance.listTaskEvents, { taskId })).at(-1)).toMatchObject({ payload: { reportSource: run.reportSource } });
    expect((await t.query(api.finance.listTaskSnapshots, { taskId })).at(-1)).toMatchObject({ output: { reportSource: run.reportSource } });
    expect(fetchSpy.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/existing-external-run"))).toHaveLength(2);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("never repeats an ambiguous paid start and records malformed terminal output as validation failure", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "creao");
    vi.stubEnv("CREAO_APP_ID", "test-app");
    vi.stubEnv("CREAO_API_KEY", "capi_fake_test_only");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network exception with sensitive details"));
    const { t, taskId } = await fixture();
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.action(internal.financeInvestigationActions.execute, { runId: started.runId });
    await t.action(internal.financeInvestigationActions.execute, { runId: started.runId });
    const [failed] = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs;
    expect(failed).toMatchObject({ status: "failed", simulated: false, error: { code: "provider_start_ambiguous" } });
    expect(failed.error?.message).not.toContain("sensitive");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "second-external-run" }))
      .mockResolvedValueOnce(Response.json({ status: "completed", result: { text: "```json invalid```" } }));
    const deliberate = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.action(internal.financeInvestigationActions.execute, { runId: deliberate.runId });
    await t.action(internal.financeInvestigationActions.poll, { runId: deliberate.runId });
    const [next] = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs;
    expect(next).toMatchObject({ parentRunId: started.runId, status: "failed", externalRunId: "second-external-run", error: { code: "validation_failed" } });
    expect((await t.query(api.finance.listTaskEvents, { taskId })).at(-1)?.type).toBe("finance.validation.failed");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps historical coverage limited to records actually reviewed and rejects other account scopes", async () => {
    const { t, taskId } = await fixture();
    const records = await t.query(api.financeInvestigations.getRecords, { taskId, scope: scope(Date.now(), "historical_onboarding") });
    expect(records.transactions).toHaveLength(1);
    expect(records.bankBalance).toBeNull();
    expect(records.ownerBalancesComplete).toBe(false);
    expect(records.missingEvidence.join(" ")).toContain("only this synthetic case");
    await expect(t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: { ...scope(Date.now()), accountId: "other-account" } })).rejects.toThrow("Only synthetic");
    await expect(t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: { ...scope(Date.now()), currency: "EUR" } })).rejects.toThrow("Only synthetic");
    await expect(t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: { ...scope(Date.now()), cutoff: Date.now() + 100 } })).rejects.toThrow("future");
    await expect(t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: { ...scope(Date.now()), from: Date.now() + 100 } })).rejects.toThrow("from <= cutoff");
  });

  it("includes a new clarification without widening the financial-record cutoff", async () => {
    const { t, taskId } = await fixture();
    const financialScope = scope(Date.now() - 1, "historical_onboarding");
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: financialScope });
    await t.action(internal.financeInvestigationActions.execute, { runId: started.runId });
    const original = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(original.runs[0].providerInput?.records.transactions).toHaveLength(0);
    vi.advanceTimersByTime(10);
    const resumed = await t.mutation(api.financeInvestigations.answerQuestion, { runId: started.runId, questionId: original.questions[0].questionId, answer: "The earlier period's ledger is still unavailable." });
    await t.action(internal.financeInvestigationActions.execute, { runId: resumed.runId });
    const view = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(view.runs[0].scope).toEqual(financialScope);
    expect(view.runs[0].providerInput?.records.transactions).toHaveLength(0);
    expect(view.runs[0].providerInput?.humanClarifications).toHaveLength(1);
    expect(view.runs[0].providerInput?.contextAsOf).toBeGreaterThan(financialScope.cutoff);
    expect(view.runs.find((run) => run.runId === started.runId)).toEqual(original.runs[0]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("allows another original question to be answered after a newer attempt completed", async () => {
    const { t, taskId } = await fixture();
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.mutation(internal.financeInvestigations.claimExecution, { runId: started.runId });
    const output = { schemaVersion: "finance-investigation-output/v1", outcome: "needs_information", summary: "Two independent records are missing.", findings: [], questions: [{ key: "payer", question: "Who is the payer?", sourceRefs: [] }, { key: "agreement", question: "Where is the signed agreement?", sourceRefs: [] }], proposedAllocations: [], proposedActions: [], candidatePolicies: [] };
    await t.mutation(internal.financeInvestigations.recordResult, { runId: started.runId, externalRunId: "mock:original", outputJson: JSON.stringify(output) });
    const original = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    const payer = original.questions.find((question) => question.key === "payer")!;
    const agreement = original.questions.find((question) => question.key === "agreement")!;
    const second = await t.mutation(api.financeInvestigations.answerQuestion, { runId: started.runId, questionId: payer.questionId, answer: "The bank payer field is Example Client A." });
    await t.action(internal.financeInvestigationActions.execute, { runId: second.runId });
    const third = await t.mutation(api.financeInvestigations.answerQuestion, { runId: started.runId, questionId: agreement.questionId, answer: "The signed agreement has not been located." });
    await t.action(internal.financeInvestigationActions.execute, { runId: third.runId });
    const view = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(view.runs[0]).toMatchObject({ attempt: 3, parentRunId: second.runId, scope: original.runs[0].scope });
    expect(view.runs[0].providerInput?.humanClarifications).toHaveLength(2);
    expect(view.clarifications.every((answer) => answer.runId === started.runId)).toBe(true);
    expect(view.questions.filter((question) => question.runId === started.runId).every((question) => question.status === "answered")).toBe(true);
    expect(view.runs.find((run) => run.runId === started.runId)?.result).toEqual(output);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("freezes the CREAO app selector for both queued starts and later polling", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "creao");
    vi.stubEnv("CREAO_APP_ID", "original-app");
    vi.stubEnv("CREAO_API_KEY", "capi_fake_test_only");
    const output = { schemaVersion: "finance-investigation-output/v1", outcome: "needs_information", summary: "An agreement is missing.", findings: [], questions: [{ key: "agreement", question: "Where is the agreement?", sourceRefs: [] }], proposedAllocations: [], proposedActions: [], candidatePolicies: [] };
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "external-for-original-app", appId: "original-app" }))
      .mockResolvedValueOnce(Response.json({ id: "external-for-original-app", status: "completed", result: { text: JSON.stringify(output) } }));
    const { t, taskId } = await fixture();
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    vi.stubEnv("CREAO_APP_ID", "replacement-app");
    await t.action(internal.financeInvestigationActions.execute, { runId: started.runId });
    await t.action(internal.financeInvestigationActions.poll, { runId: started.runId });
    const [run] = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs;
    expect(run).toMatchObject({ providerAppId: "original-app", externalRunId: "external-for-original-app", status: "needs_information" });
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      "https://agent.creao.ai/api/v1/apps/original-app/runs",
      "https://agent.creao.ai/api/v1/apps/original-app/runs/external-for-original-app",
    ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it.each(["pending", "completed", "failed"] as const)("retains a late %s provider ID after timeout without reviving the attempt", async (response) => {
    const { t, taskId } = await fixture();
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.mutation(internal.financeInvestigations.claimExecution, { runId: started.runId });
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    await t.mutation(internal.financeInvestigations.expireRun, { runId: started.runId });
    const eventsBefore = await t.query(api.finance.listTaskEvents, { taskId });
    const args = { runId: started.runId, externalRunId: "late-paid-run-id" };
    if (response === "pending") await t.mutation(internal.financeInvestigations.recordPending, args);
    if (response === "completed") await t.mutation(internal.financeInvestigations.recordResult, { ...args, outputJson: "null" });
    if (response === "failed") await t.mutation(internal.financeInvestigations.recordFailure, { ...args, error: { code: "provider_failed", message: "Provider failed", retryable: false } });
    const [run] = (await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs;
    expect(run).toMatchObject({ status: "failed", externalRunId: "late-paid-run-id", result: null, error: { code: "timeout" } });
    expect((await t.query(internal.financeInvestigations.getRun, { runId: started.runId }))?.pollCount).toBe(0);
    expect(await t.query(api.finance.listTaskEvents, { taskId })).toEqual(eventsBefore);
    expect((await t.query(api.finance.getSyntheticCase, {}))?.task).toMatchObject({ status: "investigation_failed" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("rejects an overdue execution claim before making a provider request", async () => {
    const { t, taskId } = await fixture();
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    await t.action(internal.financeInvestigationActions.execute, { runId: started.runId });
    expect((await t.query(api.financeInvestigations.getTaskInvestigation, { taskId })).runs[0]).toMatchObject({ status: "failed", error: { code: "timeout" } });
    expect((await t.query(internal.financeInvestigations.getRun, { runId: started.runId }))?.executionClaimed).toBe(false);
    expect((await t.query(api.finance.listTaskEvents, { taskId })).some((event) => event.type === "finance.provider.started")).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("continues to read and resume saved attempts without the new optional metadata", async () => {
    const { t, taskId } = await fixture();
    const started = await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: scope(Date.now()) });
    await t.action(internal.financeInvestigationActions.execute, { runId: started.runId });
    await t.run(async (ctx) => {
      const run = await ctx.db.query("financeInvestigationRuns").withIndex("by_runId", (q) => q.eq("runId", started.runId)).unique();
      const { contextAsOf, ...legacyInput } = run!.providerInput!;
      await ctx.db.patch("financeInvestigationRuns", run!._id, { providerAppId: undefined, providerInput: legacyInput });
    });
    const original = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(original.runs[0].providerInput?.contextAsOf).toBeUndefined();
    const resumed = await t.mutation(api.financeInvestigations.answerQuestion, { runId: started.runId, questionId: original.questions[0].questionId, answer: "We still need documentary evidence." });
    await t.action(internal.financeInvestigationActions.execute, { runId: resumed.runId });
    const view = await t.query(api.financeInvestigations.getTaskInvestigation, { taskId });
    expect(view.runs[0].providerInput?.contextAsOf).toBeTypeOf("number");
    expect(view.runs.find((run) => run.runId === started.runId)).toEqual(original.runs[0]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});
