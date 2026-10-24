import { ConvexError, v } from "convex/values";
import {
  FINANCE_INPUT_VERSION, FINANCE_INSTRUCTION_VERSION,
  type FinanceAgentInput, type FinanceAgentOutput, type FinanceInvestigationRun,
  type InvestigationEvent, type InvestigationEventType, type InvestigationError,
  type InvestigationStartScope, type InvestigationScope, type TaskInvestigationView,
} from "@mangekyo/contracts";
import { runDeterministicChecks } from "@mangekyo/finance-core/checks";
import { validateFinanceAgentOutput, FinanceOutputValidationError } from "@mangekyo/finance-core/agent";
import { internal } from "./_generated/api";
import { env, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import * as validators from "./lib/validators";
import { readRecords, recordOnly, requireTask, validateScope } from "./lib/investigationRecords";
import { nextProposalId, readIntakeRecords, submitProposal } from "./lib/money";

const ACTIVE = new Set(["queued", "retrieving_evidence", "checking", "provider_starting", "provider_pending", "validating"]);
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const startResult = v.object({ runId: v.string(), created: v.boolean() });

function configuration(): { mode: "mock" | "creao" | null; configured: boolean; message: string } {
  const rawMode = env.FINANCE_AGENT_MODE;
  const mode = rawMode === "mock" || rawMode === "creao" ? rawMode : null;
  const configured = mode === "mock" || (mode === "creao" && Boolean(env.CREAO_APP_ID?.trim() && /^capi_\S+$/.test(env.CREAO_API_KEY ?? "")));
  return { mode, configured, message: mode === null ? "Set FINANCE_AGENT_MODE explicitly to mock or creao on the Convex deployment." : mode === "mock" ? "SIMULATED: deterministic mock provider; no external model runs." : configured ? "CREAO mode selected. External agent runs use server-side credentials." : "CREAO mode requires CREAO_APP_ID and an app-scoped CREAO_API_KEY (capi_ prefix) on the Convex deployment. No mock fallback." };
}

export const getProviderConfiguration = query({
  args: {}, returns: v.object({ mode: v.union(validators.mode, v.null()), configured: v.boolean(), message: v.string() }),
  handler: async () => configuration(),
});

function publicRun(row: Doc<"financeInvestigationRuns">): FinanceInvestigationRun {
  const { executionClaimed, pollCount, deadline, ...run } = recordOnly(row);
  return run as FinanceInvestigationRun;
}

async function findRun(ctx: MutationCtx, runId: string) {
  const run = await ctx.db.query("financeInvestigationRuns").withIndex("by_runId", (q) => q.eq("runId", runId)).unique();
  if (!run) throw new Error("Investigation run not found");
  return run;
}

/** A late response can identify a paid run even after our watchdog has ended the attempt. */
async function retainExternalRunId(ctx: MutationCtx, run: Doc<"financeInvestigationRuns">, externalRunId: string): Promise<Doc<"financeInvestigationRuns">> {
  if (!externalRunId.trim()) throw new Error("Provider run ID cannot be empty");
  if (run.externalRunId && run.externalRunId !== externalRunId) throw new Error("Provider run ID cannot change");
  if (!run.externalRunId) await ctx.db.patch("financeInvestigationRuns", run._id, { externalRunId });
  return { ...run, externalRunId };
}

function timeoutError(run: Doc<"financeInvestigationRuns">): InvestigationError {
  return { code: "timeout", message: run.externalRunId ? "Investigation timed out. The external run ID is preserved; no replacement paid run was started." : "Investigation timed out before a provider run ID was saved. Check provider history before deliberately retrying; a paid run may have started.", retryable: Boolean(run.externalRunId) };
}

/** Every observable boundary appends an event and snapshot in the same transaction. */
export async function appendBoundary(ctx: MutationCtx, run: FinanceInvestigationRun, type: InvestigationEventType, message: string,
  extra: Partial<InvestigationEvent["payload"]> = {}, actor: InvestigationEvent["actor"] = { type: "system", component: "finance-investigation" }) {
  const task = await requireTask(ctx, run.taskId);
  const last = await ctx.db.query("financeEvents").withIndex("by_taskId_and_sequence", (q) => q.eq("taskId", run.taskId)).order("desc").first();
  const sequence = (last?.sequence ?? 0) + 1;
  const timestamp = Date.now();
  const eventId = `${run.runId}:event:${sequence}`;
  const evidenceRefs = run.providerInput?.evidenceRefs ?? task.evidenceRefs;
  await ctx.db.insert("financeEvents", {
    synthetic: true, caseId: run.caseId, taskId: run.taskId, runId: run.runId, eventId, sequence, timestamp, type, actor, evidenceRefs,
    payload: { mode: run.mode, simulated: run.simulated, message, instructionVersion: FINANCE_INSTRUCTION_VERSION,
      policyVersions: run.providerInput?.approvedPolicies.map((policy) => `${policy.policyId}@${policy.version}`) ?? [],
      contextRunId: run.runId, ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}), ...(run.reportSource ? { reportSource: run.reportSource } : {}), ...extra },
  });
  await ctx.db.insert("financeSnapshots", {
    synthetic: true, caseId: run.caseId, taskId: run.taskId, runId: run.runId, eventId, snapshotId: `${run.runId}:snapshot:${sequence}`, sequence, timestamp,
    taskState: recordOnly(task), inputs: { transactionId: task.transactionId, candidateOwnerId: task.candidateOwnerId, evidenceRefs, contextRunId: run.runId, instructionVersion: FINANCE_INSTRUCTION_VERSION },
    output: { allocationStatus: "unallocated", allocatedAmountCents: 0, approved: false, investigationStatus: run.status,
      providerMode: run.mode, simulated: run.simulated, result: run.result,
      deterministicChecks: run.resultChecks ?? run.providerInput?.deterministicChecks ?? null,
      error: run.error, ...(run.reportSource ? { reportSource: run.reportSource } : {}) },
  });
}

async function makeAttempt(ctx: MutationCtx, task: Doc<"financeTasks">, requestedScope: InvestigationStartScope, parent: Doc<"financeInvestigationRuns"> | null): Promise<{ runId: string; created: boolean }> {
  const now = Date.now();
  const scope: InvestigationScope = { ...requestedScope, cutoff: requestedScope.cutoff ?? now };
  let intake: Awaited<ReturnType<typeof readIntakeRecords>> | null = null;
  try { if (task.accountId) intake = await readIntakeRecords(ctx, task, scope); else validateScope(scope); } catch (error) {
    throw new ConvexError(error instanceof Error ? error.message : "Choose a valid investigation period.");
  }
  if (scope.cutoff > now) throw new ConvexError("Investigation cutoff cannot be in the future. Choose a time at or before the current server time, or leave the cutoff blank.");
  if (task.activeRunId) {
    const active = await findRun(ctx, task.activeRunId);
    if (ACTIVE.has(active.status)) return { runId: active.runId, created: false };
  }
  const config = configuration();
  if (!config.mode) throw new Error(config.message);
  const attempt = (parent?.attempt ?? 0) + 1;
  const runId = `${task.taskId}:investigation:${attempt}`;
  const records = intake ? intake.records : await readRecords(ctx, task, scope);
  const humanClarifications = (await ctx.db.query("financeClarifications")
    .withIndex("by_taskId_and_timestamp", (q) => q.eq("taskId", task.taskId).lte("timestamp", now)).take(101)).map(recordOnly);
  const approvedPolicies = (await ctx.db.query("financeApprovedPolicies")
    .withIndex("by_accountId_and_currency_and_approvedAt", (q) => q.eq("accountId", scope.accountId).eq("currency", scope.currency).lte("approvedAt", scope.cutoff)).take(101)).map(recordOnly);
  if (humanClarifications.length > 100 || approvedPolicies.length > 100) throw new Error("Context exceeds the bounded development policy/clarification limit");
  const evidenceRefs = records.documents.map((document) => ({ documentId: document.documentId, sourceId: document.sourceId, excerpt: document.excerpt }));
  const providerInput: FinanceAgentInput = {
    schemaVersion: FINANCE_INPUT_VERSION, instructionVersion: FINANCE_INSTRUCTION_VERSION, caseId: task.caseId,
    taskId: task.taskId, runId, scope, contextAsOf: now, records, evidenceRefs, deterministicChecks: { ...runDeterministicChecks(records, scope), ...(intake ? { threeWay: intake.threeWay } : {}) }, approvedPolicies, humanClarifications,
  };
  if (JSON.stringify(providerInput).length > 180_000) throw new Error("Evidence context exceeds the safe development snapshot size; narrow the source adapter");
  const run: FinanceInvestigationRun = {
    caseId: task.caseId, taskId: task.taskId, runId, parentRunId: parent?.runId ?? null, attempt,
    mode: config.mode, simulated: config.mode === "mock", status: "queued", scope, createdAt: now, updatedAt: now,
    externalRunId: null, providerInput, result: null, error: null,
    ...(config.mode === "creao" ? { providerAppId: env.CREAO_APP_ID ?? "" } : {}),
  };
  await ctx.db.insert("financeInvestigationRuns", { ...run, executionClaimed: false, pollCount: 0, deadline: now + RUN_TIMEOUT_MS });
  await ctx.db.patch("financeTasks", task._id, { status: "investigating", activeRunId: runId });
  await appendBoundary(ctx, run, "finance.investigation.started", `Attempt ${attempt} started for ${scope.kind}; available records only.`);
  if (parent) await appendBoundary(ctx, run, "finance.investigation.resumed", "New attempt preserves the prior result and includes saved task clarifications.");
  run.status = "retrieving_evidence";
  await appendBoundary(ctx, run, "finance.evidence.retrieved", `Frozen ${records.transactions.length} transaction(s), ${records.documents.length} document(s), and ${humanClarifications.length} clarification(s); full provider context persisted.`);
  run.status = "checking";
  await appendBoundary(ctx, run, "finance.checks.completed", "Deterministic arithmetic completed; missing balances remain insufficient_data. No allocation approved.");
  await ctx.scheduler.runAfter(0, internal.financeInvestigationActions.execute, { runId });
  await ctx.scheduler.runAfter(RUN_TIMEOUT_MS, internal.financeInvestigations.expireRun, { runId });
  return { runId, created: true };
}

export const startInvestigation = mutation({
  args: { taskId: v.string(), scope: validators.scope.omit("cutoff").extend({ cutoff: v.optional(v.number()) }) }, returns: startResult,
  handler: async (ctx, args) => {
    const task = await requireTask(ctx, args.taskId);
    const parent = await ctx.db.query("financeInvestigationRuns").withIndex("by_taskId_and_attempt", (q) => q.eq("taskId", task.taskId)).order("desc").first();
    return await makeAttempt(ctx, task, args.scope, parent);
  },
});

export const getRecords = query({
  args: { taskId: v.string(), scope: validators.scope }, returns: validators.records,
  handler: async (ctx, args) => {
    const task = await requireTask(ctx, args.taskId);
    return task.accountId ? (await readIntakeRecords(ctx, task, args.scope)).records : await readRecords(ctx, task, args.scope);
  },
});

export const getTaskInvestigation = query({
  args: { taskId: v.string() }, returns: validators.taskView,
  handler: async (ctx, { taskId }): Promise<TaskInvestigationView> => {
    const runs = (await ctx.db.query("financeInvestigationRuns").withIndex("by_taskId_and_attempt", (q) => q.eq("taskId", taskId)).order("desc").take(50)).map(publicRun);
    const questions = (await ctx.db.query("financeInvestigationQuestions").withIndex("by_taskId", (q) => q.eq("taskId", taskId)).order("desc").take(100)).map(recordOnly);
    const clarifications = (await ctx.db.query("financeClarifications").withIndex("by_taskId_and_timestamp", (q) => q.eq("taskId", taskId)).order("desc").take(100)).map(recordOnly);
    const latest = runs[0];
    return { runs, questions, clarifications, auditHandoff: latest?.result ? { kind: "finance.investigation.review_requested", taskId, runId: latest.runId, contextRunId: latest.runId, resultAvailable: true, visualAuditStatus: "not_connected" } : null };
  },
});

export const answerQuestion = mutation({
  args: { runId: v.string(), questionId: v.string(), answer: v.string(), evidenceRefs: v.optional(v.array(validators.evidenceReference)) }, returns: startResult,
  handler: async (ctx, args) => {
    const answer = args.answer.trim();
    if (!answer || answer.length > 4000) throw new Error("Answer must contain 1–4000 characters");
    const run = await findRun(ctx, args.runId);
    const task = await requireTask(ctx, run.taskId);
    const question = await ctx.db.query("financeInvestigationQuestions").withIndex("by_questionId", (q) => q.eq("questionId", args.questionId)).unique();
    if (!question || question.runId !== run.runId || question.taskId !== task.taskId) throw new Error("Question does not belong to this task/run");
    if (question.status !== "open") throw new Error("This question already has a saved clarification");
    if (task.activeRunId) throw new Error("Wait for the active investigation before saving another clarification");
    const latest = await ctx.db.query("financeInvestigationRuns").withIndex("by_taskId_and_attempt", (q) => q.eq("taskId", task.taskId)).order("desc").first();
    if (!latest) throw new Error("Investigation history is incomplete");
    const evidenceRefs = args.evidenceRefs ?? [];
    if (evidenceRefs.length > 20 || evidenceRefs.some((ref) => !run.providerInput?.records.documents.some((document) => document.sourceId === ref.sourceId && document.documentId === ref.documentId && document.text.includes(ref.excerpt) && ref.excerpt.length > 0))) {
      throw new Error("Clarification evidence references must identify excerpts in supplied source documents");
    }
    const identity = await ctx.auth.getUserIdentity();
    const timestamp = Date.now();
    const clarificationId = `${question.questionId}:clarification`;
    const respondent = { identity: identity?.tokenIdentifier ?? "unauthenticated:finance-dev", authenticated: identity !== null };
    await ctx.db.insert("financeClarifications", {
      clarificationId, sourceId: `clarification:${clarificationId}`, questionId: question.questionId, question: question.question,
      answer, caseId: task.caseId, taskId: task.taskId, runId: run.runId, timestamp, respondent, evidenceRefs,
    });
    await ctx.db.patch("financeInvestigationQuestions", question._id, { status: "answered", clarificationId });
    await appendBoundary(ctx, publicRun(run), "finance.clarification.saved", "Human clarification saved as task-scoped evidence, without financial authorization.", { questionId: question.questionId, clarificationId }, { type: "human", component: "finance-dev", ...respondent });
    return await makeAttempt(ctx, task, latest.scope, latest);
  },
});

export const claimExecution = internalMutation({
  args: { runId: v.string() }, returns: v.union(validators.run, v.null()),
  handler: async (ctx, { runId }) => {
    const run = await findRun(ctx, runId);
    if (run.executionClaimed || !ACTIVE.has(run.status)) return null;
    if (Date.now() >= run.deadline) {
      await failRun(ctx, run, timeoutError(run));
      return null;
    }
    await ctx.db.patch("financeInvestigationRuns", run._id, { executionClaimed: true, status: "provider_starting", updatedAt: Date.now() });
    const claimed = { ...publicRun(run), status: "provider_starting" as const };
    await appendBoundary(ctx, claimed, "finance.provider.started", `${run.simulated ? "SIMULATED mock" : "CREAO"} provider invocation started; only backend boundaries are recorded.`);
    return claimed;
  },
});

export const getRun = internalQuery({
  args: { runId: v.string() }, returns: v.union(validators.storedRun, v.null()),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.query("financeInvestigationRuns").withIndex("by_runId", (q) => q.eq("runId", runId)).unique();
    return run ? recordOnly(run) : null;
  },
});

export const recordPending = internalMutation({
  args: { runId: v.string(), externalRunId: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const run = await retainExternalRunId(ctx, await findRun(ctx, args.runId), args.externalRunId);
    if (!ACTIVE.has(run.status)) return null;
    if (Date.now() >= run.deadline) {
      await failRun(ctx, run, timeoutError(run));
      return null;
    }
    await ctx.db.patch("financeInvestigationRuns", run._id, { externalRunId: args.externalRunId, status: "provider_pending", updatedAt: Date.now(), pollCount: run.pollCount + 1 });
    await ctx.scheduler.runAfter(3000, internal.financeInvestigationActions.poll, { runId: run.runId });
    return null;
  },
});

async function failRun(ctx: MutationCtx, run: Doc<"financeInvestigationRuns">, error: InvestigationError, validation = false) {
  if (!ACTIVE.has(run.status)) return;
  const failed = { ...publicRun(run), status: "failed" as const, error, updatedAt: Date.now() };
  await ctx.db.patch("financeInvestigationRuns", run._id, { status: failed.status, error, updatedAt: failed.updatedAt });
  const task = await requireTask(ctx, run.taskId);
  if (task.activeRunId === run.runId) await ctx.db.patch("financeTasks", task._id, { status: "investigation_failed", activeRunId: undefined });
  await appendBoundary(ctx, failed, validation ? "finance.validation.failed" : "finance.investigation.failed", error.message, { errorCode: error.code, ...(run.externalRunId ? { externalRunId: run.externalRunId } : {}) });
}

export const recordFailure = internalMutation({
  args: { runId: v.string(), error: validators.investigationError, externalRunId: v.optional(v.string()) }, returns: v.null(),
  handler: async (ctx, args) => {
    let run = await findRun(ctx, args.runId);
    if (args.externalRunId) run = await retainExternalRunId(ctx, run, args.externalRunId);
    await failRun(ctx, run, args.error, args.error.code === "validation_failed");
    return null;
  },
});

export const recordResult = internalMutation({
  // Unknown model data is passed as JSON text; parsing and semantic validation happen before storage.
  args: { runId: v.string(), externalRunId: v.string(), outputJson: v.string(), reportSource: v.optional(validators.reportSource) }, returns: v.null(),
  handler: async (ctx, args) => {
    let run = await retainExternalRunId(ctx, await findRun(ctx, args.runId), args.externalRunId);
    if (!ACTIVE.has(run.status)) return null;
    if (Date.now() >= run.deadline) {
      await failRun(ctx, run, timeoutError(run));
      return null;
    }
    await ctx.db.patch("financeInvestigationRuns", run._id, { externalRunId: args.externalRunId, status: "validating", updatedAt: Date.now(), ...(args.reportSource ? { reportSource: args.reportSource } : {}) });
    run = await findRun(ctx, args.runId);
    await appendBoundary(ctx, publicRun(run), "finance.provider.result_received", "Provider response received; validating schema, evidence references, and deterministic allocation checks.", { externalRunId: args.externalRunId });
    let result: FinanceAgentOutput;
    try {
      if (!run.providerInput) throw new Error("Persisted provider input is missing");
      if (args.outputJson.length > 120_000) throw new Error("Provider output exceeds the bounded result size");
      result = validateFinanceAgentOutput(JSON.parse(args.outputJson) as unknown, run.providerInput);
    } catch (error) {
      const details = error instanceof FinanceOutputValidationError ? error.details : [{ path: "$", reason: "Result must be valid JSON within the supported size and have a saved provider context." }];
      await failRun(ctx, run, { code: "validation_failed", message: "Provider result failed validation. No proposal was accepted.", retryable: false, details }, true);
      return null;
    }
    const status = result.outcome === "needs_information" ? "needs_information" : result.outcome === "proposal_ready" ? "review_required" : "completed";
    const resultChecks = runDeterministicChecks(run.providerInput!.records, run.scope, result.proposedAllocations);
    const completed: FinanceInvestigationRun = { ...publicRun(run), status, result, resultChecks, updatedAt: Date.now() };
    await ctx.db.patch("financeInvestigationRuns", run._id, { status, result, resultChecks, updatedAt: completed.updatedAt });
    const task = await requireTask(ctx, run.taskId);
    if (task.activeRunId === run.runId) await ctx.db.patch("financeTasks", task._id, { status: status === "completed" ? "investigation_completed" : status, activeRunId: undefined });
    for (const item of result.questions) {
      const questionId = `${run.runId}:question:${item.key}`;
      await ctx.db.insert("financeInvestigationQuestions", { caseId: run.caseId, taskId: run.taskId, runId: run.runId, questionId, ...item, status: "open", clarificationId: null });
      await appendBoundary(ctx, completed, "finance.question.raised", item.question, { questionId });
    }
    await appendBoundary(ctx, completed, "finance.investigation.completed", result.summary, { externalRunId: args.externalRunId });
    if (task.accountId && result.outcome === "proposal_ready") await queueAgentAllocations(ctx, task.accountId, completed, result);
    return null;
  },
});

/** Validated agent allocations enter the approval queue through the same lock rules as a person's. Never auto-posted. */
async function queueAgentAllocations(ctx: MutationCtx, accountId: string, run: FinanceInvestigationRun, result: FinanceAgentOutput) {
  const byDeposit = new Map<string, FinanceAgentOutput["proposedAllocations"]>();
  for (const row of result.proposedAllocations) byDeposit.set(row.transactionId, [...(byDeposit.get(row.transactionId) ?? []), row]);
  const actor = { identity: `agent:finance-investigator:${run.runId}`, authenticated: false, role: "system" as const };
  for (const [bankSourceId, rows] of byDeposit) {
    const now = Date.now();
    await submitProposal(ctx, {
      proposalId: await nextProposalId(ctx, accountId, "allocation"), accountId, kind: "allocation", status: "proposed", currency: rows[0].currency,
      requestedBy: actor.identity, origin: { type: "agent", taskId: run.taskId, runId: run.runId, agentProposalIds: rows.map(r => r.proposalId) },
      evidenceSourceIds: [...new Set(rows.flatMap(r => r.evidenceSourceIds))], bankSourceId, shares: rows.map(r => ({ ownerId: r.ownerId, amountCents: r.amountCents })),
      amountCents: rows.reduce((sum, r) => sum + r.amountCents, 0), purpose: `Agent proposal from ${run.runId} (unapproved)`, createdAt: now, updatedAt: now,
    }, actor);
  }
}

export const expireRun = internalMutation({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await findRun(ctx, runId);
    if (Date.now() >= run.deadline) await failRun(ctx, run, timeoutError(run));
    return null;
  },
});
