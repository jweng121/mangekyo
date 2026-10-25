import { ConvexError, v } from "convex/values";
import {
  FINANCE_INPUT_VERSION, FINANCE_INSTRUCTION_VERSION,
  type FinanceAgentInput, type FinanceAgentOutput, type FinanceInvestigationRun, type LockResult,
  type InvestigationEvent, type InvestigationEventType, type InvestigationError,
  type InvestigationStartScope, type InvestigationScope, type TaskInvestigationView, type ThreeWayCheckResult,
} from "@mangekyo/contracts";
import type { CorrectionKind } from "@mangekyo/contracts/orchestration";
import { runDeterministicChecks } from "@mangekyo/finance-core/checks";
import { validateFinanceAgentOutput, FinanceOutputValidationError } from "@mangekyo/finance-core/agent";
import { buildCheckerInput, CheckerOutputValidationError, codeCheckClaims, finalizeClaimCheck, mockClaimCheckerProvider, validateCheckerOutput } from "@mangekyo/finance-core/checker";
import { evalCaseFromCorrection, evalCaseFromRejection } from "@mangekyo/finance-core/eval";
import { ACTIVE_STATES, MAX_AUTOMATIC_RETRIES, settledState, type OrchestratorActor, type Trigger } from "@mangekyo/finance-core/orchestrator";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import * as validators from "./lib/validators";
import * as orch from "./lib/orchestratorValidators";
import { accountClarifications, captureStep, configFor, provenanceFor, readEnv } from "./lib/agents";
import { publicRun, readRecords, recordOnly, requireTask, validateScope } from "./lib/investigationRecords";
import { nextProposalId, readIntakeRecords, submitProposal } from "./lib/money";
import { checkBudget, CODE_ACTOR, ensureOrchestration, step, stepForRun, SYSTEM_ACTOR } from "./lib/orchestrator";

const ACTIVE = new Set(["queued", "retrieving_evidence", "checking", "provider_starting", "provider_pending", "validating"]);
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const startResult = v.object({ runId: v.string(), created: v.boolean(), refused: v.optional(v.object({ code: v.string(), message: v.string() })) });
type StartResult = { runId: string; created: boolean; refused?: { code: string; message: string } };
const AGENT: OrchestratorActor = { type: "agent", identity: "agent:trust-intake" };
type Mode = "mock" | "creao" | "external";

/** Trust Intake (was the investigator): INTAKE_MODE, with FINANCE_AGENT_MODE as its alias. Unset means mock. */
export function providerMode(): Mode | null {
  return configuration().mode;
}

/** Evidence Checker (was the claim checker): EVIDENCE_CHECKER_MODE, with CHECKER_MODE as its alias. The code part always runs. */
export function checkerMode(): Mode | null {
  return configFor("evidence_checker").mode;
}

export function checkerConfiguration(): { mode: Mode | null; configured: boolean; message: string } {
  const c = configFor("evidence_checker");
  return { mode: c.mode, configured: c.configured, message: c.mode === null ? "EVIDENCE_CHECKER_MODE (or CHECKER_MODE) must be mock, creao or external (unset means mock). No investigation starts until it is fixed."
    : c.mode === "mock" ? "Checker agent simulated: deterministic mock behind the provider interface. Code checks always run." : c.message };
}

function configuration(): { mode: Mode | null; configured: boolean; message: string } {
  const c = configFor("intake");
  return { mode: c.mode, configured: c.configured, message: c.mode === null ? "Set INTAKE_MODE (or FINANCE_AGENT_MODE) to mock, creao or external on the Convex deployment." : c.mode === "mock" ? "SIMULATED: deterministic mock provider; no external model runs." : c.configured ? `${c.message} External agent runs use server-side credentials.` : `${c.message} No mock fallback.` };
}

export type AutoInvestigationCode = "AUTO_ENABLED" | "MODE_NOT_CONFIGURED" | "PROVIDER_NOT_CONFIGURED" | "AUTO_DISABLED_SETTING" | "AUTO_OFF_IN_CREAO" | "AUTO_SETTING_INVALID";

/** AUTO_INVESTIGATE defaults on in mock mode and off in any paid mode (creao, external); only an explicit "true" opts a paid mode in. */
export function autoInvestigationSetting(): { enabled: boolean; code: AutoInvestigationCode; message: string } {
  const config = configuration();
  const raw = (readEnv("AUTO_INVESTIGATE") ?? "").trim().toLowerCase();
  if (raw !== "" && raw !== "true" && raw !== "false") return { enabled: false, code: "AUTO_SETTING_INVALID", message: "AUTO_INVESTIGATE must be true or false; auto-investigation is off." };
  if (!config.mode) return { enabled: false, code: "MODE_NOT_CONFIGURED", message: config.message };
  if (!config.configured) return { enabled: false, code: "PROVIDER_NOT_CONFIGURED", message: config.message };
  if (raw === "false") return { enabled: false, code: "AUTO_DISABLED_SETTING", message: "AUTO_INVESTIGATE=false: new deposits wait for a person to start an investigation." };
  if (config.mode !== "mock" && raw !== "true") return { enabled: false, code: "AUTO_OFF_IN_CREAO", message: `Auto-investigation is off in ${config.mode} mode so no paid run starts without a person. Set AUTO_INVESTIGATE=true to opt in.` };
  return { enabled: true, code: "AUTO_ENABLED", message: `New recorded, unallocated deposits are investigated automatically in ${config.mode} mode. Pending deposits cannot receive allocation proposals. Proposals still need a person to approve.` };
}

export const getAutoInvestigationSetting = query({
  args: {}, returns: v.object({ enabled: v.boolean(), code: v.string(), message: v.string() }),
  handler: async () => autoInvestigationSetting(),
});

export const getProviderConfiguration = query({
  args: {}, returns: v.object({ mode: v.union(validators.mode, v.null()), configured: v.boolean(), message: v.string() }),
  handler: async () => configuration(),
});

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
      error: run.error, ...(run.reportSource ? { reportSource: run.reportSource } : {}), ...(run.claimCheck ? { claimCheck: run.claimCheck } : {}) },
  });
}

/** One immutable step snapshot (visual audit) plus its finance.snapshot.captured event on the run's stream. */
async function snapshotStep(ctx: MutationCtx, run: FinanceInvestigationRun, accountId: string | null, kind: Parameters<typeof captureStep>[1]["kind"], actor: OrchestratorActor, startedAt: number,
  details: { input: unknown; output?: unknown | null; checkerVerdicts?: Parameters<typeof captureStep>[1]["checkerVerdicts"]; lockResults?: LockResult[] | null; message: string; agent?: "intake" | "evidence_checker" }) {
  const agent = details.agent ?? "intake";
  const provenance = (agent === "evidence_checker" ? run.checkerProvenance : run.provenance) ?? provenanceFor(agent);
  const snapshot = await captureStep(ctx, { runId: run.runId, taskId: run.taskId, accountId, agent, kind, actor, provenance: { ...provenance, agent, mode: provenance.mode as Mode }, startedAt, ...details });
  await appendBoundary(ctx, run, "finance.snapshot.captured", `Step ${snapshot.stepIndex} (${kind}) saved for the visual audit: ${details.message}`, { stepIndex: snapshot.stepIndex, snapshotId: snapshot.snapshotId });
  return snapshot;
}

/** Who or what started an attempt, recorded on the orchestrator's transition. */
interface AttemptCause { trigger: Trigger; actor: OrchestratorActor }

async function personActor(ctx: MutationCtx, fallback: string): Promise<OrchestratorActor> {
  const identity = await ctx.auth.getUserIdentity();
  return { type: "person", identity: identity?.tokenIdentifier ?? fallback };
}

const FIELD_PATH = /^records\.(bankTransactions|transactions)\[(\d+)\]\.(reference|counterparty|description)$/;

/** A person's correct_input_field corrections for this task, applied to the new attempt's frozen input and noted in it. */
async function applyInputCorrections(ctx: MutationCtx, taskId: string, records: FinanceAgentInput["records"]): Promise<FinanceAgentInput["records"]> {
  const corrections = (await ctx.db.query("financeRunCorrections").withIndex("by_taskId", q => q.eq("taskId", taskId)).take(50)).filter(c => c.kind === "correct_input_field");
  if (corrections.length === 0) return records;
  const next: FinanceAgentInput["records"] = JSON.parse(JSON.stringify(records));
  for (const c of corrections) {
    const match = FIELD_PATH.exec(c.payload.path ?? "");
    if (!match) continue;
    const [, collection, index, field] = match;
    const rows = (collection === "bankTransactions" ? next.bankTransactions : next.transactions) as Array<Record<string, unknown>> | undefined;
    const row = rows?.[Number(index)];
    if (!row || typeof row[field] !== "string") continue;
    row[field] = c.payload.value;
    next.missingEvidence.push(`A person (${c.actor}) corrected ${c.payload.path} to "${c.payload.value}" in correction ${c.correctionId}: ${c.reason}`);
  }
  return next;
}

/** Exactly what the Trust Intake agent is given for one attempt (also the smoke test's input). */
export function buildIntakeInput(args: {
  caseId: string; taskId: string; runId: string; scope: InvestigationScope; now: number; records: FinanceAgentInput["records"]; threeWay: ThreeWayCheckResult | null;
  approvedPolicies: FinanceAgentInput["approvedPolicies"]; humanClarifications: FinanceAgentInput["humanClarifications"];
}): FinanceAgentInput {
  const { records, scope } = args;
  const evidenceRefs = records.documents.map((document) => ({ documentId: document.documentId, sourceId: document.sourceId, excerpt: document.excerpt }));
  const providerInput: FinanceAgentInput = {
    schemaVersion: FINANCE_INPUT_VERSION, instructionVersion: FINANCE_INSTRUCTION_VERSION, caseId: args.caseId,
    taskId: args.taskId, runId: args.runId, scope, contextAsOf: args.now, records, evidenceRefs, deterministicChecks: { ...runDeterministicChecks(records, scope), ...(args.threeWay ? { threeWay: args.threeWay } : {}) }, approvedPolicies: args.approvedPolicies, humanClarifications: args.humanClarifications,
  };
  if (JSON.stringify(providerInput).length > 180_000) throw new Error("Evidence context exceeds the safe development snapshot size; narrow the source adapter");
  return providerInput;
}

async function makeAttempt(ctx: MutationCtx, task: Doc<"financeTasks">, requestedScope: InvestigationStartScope, parent: Doc<"financeInvestigationRuns"> | null, cause: AttemptCause): Promise<StartResult> {
  const now = Date.now();
  const scope: InvestigationScope = { ...requestedScope, cutoff: requestedScope.cutoff ?? now };
  let intake: Awaited<ReturnType<typeof readIntakeRecords>> | null = null;
  try { if (task.accountId) intake = await readIntakeRecords(ctx, task, scope); else validateScope(scope); } catch (error) {
    throw new ConvexError(error instanceof Error ? error.message : "Choose a valid investigation period.");
  }
  if (scope.cutoff > now) throw new ConvexError("Investigation cutoff cannot be in the future. Choose a time at or before the current server time, or leave the cutoff blank.");
  // One active run per deposit: a second start returns the running one.
  if (task.activeRunId) {
    const active = await findRun(ctx, task.activeRunId);
    if (ACTIVE.has(active.status)) return { runId: active.runId, created: false };
  }
  const config = configuration();
  if (!config.mode) throw new Error(config.message);
  const checker = checkerMode();
  if (!checker) throw new ConvexError(checkerConfiguration().message);
  const intakeConfig = configFor("intake");
  const checkerConfig = configFor("evidence_checker");
  let orchestration = await ensureOrchestration(ctx, { kind: "deposit", taskId: task.taskId, accountId: task.accountId ?? null, subjectSourceId: task.bankSourceId ?? task.transactionId,
    trigger: cause.trigger === "auto_start" ? "deposit_received" : cause.trigger, actor: cause.actor, reason: { code: "RECEIVED", message: "Deposit received by the orchestrator." } });
  if (ACTIVE_STATES.has(orchestration.state)) {
    orchestration = await step(ctx, orchestration, { to: "failed", trigger: "timeout", actor: SYSTEM_ACTOR, activeRunId: null, reason: { code: "STALE", message: "The previous run was no longer active; closed before starting a new one." } });
  }
  // Real-run budget: every agent in a paid mode (creao or external) counts one. Mock runs need 0 and always pass.
  const needed = intakeConfig.realRuns + checkerConfig.realRuns;
  const budget = await checkBudget(ctx, task.taskId, needed, now);
  orchestration = await step(ctx, orchestration, { kind: "budget_check", to: orchestration.state, trigger: cause.trigger, actor: CODE_ACTOR, reason: { code: budget.code, message: budget.message }, budget });
  if (!budget.allowed) {
    await step(ctx, orchestration, { to: "needs_person", trigger: "budget_refused", actor: CODE_ACTOR, reason: { code: budget.code, message: budget.message }, budget });
    return { runId: parent?.runId ?? "", created: false, refused: { code: budget.code, message: budget.message } };
  }
  const attempt = (parent?.attempt ?? 0) + 1;
  const runId = `${task.taskId}:investigation:${attempt}`;
  const records = await applyInputCorrections(ctx, task.taskId, intake ? intake.records : await readRecords(ctx, task, scope));
  // Memory: the task's own answers plus every person's answer on the account.
  const humanClarifications = await accountClarifications(ctx, task.taskId, task.accountId ?? null, now);
  const approvedPolicies = (await ctx.db.query("financeApprovedPolicies")
    .withIndex("by_accountId_and_currency_and_approvedAt", (q) => q.eq("accountId", scope.accountId).eq("currency", scope.currency).lte("approvedAt", scope.cutoff)).take(101)).map(recordOnly);
  if (approvedPolicies.length > 100) throw new Error("Context exceeds the bounded development policy/clarification limit");
  const providerInput = buildIntakeInput({ caseId: task.caseId, taskId: task.taskId, runId, scope, now, records, threeWay: intake?.threeWay ?? null, approvedPolicies, humanClarifications });
  const provenance = provenanceFor("intake");
  const checkerProvenance = provenanceFor("evidence_checker");
  const run: FinanceInvestigationRun = {
    caseId: task.caseId, taskId: task.taskId, runId, parentRunId: parent?.runId ?? null, attempt,
    mode: config.mode, simulated: config.mode === "mock", status: "queued", scope, createdAt: now, updatedAt: now,
    externalRunId: null, providerInput, result: null, error: null, provenance, checkerProvenance,
    ...(config.mode === "creao" ? { providerAppId: intakeConfig.appId ?? "" } : {}),
  };
  await ctx.db.insert("financeInvestigationRuns", { ...run, executionClaimed: false, pollCount: 0, deadline: now + RUN_TIMEOUT_MS,
    providerRetries: 0, checkerRetries: 0, checkerMode: checker, ...(checker === "creao" ? { checkerAppId: checkerConfig.appId ?? "" } : {}) });
  for (const [provider, c] of [["intake", intakeConfig], ["evidence_checker", checkerConfig]] as const) {
    if (c.realRuns) await ctx.db.insert("financeRealRuns", { runId, taskId: task.taskId, accountId: task.accountId ?? null, provider, day: new Date(now).toISOString().slice(0, 10), at: now });
  }
  await ctx.db.patch("financeTasks", task._id, { status: "investigating", activeRunId: runId });
  await step(ctx, orchestration, { to: "investigating", trigger: cause.trigger, actor: cause.actor, run, activeRunId: runId,
    reason: { code: "ATTEMPT_STARTED", message: `Attempt ${attempt} started: intake ${config.mode} (${provenance.model}), evidence checker ${checker} (${checkerProvenance.model}).` } });
  await appendBoundary(ctx, run, "finance.investigation.started", `Attempt ${attempt} started for ${scope.kind}; available records only.`);
  if (parent) await appendBoundary(ctx, run, "finance.investigation.resumed", "New attempt preserves the prior result and includes saved task clarifications.");
  run.status = "retrieving_evidence";
  await appendBoundary(ctx, run, "finance.evidence.retrieved", `Frozen ${records.transactions.length} transaction(s), ${records.documents.length} document(s), and ${humanClarifications.length} clarification(s); full provider context persisted.`);
  run.status = "checking";
  await appendBoundary(ctx, run, "finance.checks.completed", "Deterministic arithmetic completed; missing balances remain insufficient_data. No allocation approved.");
  await snapshotStep(ctx, run, task.accountId ?? null, "input_frozen", cause.actor, now, { input: providerInput, message: `Exactly what the Trust Intake agent is given for attempt ${attempt}.` });
  await ctx.scheduler.runAfter(0, internal.financeInvestigationActions.execute, { runId });
  await ctx.scheduler.runAfter(RUN_TIMEOUT_MS, internal.financeInvestigations.expireRun, { runId });
  return { runId, created: true };
}

async function latestAttempt(ctx: MutationCtx, taskId: string) {
  return await ctx.db.query("financeInvestigationRuns").withIndex("by_taskId_and_attempt", (q) => q.eq("taskId", taskId)).order("desc").first();
}

export const startInvestigation = mutation({
  args: { taskId: v.string(), scope: validators.scope.omit("cutoff").extend({ cutoff: v.optional(v.number()) }) }, returns: startResult,
  handler: async (ctx, args) => {
    const task = await requireTask(ctx, args.taskId);
    return await makeAttempt(ctx, task, args.scope, await latestAttempt(ctx, task.taskId), { trigger: "person_started", actor: await personActor(ctx, "unauthenticated:finance-dev") });
  },
});

/** Automatic starts (new deposits, a deposit that cleared, the demo feed). Same idempotent start as a person's. */
export const autoStartInvestigation = internalMutation({
  args: { taskId: v.string(), scope: validators.scope.omit("cutoff").extend({ cutoff: v.optional(v.number()) }), trigger: v.union(v.literal("auto_start"), v.literal("deposit_cleared")) }, returns: startResult,
  handler: async (ctx, args) => {
    const task = await requireTask(ctx, args.taskId);
    return await makeAttempt(ctx, task, args.scope, await latestAttempt(ctx, task.taskId), { trigger: args.trigger, actor: SYSTEM_ACTOR });
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
    const latest = await latestAttempt(ctx, task.taskId);
    if (!latest) throw new Error("Investigation history is incomplete");
    const evidenceRefs = args.evidenceRefs ?? [];
    if (evidenceRefs.length > 20 || evidenceRefs.some((ref) => !run.providerInput?.records.documents.some((document) => document.sourceId === ref.sourceId && document.documentId === ref.documentId && document.text.includes(ref.excerpt) && ref.excerpt.length > 0))) {
      throw new Error("Clarification evidence references must identify excerpts in supplied source documents");
    }
    const identity = await ctx.auth.getUserIdentity();
    const timestamp = Date.now();
    const clarificationId = `${question.questionId}:clarification`;
    const respondent = { identity: identity?.tokenIdentifier ?? "unauthenticated:finance-dev", authenticated: identity !== null };
    // Saved as memory for the whole account: the next run on any of its deposits sees it.
    await ctx.db.insert("financeClarifications", {
      clarificationId, sourceId: `clarification:${clarificationId}`, questionId: question.questionId, question: question.question,
      answer, caseId: task.caseId, taskId: task.taskId, runId: run.runId, timestamp, respondent, evidenceRefs, ...(task.accountId ? { accountId: task.accountId } : {}),
    });
    await ctx.db.patch("financeInvestigationQuestions", question._id, { status: "answered", clarificationId });
    await appendBoundary(ctx, publicRun(run), "finance.clarification.saved", "Human clarification saved as task-scoped evidence and account memory, without financial authorization.", { questionId: question.questionId, clarificationId }, { type: "human", component: "finance-dev", ...respondent });
    return await makeAttempt(ctx, task, latest.scope, latest, { trigger: "person_answered", actor: { type: "person", identity: respondent.identity } });
  },
});

export interface CorrectionArgs { runId: string; stepIndex: number | null; kind: CorrectionKind; payload: Record<string, string>; reason: string; actor: { role: "requester" | "approver"; name: string }; onlyCheckerStopped: boolean }

/**
 * A person corrects a run: cite their saved answer, dispute the checker, add a document, or correct an input field. The correction is
 * saved as a clarification (and a correction row), and a new linked attempt starts. The corrected run is never changed.
 */
export async function applyCorrection(ctx: MutationCtx, args: CorrectionArgs): Promise<StartResult & { correctionId: string }> {
  const run = await findRun(ctx, args.runId);
  if (args.onlyCheckerStopped && run.status !== "checker_rejected") throw new ConvexError("Only a run the checker stopped can be corrected and rerun.");
  if (ACTIVE.has(run.status)) throw new ConvexError("Wait for the run to finish before correcting it.");
  const task = await requireTask(ctx, run.taskId);
  const latest = await latestAttempt(ctx, task.taskId);
  if (!latest || latest.runId !== run.runId) throw new ConvexError("A newer attempt exists; correct the latest run.");
  if (task.activeRunId) throw new ConvexError("Wait for the active investigation to finish.");
  const note = (args.payload.note ?? args.payload.text ?? "").trim();
  const reason = args.reason.trim();
  if (reason.length > 4000) throw new ConvexError("The reason can be at most 4000 characters.");
  if (args.kind === "checker_wrong" && !(note || reason)) throw new ConvexError("Give the reason the checker is wrong (required).");
  if (args.kind === "add_document" && (!note || note.length > 4000)) throw new ConvexError("Paste the document text (required).");
  if (args.kind === "correct_input_field") {
    const path = (args.payload.path ?? "").trim(); const value = (args.payload.value ?? "").trim();
    if (!FIELD_PATH.test(path)) throw new ConvexError("correct_input_field accepts records.bankTransactions[i].reference|counterparty or records.transactions[i].description.");
    if (!value || value.length > 500) throw new ConvexError("Give the corrected value (1–500 characters).");
    if (!reason) throw new ConvexError("Give the reason for the correction (required).");
  }
  const earlier = (await ctx.db.query("financeClarifications").withIndex("by_taskId_and_timestamp", (q) => q.eq("taskId", task.taskId)).take(100)).filter(c => !c.questionId.endsWith(":correction"));
  if (args.kind === "cite_clarification" && earlier.length === 0) throw new ConvexError("There is no saved answer to cite yet.");
  const identity = await ctx.auth.getUserIdentity();
  const name = args.actor.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "unknown";
  const respondent = { identity: identity?.tokenIdentifier ?? `dev-unverified:${name}`, authenticated: identity !== null };
  const clarificationId = `${run.runId}:correction`;
  const correctionId = `${run.runId}:correction:${args.kind}`;
  if (await ctx.db.query("financeRunCorrections").withIndex("by_correctionId", q => q.eq("correctionId", correctionId)).unique()) throw new ConvexError("This run already has that correction; correct the newest attempt instead.");
  const question = args.kind === "cite_clarification" ? `Correction after the checker stopped run ${run.attempt}: cite the person's saved answer (${earlier.map(c => c.sourceId).join(", ")}) as the source for the owner claim.`
    : args.kind === "checker_wrong" ? `A person disputes the checker's verdict on run ${run.attempt}. Code-found contradictions still apply.`
    : args.kind === "add_document" ? `Document added by a person after run ${run.attempt}.`
    : `A person corrected input field ${args.payload.path} on run ${run.attempt} to "${args.payload.value}".`;
  const answer = args.kind === "cite_clarification" ? (note || earlier.map(c => c.answer).join(" / ")) : args.kind === "correct_input_field" ? (reason || args.payload.value) : (note || reason);
  const now = Date.now();
  await ctx.db.insert("financeClarifications", { clarificationId, sourceId: `clarification:${clarificationId}`, questionId: clarificationId, question, answer, caseId: task.caseId, taskId: task.taskId, runId: run.runId, timestamp: now, respondent, evidenceRefs: [], ...(task.accountId ? { accountId: task.accountId } : {}) });
  await appendBoundary(ctx, publicRun(run), "finance.clarification.saved", `${respondent.identity} chose "${args.kind.replace(/_/g, " ")}"${args.stepIndex !== null ? ` at step ${args.stepIndex}` : ""} and reran from step 3. Run ${run.attempt} stays as it was.${reason ? ` Reason: ${reason}` : ""}`, { clarificationId }, { type: "human", component: "finance-dev", ...respondent });
  // The correction row is written before the new attempt starts, so the attempt's frozen input can apply a corrected field.
  const expectedRunId = `${task.taskId}:investigation:${latest.attempt + 1}`;
  const rowId = await ctx.db.insert("financeRunCorrections", { correctionId, runId: run.runId, taskId: task.taskId, stepIndex: args.stepIndex ?? 0, kind: args.kind, payload: args.payload, reason, actor: respondent.identity, newRunId: expectedRunId, clarificationId, createdAt: now });
  const started = await makeAttempt(ctx, task, latest.scope, latest, { trigger: "person_corrected", actor: { type: "person", identity: respondent.identity } });
  if (started.runId !== expectedRunId) await ctx.db.patch("financeRunCorrections", rowId, { newRunId: started.runId });
  return { ...started, correctionId };
}

/** The desk's correct-and-rerun for a run the checker stopped. submitCorrection (financeAgentApi) is the general form. */
export const correctAndRerun = mutation({
  args: { runId: v.string(), choice: v.union(v.literal("cite_clarification"), v.literal("checker_wrong"), v.literal("add_document")), note: v.string(), dev: v.object({ role: v.union(v.literal("requester"), v.literal("approver")), name: v.string() }) },
  returns: startResult,
  handler: async (ctx, args) => {
    const { correctionId, ...started } = await applyCorrection(ctx, { runId: args.runId, stepIndex: null, kind: args.choice, payload: { note: args.note }, reason: args.choice === "cite_clarification" ? "" : args.note.trim(), actor: args.dev, onlyCheckerStopped: true });
    void correctionId;
    return started;
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
    await appendBoundary(ctx, claimed, "finance.provider.started", `${run.simulated ? "SIMULATED mock" : run.mode === "creao" ? "CREAO" : "External model"} provider invocation started; only backend boundaries are recorded.`);
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

/** The single automatic retry for provider or network trouble. Returns false when this provider already used it. */
export const recordRetry = internalMutation({
  args: { runId: v.string(), provider: v.union(v.literal("investigator"), v.literal("checker")), error: validators.investigationError }, returns: v.boolean(),
  handler: async (ctx, { runId, provider, error }) => {
    const run = await findRun(ctx, runId);
    if (!ACTIVE.has(run.status)) return false;
    const used = provider === "checker" ? run.checkerRetries ?? 0 : run.providerRetries ?? 0;
    if (used >= MAX_AUTOMATIC_RETRIES) return false;
    await ctx.db.patch("financeInvestigationRuns", run._id, provider === "checker" ? { checkerRetries: used + 1 } : { providerRetries: used + 1 });
    await stepForRun(ctx, publicRun(run), { kind: "retry", to: provider === "checker" ? "checking" : "investigating", trigger: "provider_error", actor: SYSTEM_ACTOR, error,
      reason: { code: error.code, message: `${provider === "checker" ? "Evidence Checker" : "Trust Intake"}: ${error.message} Retrying once automatically.` } });
    return true;
  },
});

async function failRun(ctx: MutationCtx, run: Doc<"financeInvestigationRuns">, error: InvestigationError, options: { validation?: boolean; trigger?: Trigger } = {}) {
  if (!ACTIVE.has(run.status)) return;
  const failed = { ...publicRun(run), status: "failed" as const, error, updatedAt: Date.now() };
  await ctx.db.patch("financeInvestigationRuns", run._id, { status: failed.status, error, updatedAt: failed.updatedAt });
  const task = await requireTask(ctx, run.taskId);
  if (task.activeRunId === run.runId) await ctx.db.patch("financeTasks", task._id, { status: "investigation_failed", activeRunId: undefined });
  await appendBoundary(ctx, failed, options.validation ? "finance.validation.failed" : "finance.investigation.failed", error.message, { errorCode: error.code, ...(run.externalRunId ? { externalRunId: run.externalRunId } : {}) });
  await stepForRun(ctx, failed, { to: "failed", trigger: options.trigger ?? (error.code === "timeout" ? "timeout" : options.validation ? "validation_failed" : "provider_error"),
    actor: options.validation ? CODE_ACTOR : SYSTEM_ACTOR, error, activeRunId: null, reason: { code: error.code, message: `Failed, needs a person: ${error.message}` } });
  await snapshotStep(ctx, failed, task.accountId ?? null, "failed", options.validation ? CODE_ACTOR : SYSTEM_ACTOR, run.updatedAt, { input: run.providerInput, output: null, message: `${error.code}: ${error.message}`, agent: options.trigger === "checker_failed" ? "evidence_checker" : "intake" });
}

export const recordFailure = internalMutation({
  args: { runId: v.string(), error: validators.investigationError, externalRunId: v.optional(v.string()) }, returns: v.null(),
  handler: async (ctx, args) => {
    let run = await findRun(ctx, args.runId);
    if (args.externalRunId) run = await retainExternalRunId(ctx, run, args.externalRunId);
    await failRun(ctx, run, args.error, { validation: args.error.code === "validation_failed" });
    return null;
  },
});

/** Validates the intake agent's answer. Returns true when the Evidence Checker must run outside this mutation (a paid checker mode). */
export const recordResult = internalMutation({
  // Unknown model data is passed as JSON text; parsing and semantic validation happen before storage.
  args: { runId: v.string(), externalRunId: v.string(), outputJson: v.string(), reportSource: v.optional(validators.reportSource) }, returns: v.boolean(),
  handler: async (ctx, args) => {
    let run = await retainExternalRunId(ctx, await findRun(ctx, args.runId), args.externalRunId);
    if (!ACTIVE.has(run.status)) return false;
    if (Date.now() >= run.deadline) {
      await failRun(ctx, run, timeoutError(run));
      return false;
    }
    const answeredAt = run.updatedAt;
    await ctx.db.patch("financeInvestigationRuns", run._id, { externalRunId: args.externalRunId, status: "validating", updatedAt: Date.now(), ...(args.reportSource ? { reportSource: args.reportSource } : {}) });
    run = await findRun(ctx, args.runId);
    await appendBoundary(ctx, publicRun(run), "finance.provider.result_received", "Provider response received; validating schema, evidence references, and deterministic allocation checks.", { externalRunId: args.externalRunId });
    const agentActor = { ...AGENT, identity: `${AGENT.identity}:${run.mode}` };
    await stepForRun(ctx, publicRun(run), { to: "validating", trigger: "provider_result", actor: agentActor, reason: { code: "ANSWER_RECEIVED", message: "The Trust Intake agent answered; validating it before anything else sees it." } });
    let result: FinanceAgentOutput;
    try {
      if (!run.providerInput) throw new Error("Persisted provider input is missing");
      if (args.outputJson.length > 120_000) throw new Error("Provider output exceeds the bounded result size");
      result = validateFinanceAgentOutput(JSON.parse(args.outputJson) as unknown, run.providerInput);
    } catch (error) {
      const details = error instanceof FinanceOutputValidationError ? error.details : [{ path: "$", reason: "Result must be valid JSON within the supported size and have a saved provider context." }];
      await failRun(ctx, run, { code: "validation_failed", message: "Provider result failed validation. No proposal was accepted.", retryable: false, details }, { validation: true });
      return false;
    }
    const resultChecks = runDeterministicChecks(run.providerInput!.records, run.scope, result.proposedAllocations);
    await ctx.db.patch("financeInvestigationRuns", run._id, { status: "checking", result, resultChecks, updatedAt: Date.now() });
    run = await findRun(ctx, args.runId);
    await stepForRun(ctx, publicRun(run), { to: "checking", trigger: "validated", actor: CODE_ACTOR, reason: { code: "VALIDATED", message: "Schema, citations and financial checks passed. The Evidence Checker runs next." } });
    const task = await requireTask(ctx, run.taskId);
    await snapshotStep(ctx, publicRun(run), task.accountId ?? null, "output_validated", agentActor, answeredAt, { input: run.providerInput, output: result, message: `${result.outcome}: ${result.summary.slice(0, 200)}` });
    // The Evidence Checker runs before anything reaches a person. The mock needs no I/O, so it runs here through the same provider interface.
    if ((run.checkerMode ?? "mock") !== "mock") return true;
    const input = checkerInputFor(run);
    const execution = await mockClaimCheckerProvider.start(input);
    if (execution.status !== "completed") throw new Error("The mock checker always completes");
    await settleCheck(ctx, run, JSON.stringify(execution.output));
    return false;
  },
});

function checkerInputFor(run: Doc<"financeInvestigationRuns">) {
  return buildCheckerInput(run.runId, run.providerInput!, codeCheckClaims(run.result!, run.providerInput!));
}

/** What the paid Evidence Checker action sends. Null when the run isn't waiting on the checker. */
export const getCheckerJob = internalQuery({
  args: { runId: v.string() },
  returns: v.union(v.null(), v.object({ checkerInputJson: v.string(), claims: v.number(), appId: v.union(v.string(), v.null()), externalRunId: v.union(v.string(), v.null()), deadline: v.number(), mode: orch.agentMode })),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.query("financeInvestigationRuns").withIndex("by_runId", (q) => q.eq("runId", runId)).unique();
    if (!run || run.status !== "checking" || !run.result || !run.providerInput || (run.checkerMode ?? "mock") === "mock") return null;
    const input = checkerInputFor(run);
    return { checkerInputJson: JSON.stringify(input), claims: input.claims.length, appId: run.checkerAppId ?? null, externalRunId: run.checkerExternalRunId ?? null, deadline: run.deadline, mode: run.checkerMode ?? "mock" };
  },
});

export const recordCheckerPending = internalMutation({
  args: { runId: v.string(), externalRunId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId, externalRunId }) => {
    const run = await findRun(ctx, runId);
    if (run.checkerExternalRunId && run.checkerExternalRunId !== externalRunId) throw new Error("Checker run ID cannot change");
    if (run.status !== "checking") return null;
    if (Date.now() >= run.deadline) { await failRun(ctx, run, timeoutError(run)); return null; }
    await ctx.db.patch("financeInvestigationRuns", run._id, { checkerExternalRunId: externalRunId, checkerPollCount: (run.checkerPollCount ?? 0) + 1, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(3000, internal.financeInvestigationActions.pollChecker, { runId });
    return null;
  },
});

export const recordCheck = internalMutation({
  args: { runId: v.string(), outputJson: v.string(), externalRunId: v.optional(v.string()) }, returns: v.null(),
  handler: async (ctx, args) => {
    const run = await findRun(ctx, args.runId);
    if (run.status !== "checking") return null;
    if (args.externalRunId && !run.checkerExternalRunId) await ctx.db.patch("financeInvestigationRuns", run._id, { checkerExternalRunId: args.externalRunId });
    if (Date.now() >= run.deadline) { await failRun(ctx, run, timeoutError(run)); return null; }
    await settleCheck(ctx, run, args.outputJson);
    return null;
  },
});

export const recordCheckFailure = internalMutation({
  args: { runId: v.string(), error: validators.investigationError }, returns: v.null(),
  handler: async (ctx, { runId, error }) => {
    const run = await findRun(ctx, runId);
    if (run.status === "checking") await failRun(ctx, run, { ...error, message: `Evidence Checker: ${error.message} Nothing was sent for approval.` }, { trigger: "checker_failed" });
    return null;
  },
});

/** Validates the checker's answer (never repaired), stores verdicts, and settles the run and its orchestrator. */
async function settleCheck(ctx: MutationCtx, run: Doc<"financeInvestigationRuns">, outputJson: string) {
  const input = checkerInputFor(run);
  const code = codeCheckClaims(run.result!, run.providerInput!);
  const checkStartedAt = run.updatedAt;
  let claimCheck;
  try {
    if (outputJson.length > 120_000) throw new Error("Checker output exceeds the bounded size");
    claimCheck = finalizeClaimCheck(code, validateCheckerOutput(JSON.parse(outputJson) as unknown, input), run.checkerMode ?? "mock", Date.now());
  } catch (error) {
    const details = error instanceof CheckerOutputValidationError ? error.details : [{ path: "$", reason: "Checker output must be one raw JSON object within the supported size." }];
    await failRun(ctx, run, { code: "checker_validation_failed", message: "The checker's answer failed validation, so no claim counts as checked. Nothing was sent for approval.", retryable: false, details }, { trigger: "checker_failed" });
    return;
  }
  const result = run.result!;
  const rejected = claimCheck.status === "rejected";
  const status = rejected ? "checker_rejected" : result.outcome === "needs_information" ? "needs_information" : result.outcome === "proposal_ready" ? "review_required" : "completed";
  const completed: FinanceInvestigationRun = { ...publicRun(run), status, claimCheck, updatedAt: Date.now() };
  await ctx.db.patch("financeInvestigationRuns", run._id, { status, claimCheck, updatedAt: completed.updatedAt });
  const task = await requireTask(ctx, run.taskId);
  if (task.activeRunId === run.runId) await ctx.db.patch("financeTasks", task._id, { status: status === "completed" ? "investigation_completed" : status, activeRunId: undefined });
  const counts = (v: string) => claimCheck.claims.filter(c => c.verdict === v).length;
  const tally = `${counts("supported")} supported, ${counts("not_supported")} not supported, ${counts("not_checkable")} not checkable`;
  const externalRunId = run.externalRunId ?? undefined;
  const checkerActor: OrchestratorActor = { type: "agent", identity: `agent:evidence-checker:${claimCheck.agentMode}` };
  await snapshotStep(ctx, completed, task.accountId ?? null, "claims_checked", checkerActor, checkStartedAt, { input, output: claimCheck, checkerVerdicts: claimCheck.claims, message: `Evidence Checker (${claimCheck.agentMode}): ${tally}.`, agent: "evidence_checker" });
  const depositPending = result.outcome === "findings" && !!task.bankSourceId && run.providerInput!.records.transactions.length === 0
    && !!run.providerInput!.records.bankTransactions?.some(t => t.sourceId === task.bankSourceId && t.clearing === "pending");
  // Every correction and checker rejection is saved as an eval case for evaluateInstructions.
  const evalCases = [evalCaseFromRejection(completed, Date.now())];
  const correction = run.parentRunId ? await ctx.db.query("financeRunCorrections").withIndex("by_newRunId", q => q.eq("newRunId", run.runId)).unique() : null;
  if (correction && run.parentRunId) {
    const parent = await ctx.db.query("financeInvestigationRuns").withIndex("by_runId", q => q.eq("runId", run.parentRunId!)).unique();
    if (parent) evalCases.push(evalCaseFromCorrection(publicRun(parent), completed, correction.kind, Date.now()));
  }
  for (const evalCase of evalCases) {
    if (evalCase && !(await ctx.db.query("financeEvalCases").withIndex("by_evalCaseId", q => q.eq("evalCaseId", evalCase.evalCaseId)).unique())) await ctx.db.insert("financeEvalCases", evalCase);
  }
  if (rejected) {
    const first = claimCheck.claims.find(c => c.verdict === "not_supported")!;
    await appendBoundary(ctx, completed, "finance.checker.rejected", `Checker stopped this run (${tally}): "${first.claim}" ${first.reason}`, { errorCode: "checker_rejected" });
    await appendBoundary(ctx, completed, "finance.investigation.completed", "Stopped by the Evidence Checker. Nothing was sent for approval and no money moved.", { ...(externalRunId ? { externalRunId } : {}) });
    const settled = settledState({ checkerRejected: true, outcome: result.outcome, depositPending, lockBlocked: false });
    await stepForRun(ctx, completed, { to: settled.state, trigger: "checker_result", actor: first.checkedBy === "agent" ? checkerActor : CODE_ACTOR, activeRunId: null, reason: { code: settled.reason.code, message: `${settled.reason.message} "${first.claim}" ${first.reason}` } });
    return;
  }
  await appendBoundary(ctx, completed, "finance.checker.completed", `Checker passed every claim it could judge (${tally}).`);
  for (const item of result.questions) {
    const questionId = `${run.runId}:question:${item.key}`;
    await ctx.db.insert("financeInvestigationQuestions", { caseId: run.caseId, taskId: run.taskId, runId: run.runId, questionId, ...item, status: "open", clarificationId: null });
    await appendBoundary(ctx, completed, "finance.question.raised", item.question, { questionId });
  }
  await appendBoundary(ctx, completed, "finance.investigation.completed", result.summary, { ...(externalRunId ? { externalRunId } : {}) });
  const lockStartedAt = Date.now();
  const queued = task.accountId && result.outcome === "proposal_ready" ? await queueAgentAllocations(ctx, task.accountId, completed, result) : [];
  if (queued.length) await snapshotStep(ctx, completed, task.accountId ?? null, "lock_evaluated", CODE_ACTOR, lockStartedAt, { input: result.proposedAllocations, output: queued.map(q => ({ proposalId: q.proposalId, status: q.status })), lockResults: queued.map(q => q.lock), message: `Lock at request: ${queued.map(q => `${q.proposalId} ${q.status}`).join(", ")}.` });
  const settled = settledState({ checkerRejected: false, outcome: result.outcome, depositPending, lockBlocked: queued.some(q => q.status === "blocked") });
  await stepForRun(ctx, completed, { to: settled.state, trigger: "checker_result", actor: checkerActor, activeRunId: null, reason: { code: settled.reason.code, message: `${settled.reason.message} Checker: ${tally}.` } });
  // Clearing may race the pending mock review. Recheck after saving it so the cleared review isn't lost.
  if (run.mode === "mock" && status === "completed" && task.accountId && task.bankSourceId && depositPending) {
    const bank = await ctx.db.query("financeBankTransactions").withIndex("by_sourceId", q => q.eq("sourceId", task.bankSourceId!)).unique();
    if (bank?.clearing === "cleared") await ctx.scheduler.runAfter(0, internal.financeIntake.autoInvestigateDeposit, { accountId: task.accountId, bankSourceId: task.bankSourceId });
  }
}

/** Validated agent allocations enter the approval queue through the same lock rules as a person's. Never auto-posted. */
async function queueAgentAllocations(ctx: MutationCtx, accountId: string, run: FinanceInvestigationRun, result: FinanceAgentOutput): Promise<Array<{ proposalId: string; status: string; lock: LockResult }>> {
  const byDeposit = new Map<string, FinanceAgentOutput["proposedAllocations"]>();
  for (const row of result.proposedAllocations) byDeposit.set(row.transactionId, [...(byDeposit.get(row.transactionId) ?? []), row]);
  const actor = { identity: `agent:trust-intake:${run.runId}`, authenticated: false, role: "system" as const };
  const out: Array<{ proposalId: string; status: string; lock: LockResult }> = [];
  for (const [bankSourceId, rows] of byDeposit) {
    const now = Date.now();
    const { proposal, lock } = await submitProposal(ctx, {
      proposalId: await nextProposalId(ctx, accountId, "allocation"), accountId, kind: "allocation", status: "proposed", currency: rows[0].currency,
      requestedBy: actor.identity, origin: { type: "agent", taskId: run.taskId, runId: run.runId, agentProposalIds: rows.map(r => r.proposalId) },
      evidenceSourceIds: [...new Set(rows.flatMap(r => r.evidenceSourceIds))], bankSourceId, shares: rows.map(r => ({ ownerId: r.ownerId, amountCents: r.amountCents })),
      amountCents: rows.reduce((sum, r) => sum + r.amountCents, 0), purpose: `Agent proposal from ${run.runId} (unapproved)`, createdAt: now, updatedAt: now,
    }, actor);
    out.push({ proposalId: proposal.proposalId, status: proposal.status, lock });
  }
  return out;
}

export const expireRun = internalMutation({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await findRun(ctx, runId);
    if (Date.now() >= run.deadline) await failRun(ctx, run, timeoutError(run));
    return null;
  },
});
