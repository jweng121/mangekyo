import { ConvexError, v } from "convex/values";
import { FinanceProviderError } from "@mangekyo/finance-core/agent";
import { buildReconciliationInput, causeKey, checkReconciliationFindings, correctionEntries, evaluateCorrection, mockReconciliationProvider, reconcilableCauses, ReconciliationValidationError, validateReconciliationOutput, type CorrectingEntry, type ReconciliationInput } from "@mangekyo/finance-core/reconciliation";
import { callWithRetry, MAX_AUTOMATIC_RETRIES, parseProviderTimeoutMs } from "@mangekyo/finance-core/orchestrator";
import { formatCents } from "@mangekyo/finance-core/intake";
import { internal } from "./_generated/api";
import { env, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { providerMode } from "./financeInvestigations";
import { appendMoneyEvent, checkAccount, compact, knownSourceIds, loadAccount, recheckHeldProposals, resolveActor, type LoadedAccount } from "./lib/money";
import * as money from "./lib/moneyValidators";
import * as orch from "./lib/orchestratorValidators";
import { recordOnly } from "./lib/investigationRecords";
import { CODE_ACTOR, ensureOrchestration, findOrchestration, step, SYSTEM_ACTOR } from "./lib/orchestrator";
import { investigationError } from "./lib/validators";

/**
 * Reconciliation mode. When the three-way check fails, one orchestrator per code-found cause runs the mismatch agent:
 * it explains the cause and proposes one correcting entry. A person approves it, and the correction lock runs again.
 */

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const AGENT = { type: "agent" as const, identity: "agent:reconciler:mock" };
const reconTaskId = (accountId: string, key: string) => `recon:${accountId}:${key}`;

async function findRun(ctx: MutationCtx, runId: string) {
  const run = await ctx.db.query("financeReconciliationRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique();
  if (!run) throw new Error("Reconciliation run not found");
  return run;
}

/** The person who recorded a bank item (for a simulated return, the requester). They can't also approve its entry. */
async function recordedBy(ctx: MutationCtx, accountId: string, bankSourceId: string | null): Promise<string | null> {
  if (!bankSourceId) return null;
  const events = await ctx.db.query("financeEvents").withIndex("by_taskId_and_sequence", q => q.eq("taskId", `money:${accountId}`)).order("desc").take(2000);
  const recorded = events.find(e => e.type === "finance.money.bank_item_recorded" && e.runId === bankSourceId);
  return recorded && recorded.actor.type === "human" ? recorded.actor.identity : null;
}

function lockFor(ctx: MutationCtx, loaded: LoadedAccount, known: Set<string>, entry: CorrectingEntry, key: string, extra: { status: string; requestedBy: string; approver?: string; recordedBy?: string | null }) {
  return evaluateCorrection({ state: loaded.state, known, entry, causeKey: key, now: Date.now(), recheck: state => checkAccount(state, Date.now()), ...extra });
}

/** Scheduled after anything that can change the books. Starts one mismatch investigation per new code-found cause. Mock only for now. */
export const autoStart = internalMutation({
  args: { accountId: v.string() }, returns: v.null(),
  handler: async (ctx, { accountId }) => {
    if (providerMode() !== "mock") return null;
    const loaded = await loadAccount(ctx, accountId);
    const threeWay = checkAccount(loaded.state, Date.now());
    if (threeWay.status !== "mismatched") return null;
    for (const cause of reconcilableCauses(threeWay)) {
      const key = causeKey(cause);
      const taskId = reconTaskId(accountId, key);
      if (await findOrchestration(ctx, taskId)) continue;
      let orchestration = await ensureOrchestration(ctx, { kind: "reconciliation", taskId, accountId, subjectSourceId: cause.sourceIds[0] ?? null, trigger: "mismatch_found", actor: CODE_ACTOR,
        reason: { code: cause.code, message: `Three-way check failed: ${cause.message}` } });
      const runId = `${taskId}:run:1`;
      const input = buildReconciliationInput({ runId, state: loaded.state, threeWay, cause, documents: loaded.documents });
      const now = Date.now();
      await ctx.db.insert("financeReconciliationRuns", { runId, orchestrationId: orchestration.orchestrationId, accountId, causeKey: key, attempt: 1, mode: "mock", status: "investigating", input, output: null, findingChecks: [], dryRun: null, error: null, externalRunId: null, retries: 0, createdAt: now, updatedAt: now });
      orchestration = await step(ctx, orchestration, { kind: "budget_check", to: "received", trigger: "mismatch_found", actor: CODE_ACTOR, reason: { code: "BUDGET_NOT_APPLICABLE", message: "The mismatch agent is mock-only for now; mock runs don't count against the real-run budget." } });
      await step(ctx, orchestration, { to: "investigating", trigger: "mismatch_found", actor: SYSTEM_ACTOR, runId, activeRunId: runId, reason: { code: "MISMATCH_INVESTIGATION", message: `Mismatch agent started on ${cause.code} with the code-found cause and the ${input.records.bankTransactions.length + input.records.ledgerEntries.length} record(s) it involves.` } });
      await ctx.scheduler.runAfter(0, internal.financeReconciliation.execute, { runId });
    }
    return null;
  },
});

export const getRun = internalQuery({
  args: { runId: v.string() }, returns: v.union(orch.reconciliationRun, v.null()),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.query("financeReconciliationRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique();
    return run ? recordOnly(run) : null;
  },
});

export const recordRetry = internalMutation({
  args: { runId: v.string(), error: investigationError }, returns: v.boolean(),
  handler: async (ctx, { runId, error }) => {
    const run = await findRun(ctx, runId);
    if (run.status !== "investigating" || run.retries >= MAX_AUTOMATIC_RETRIES) return false;
    await ctx.db.patch("financeReconciliationRuns", run._id, { retries: run.retries + 1 });
    const orchestration = await findOrchestration(ctx, run.orchestrationId.replace(/:orchestrator$/, ""));
    if (orchestration) await step(ctx, orchestration, { kind: "retry", to: "investigating", trigger: "provider_error", actor: SYSTEM_ACTOR, runId, error, reason: { code: error.code, message: `${error.message} Retrying once automatically.` } });
    return true;
  },
});

/** Mock reconciler behind the provider interface, with the same timeout and single retry as the investigator. */
export const execute = internalAction({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const run = await ctx.runQuery(internal.financeReconciliation.getRun, { runId });
    if (!run || run.status !== "investigating") return null;
    const timeoutMs = parseProviderTimeoutMs(env.PROVIDER_TIMEOUT_MS);
    try {
      const execution = await callWithRetry(() => mockReconciliationProvider.start(run.input as ReconciliationInput), { timeoutMs, phase: "start", paid: false,
        onRetry: async error => await ctx.runMutation(internal.financeReconciliation.recordRetry, { runId, error: { code: error.code, message: error.message, retryable: error.retryable } }) });
      if (execution.status !== "completed") throw new FinanceProviderError("provider_failed", "The reconciler did not complete.");
      await ctx.runMutation(internal.financeReconciliation.recordResult, { runId, externalRunId: execution.externalRunId, outputJson: JSON.stringify(execution.output) });
    } catch (error) {
      const failure = error instanceof FinanceProviderError ? { code: error.code, message: error.message, retryable: error.retryable } : { code: "provider_failure", message: "The reconciler failed unexpectedly.", retryable: false };
      await ctx.runMutation(internal.financeReconciliation.recordFailure, { runId, error: failure });
    }
    return null;
  },
});

async function fail(ctx: MutationCtx, run: Doc<"financeReconciliationRuns">, error: { code: string; message: string; retryable: boolean; details?: Array<{ path: string; reason: string }> }, trigger: string) {
  if (run.status !== "investigating" && run.status !== "validating" && run.status !== "checking") return;
  await ctx.db.patch("financeReconciliationRuns", run._id, { status: "failed", error, updatedAt: Date.now() });
  const orchestration = await findOrchestration(ctx, run.orchestrationId.replace(/:orchestrator$/, ""));
  if (orchestration) await step(ctx, orchestration, { to: "failed", trigger, actor: trigger === "validation_failed" ? CODE_ACTOR : SYSTEM_ACTOR, runId: run.runId, activeRunId: null, error, reason: { code: error.code, message: `Failed, needs a person: ${error.message}` } });
}

export const recordFailure = internalMutation({
  args: { runId: v.string(), error: investigationError }, returns: v.null(),
  handler: async (ctx, { runId, error }) => { await fail(ctx, await findRun(ctx, runId), error, error.code === "provider_timeout" ? "timeout" : "provider_error"); return null; },
});

/** investigating → validating → checking → needs_person (a correction for a person) | rejected (code refused it) | failed. */
export const recordResult = internalMutation({
  args: { runId: v.string(), externalRunId: v.string(), outputJson: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const run = await findRun(ctx, args.runId);
    if (run.status !== "investigating") return null;
    if (Date.now() >= run.createdAt + RUN_TIMEOUT_MS) { await fail(ctx, run, { code: "timeout", message: "The mismatch investigation timed out.", retryable: false }, "timeout"); return null; }
    const orchestrationTask = run.orchestrationId.replace(/:orchestrator$/, "");
    let orchestration = (await findOrchestration(ctx, orchestrationTask))!;
    await ctx.db.patch("financeReconciliationRuns", run._id, { status: "validating", externalRunId: args.externalRunId, updatedAt: Date.now() });
    orchestration = await step(ctx, orchestration, { to: "validating", trigger: "provider_result", actor: AGENT, runId: run.runId, reason: { code: "ANSWER_RECEIVED", message: "The mismatch agent answered; validating it." } });
    const input = run.input as ReconciliationInput;
    let output;
    try {
      if (args.outputJson.length > 60_000) throw new Error("too large");
      output = validateReconciliationOutput(JSON.parse(args.outputJson) as unknown, input);
    } catch (error) {
      const details = error instanceof ReconciliationValidationError ? error.details : [{ path: "$", reason: "Output must be one raw JSON object within the supported size." }];
      await fail(ctx, { ...run, status: "validating" }, { code: "validation_failed", message: "The mismatch agent's answer failed validation. No correction was proposed.", retryable: false, details }, "validation_failed");
      return null;
    }
    await ctx.db.patch("financeReconciliationRuns", run._id, { status: "checking", output, updatedAt: Date.now() });
    orchestration = await step(ctx, orchestration, { to: "checking", trigger: "validated", actor: CODE_ACTOR, runId: run.runId, reason: { code: "VALIDATED", message: "Valid answer. Code checks its claims and dry-runs the correcting entry." } });
    const findingChecks = checkReconciliationFindings(output, input);
    const loaded = await loadAccount(ctx, run.accountId);
    const known = await knownSourceIds(ctx, loaded);
    for (const e of loaded.state.entries) known.add(e.entryId);
    const dryRun = output.proposedEntry ? lockFor(ctx, loaded, known, output.proposedEntry, run.causeKey, { status: "proposed", requestedBy: AGENT.identity }) : null;
    const unsupported = findingChecks.find(f => !f.supported);
    const now = Date.now();
    if (unsupported || (dryRun && !dryRun.allowed)) {
      await ctx.db.patch("financeReconciliationRuns", run._id, { status: "rejected", findingChecks, dryRun, updatedAt: now });
      const why = unsupported ? `A claim's cited records don't contain: ${unsupported.missing.join(", ")}.` : `The correcting entry fails the lock: ${dryRun!.failures.map(f => `${f.rule} ${f.message}`).join(" ")}`;
      await step(ctx, orchestration, { to: "rejected", trigger: "checker_result", actor: CODE_ACTOR, runId: run.runId, activeRunId: null, reason: { code: unsupported ? "CHECKER_REJECTED" : "CORRECTION_REFUSED", message: `${why} Nothing was proposed to a person.` } });
      return null;
    }
    await ctx.db.patch("financeReconciliationRuns", run._id, { status: "needs_person", findingChecks, dryRun, updatedAt: now });
    if (output.proposedEntry) {
      const correctionId = `${run.runId}:correction`;
      await ctx.db.insert("financeCorrections", { correctionId, accountId: run.accountId, runId: run.runId, orchestrationId: run.orchestrationId, causeKey: run.causeKey, entry: output.proposedEntry,
        explanation: output.explanation, status: "proposed", requestedBy: AGENT.identity, createdAt: now, updatedAt: now });
      await step(ctx, orchestration, { to: "needs_person", trigger: "checker_result", actor: CODE_ACTOR, runId: run.runId, activeRunId: null,
        reason: { code: "CORRECTION_PROPOSED", message: `Proposed a ${formatCents(output.proposedEntry.amountCents)} correcting entry. Its claims check out and the dry run clears the mismatch; a person approves it through the lock.` } });
    } else {
      await step(ctx, orchestration, { to: "needs_person", trigger: "checker_result", actor: CODE_ACTOR, runId: run.runId, activeRunId: null, reason: { code: "QUESTION_ASKED", message: `No safe correcting entry: ${output.questions.map(q => q.question).join(" ")}` } });
    }
    return null;
  },
});

async function getCorrection(ctx: MutationCtx, correctionId: string) {
  const row = await ctx.db.query("financeCorrections").withIndex("by_correctionId", q => q.eq("correctionId", correctionId)).unique();
  if (!row) throw new ConvexError("Unknown correction.");
  return row;
}

const lockResult = v.object({ allowed: v.boolean(), failures: v.array(v.object({ rule: v.string(), code: v.string(), message: v.string(), sourceIds: v.array(v.string()) })), entryIds: v.array(v.string()) });

/** Approver only. Re-runs the correction lock with who is acting, then appends the entry. A refusal is recorded and changes nothing. */
export const approveCorrection = mutation({
  args: { correctionId: v.string(), dev: money.devIdentity }, returns: lockResult,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (actor.role !== "approver") throw new ConvexError("Switch to the approver role to approve a correcting entry.");
    const correction = await getCorrection(ctx, args.correctionId);
    const loaded = await loadAccount(ctx, correction.accountId);
    const known = await knownSourceIds(ctx, loaded);
    for (const e of loaded.state.entries) known.add(e.entryId);
    const lock = lockFor(ctx, loaded, known, correction.entry, correction.causeKey, { status: correction.status, requestedBy: correction.requestedBy, approver: actor.identity, recordedBy: await recordedBy(ctx, correction.accountId, correction.entry.bankSourceId) });
    const orchestration = await findOrchestration(ctx, correction.orchestrationId.replace(/:orchestrator$/, ""));
    if (!lock.allowed) {
      await appendMoneyEvent(ctx, { accountId: correction.accountId, type: "finance.money.lock_checked", actor, operationId: correction.correctionId, stage: "correction",
        message: `Correction refused: ${lock.failures.map(f => `${f.rule} ${f.code}: ${f.message}`).join(" | ")}`, sourceIds: correction.entry.evidenceSourceIds });
      await ctx.db.patch("financeCorrections", correction._id, { lock, updatedAt: Date.now() });
      return { allowed: false, failures: lock.failures, entryIds: [] };
    }
    const now = Date.now();
    const entries = correctionEntries(correction.entry, loaded.state, correction.correctionId, actor.identity, now, `${correction.correctionId}:approval`);
    for (const entry of entries) {
      if (await ctx.db.query("financeLedgerEntries").withIndex("by_entryId", q => q.eq("entryId", entry.entryId)).unique()) throw new Error(`Ledger entry ${entry.entryId} already exists; refusing to post twice.`);
      await ctx.db.insert("financeLedgerEntries", compact(entry));
    }
    const entryIds = entries.map(e => e.entryId);
    await ctx.db.patch("financeCorrections", correction._id, { status: "posted", decidedBy: actor.identity, lock, entryIds, updatedAt: now });
    const after = await loadAccount(ctx, correction.accountId);
    await appendMoneyEvent(ctx, { accountId: correction.accountId, type: "finance.money.ledger_posted", actor, operationId: correction.correctionId, stage: "correction",
      message: `${actor.identity} approved the mismatch agent's correcting entry (${formatCents(correction.entry.amountCents)}): ${correction.entry.memo}. Every correction lock rule passed.`, threeWay: checkAccount(after.state, now), entryIds, sourceIds: correction.entry.evidenceSourceIds });
    if (orchestration) await step(ctx, orchestration, { to: "needs_person", trigger: "person_approved_correction", actor: { type: "person", identity: actor.identity }, runId: correction.runId,
      reason: { code: "CORRECTION_POSTED", message: `${actor.identity} approved the correcting entry; the lock passed and it was posted.` } });
    await recheckHeldProposals(ctx, correction.accountId);
    return { allowed: true, failures: [], entryIds };
  },
});

export const rejectCorrection = mutation({
  args: { correctionId: v.string(), reason: v.string(), dev: money.devIdentity }, returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (actor.role !== "approver") throw new ConvexError("Switch to the approver role to reject a correcting entry.");
    const reason = args.reason.trim();
    if (!reason || reason.length > 4000) throw new ConvexError("A rejection reason (1–4000 characters) is required.");
    const correction = await getCorrection(ctx, args.correctionId);
    if (correction.status !== "proposed") throw new ConvexError(`This correction is already ${correction.status}.`);
    await ctx.db.patch("financeCorrections", correction._id, { status: "rejected", decidedBy: actor.identity, rejectionReason: reason, updatedAt: Date.now() });
    const orchestration = await findOrchestration(ctx, correction.orchestrationId.replace(/:orchestrator$/, ""));
    if (orchestration) await step(ctx, orchestration, { to: "needs_person", trigger: "person_rejected_correction", actor: { type: "person", identity: actor.identity }, runId: correction.runId, reason: { code: "CORRECTION_REJECTED", message: `${actor.identity} rejected the correcting entry: ${reason}` } });
    return null;
  },
});

const correctionRow = orch.correction.extend({ stillMismatched: v.boolean() });

/** Proposed corrections for the desk, with whether their cause is still in the three-way check. */
export const listCorrections = query({
  args: { accountId: v.string() }, returns: v.array(correctionRow),
  handler: async (ctx, { accountId }) => {
    const rows = await ctx.db.query("financeCorrections").withIndex("by_accountId", q => q.eq("accountId", accountId)).order("desc").take(50);
    if (rows.length === 0) return [];
    const loaded = await loadAccount(ctx, accountId);
    const at = Math.max(loaded.state.account.openingAsOf, ...loaded.state.entries.map(e => e.createdAt), ...loaded.state.bankTransactions.map(t => t.bookedAt));
    const live = new Set(checkAccount(loaded.state, Number.MAX_SAFE_INTEGER, at).causes.filter(c => c.severity === "mismatch").map(causeKey));
    return rows.map(r => ({ ...recordOnly(r), stillMismatched: live.has(r.causeKey) }));
  },
});

/** One mismatch run for its inspector page, with its orchestrator timeline. */
export const getRunView = query({
  args: { runId: v.string() },
  returns: v.union(v.null(), v.object({ run: orch.reconciliationRun, correction: v.union(orch.correction, v.null()), events: v.array(orch.event.extend({ snapshotId: v.union(v.string(), v.null()) })), state: v.union(orch.state, v.null()) })),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.query("financeReconciliationRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique();
    if (!run) return null;
    const correction = await ctx.db.query("financeCorrections").withIndex("by_correctionId", q => q.eq("correctionId", `${runId}:correction`)).unique();
    const events = await ctx.db.query("financeOrchestratorEvents").withIndex("by_orchestrationId_and_sequence", q => q.eq("orchestrationId", run.orchestrationId)).take(200);
    const snapshots = await ctx.db.query("financeOrchestratorSnapshots").withIndex("by_orchestrationId_and_sequence", q => q.eq("orchestrationId", run.orchestrationId)).take(200);
    const orchestration = await ctx.db.query("financeOrchestrations").withIndex("by_orchestrationId", q => q.eq("orchestrationId", run.orchestrationId)).unique();
    return { run: recordOnly(run), correction: correction ? recordOnly(correction) : null, state: orchestration?.state ?? null,
      events: events.map(e => ({ ...recordOnly(e), snapshotId: snapshots.find(s => s.eventId === e.eventId)?.snapshotId ?? null })) };
  },
});
