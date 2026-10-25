import { ConvexError, v } from "convex/values";
import type { LockResult, MoneyProposal } from "@mangekyo/contracts";
import type { AgentRunProvenance, OrchestratorActor } from "@mangekyo/contracts/orchestration";
import { FinanceProviderError } from "@mangekyo/finance-core/agent";
import { createAgentProvider } from "@mangekyo/finance-core/agents";
import { buildCheckerInput, CheckerOutputValidationError, finalizeClaimCheck, mockCheckerOutput, validateCheckerOutput, type CheckerInput } from "@mangekyo/finance-core/checker";
import { buildDisbursementInput, codeCheckPayoutLines, disbursementClaims, DISBURSEMENT_REPORT_FIELDS, DisbursementValidationError, matterForDeposit, mockDisbursementProvider, validateDisbursementOutput, type DisbursementInput, type DisbursementOutput } from "@mangekyo/finance-core/disbursement";
import { formatCents } from "@mangekyo/finance-core/intake";
import { activeAllocations } from "@mangekyo/finance-core/ledger";
import { callWithRetry, MAX_AUTOMATIC_RETRIES, parseProviderTimeoutMs, retryWriteConflicts, settledState } from "@mangekyo/finance-core/orchestrator";
import { internal } from "./_generated/api";
import { env, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { accountClarifications, captureStep, configFor, provenanceFor } from "./lib/agents";
import { recordOnly } from "./lib/investigationRecords";
import { appendMoneyEvent, checkAccount, loadAccount, nextProposalId, recheckHeldProposals, resolveActor, submitProposal, type LoadedAccount } from "./lib/money";
import * as money from "./lib/moneyValidators";
import * as orch from "./lib/orchestratorValidators";
import { checkBudget, CODE_ACTOR, ensureOrchestration, findOrchestration, step, SYSTEM_ACTOR, type Orchestration } from "./lib/orchestrator";
import { investigationError } from "./lib/validators";
import { providerMode } from "./financeInvestigations";

/**
 * Disbursement agent and trust disputes.
 * Given a matter's signed settlement statement, fee agreement and approved invoices, the agent proposes payout lines. Each line is
 * checked by code and the Evidence Checker, then queued as a payment proposal through the lock; a person approves and posts each one.
 */

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const ACTIVE = new Set(["investigating", "validating", "checking"]);
export const disbursementTaskId = (accountId: string, matterId: string) => `disb:${accountId}:${matterId}`;
const agentActor = (p: AgentRunProvenance): OrchestratorActor => ({ type: "agent", identity: `agent:disbursement:${p.mode}` });
const startResult = v.object({ runId: v.string(), created: v.boolean(), refused: v.optional(v.object({ code: v.string(), message: v.string() })) });

async function findRun(ctx: MutationCtx, runId: string) {
  const run = await ctx.db.query("financeDisbursementRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique();
  if (!run) throw new Error("Disbursement run not found");
  return run;
}

/** The deposit's matter (from its signed settlement statement) and the client: the owner the deposit is allocated to, else the one the statement names. */
export function matterOf(loaded: LoadedAccount, bankSourceId: string) {
  const deposit = loaded.state.bankTransactions.find(t => t.sourceId === bankSourceId);
  if (!deposit) throw new ConvexError("Unknown deposit for this account.");
  const matter = matterForDeposit(deposit, loaded.documents);
  if (!matter) throw new ConvexError("This deposit has no signed settlement statement; the Disbursement agent only works from one.");
  const allocated = activeAllocations(loaded.state.entries, deposit.sourceId).map(e => e.ownerId!);
  const named = loaded.state.owners.filter(o => matter.statement.namedOwnerSourceIds.includes(o.sourceId) && o.ownerKind !== "firm").map(o => o.ownerId);
  const clientOwnerId = allocated[0] ?? named[0];
  if (!clientOwnerId) throw new ConvexError("The signed settlement statement names no client in our records.");
  return { deposit, matter, clientOwnerId };
}

/** One orchestrator per matter payout. A second start while a run is active returns it; a settled one gets a new linked attempt. */
async function makeAttempt(ctx: MutationCtx, loaded: LoadedAccount, bankSourceId: string, cause: { trigger: string; actor: OrchestratorActor }): Promise<{ runId: string; created: boolean; refused?: { code: string; message: string } }> {
  const accountId = loaded.state.account.accountId;
  const { deposit, matter, clientOwnerId } = matterOf(loaded, bankSourceId);
  const taskId = disbursementTaskId(accountId, matter.matterId);
  const config = configFor("disbursement");
  if (!config.mode) throw new ConvexError(config.message);
  const checker = configFor("evidence_checker");
  if (!checker.mode) throw new ConvexError(checker.message);
  const latest = await ctx.db.query("financeDisbursementRuns").withIndex("by_taskId_and_attempt", q => q.eq("taskId", taskId)).order("desc").first();
  if (latest && ACTIVE.has(latest.status)) return { runId: latest.runId, created: false };
  const now = Date.now();
  let orchestration = await ensureOrchestration(ctx, { kind: "disbursement", taskId, accountId, subjectSourceId: matter.statement.sourceId, trigger: cause.trigger, actor: cause.actor, reason: { code: "RECEIVED", message: `Matter ${matter.matterId} received for disbursement.` } });
  if (orchestration.state === "investigating" || orchestration.state === "validating" || orchestration.state === "checking") {
    orchestration = await step(ctx, orchestration, { to: "failed", trigger: "timeout", actor: SYSTEM_ACTOR, activeRunId: null, reason: { code: "STALE", message: "The previous run was no longer active; closed before starting a new one." } });
  }
  const needed = config.realRuns + checker.realRuns;
  const budget = await checkBudget(ctx, taskId, needed, now);
  orchestration = await step(ctx, orchestration, { kind: "budget_check", to: orchestration.state, trigger: cause.trigger, actor: CODE_ACTOR, reason: { code: budget.code, message: budget.message }, budget });
  if (!budget.allowed) {
    await step(ctx, orchestration, { to: "needs_person", trigger: "budget_refused", actor: CODE_ACTOR, reason: { code: budget.code, message: budget.message }, budget });
    return { runId: latest?.runId ?? "", created: false, refused: { code: budget.code, message: budget.message } };
  }
  const attempt = (latest?.attempt ?? 0) + 1;
  const runId = `${taskId}:disbursement:${attempt}`;
  const approvedPolicies = (await ctx.db.query("financeApprovedPolicies").withIndex("by_accountId_and_currency_and_approvedAt", q => q.eq("accountId", accountId).eq("currency", loaded.state.account.currency)).take(100)).map(recordOnly);
  const humanClarifications = await accountClarifications(ctx, taskId, accountId, now);
  const input = buildDisbursementInput({ runId, state: loaded.state, documents: loaded.documents, obligations: loaded.obligations, matterId: matter.matterId, clientOwnerId, settlementDeposit: deposit, cutoff: now, approvedPolicies, humanClarifications });
  const provenance = provenanceFor("disbursement");
  await ctx.db.insert("financeDisbursementRuns", { runId, orchestrationId: orchestration.orchestrationId, taskId, accountId, matterId: matter.matterId, clientOwnerId, settlementSourceId: matter.statement.sourceId, attempt, provenance, status: "investigating",
    input, output: null, lineChecks: [], proposalIds: [], error: null, externalRunId: null, retries: 0, deadline: now + RUN_TIMEOUT_MS, createdAt: now, updatedAt: now });
  for (const [provider, c] of [["disbursement", config], ["evidence_checker", checker]] as const) {
    if (c.realRuns) await ctx.db.insert("financeRealRuns", { runId, taskId, accountId, provider, day: new Date(now).toISOString().slice(0, 10), at: now });
  }
  await step(ctx, orchestration, { to: "investigating", trigger: cause.trigger, actor: cause.actor, runId, activeRunId: runId, reason: { code: "ATTEMPT_STARTED", message: `Attempt ${attempt}: Disbursement ${config.mode} (${provenance.model}) reads ${input.documents.length} document(s) and ${input.invoices.length} invoice(s) for ${matter.matterId}.` } });
  const snapshot = await captureStep(ctx, { runId, taskId, accountId, agent: "disbursement", kind: "input_frozen", actor: cause.actor, provenance, startedAt: now, input, message: `Exactly what the Disbursement agent is given for ${matter.matterId}, attempt ${attempt}.` });
  await appendMoneyEvent(ctx, { accountId, type: "finance.money.snapshot_captured", actor: { identity: "system:finance-money", authenticated: false, role: "system" }, operationId: runId, stage: "snapshot", message: `finance.snapshot.captured ${runId} step ${snapshot.stepIndex} (${snapshot.snapshotId}).`, sourceIds: [snapshot.snapshotId, runId] });
  await ctx.scheduler.runAfter(0, internal.financeTrust.execute, { runId });
  return { runId, created: true };
}

/** A person asks the Disbursement agent to prepare the payout for a settlement deposit's matter. */
export const startDisbursement = mutation({
  args: { accountId: v.string(), bankSourceId: v.string(), dev: money.devIdentity }, returns: startResult,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    const loaded = await loadAccount(ctx, args.accountId);
    return await makeAttempt(ctx, loaded, args.bankSourceId, { trigger: "person_started", actor: { type: "person", identity: actor.identity } });
  },
});

/** Scheduled when an allocation of a settlement deposit posts (or by the demo feed). Mock mode only: a paid mode waits for a person. */
export const autoStartDisbursement = internalMutation({
  args: { accountId: v.string(), bankSourceId: v.string(), trigger: v.optional(v.string()) }, returns: v.union(startResult, v.null()),
  handler: async (ctx, args) => {
    if (configFor("disbursement").mode !== "mock" || providerMode() !== "mock") return null;
    const loaded = await loadAccount(ctx, args.accountId);
    return await makeAttempt(ctx, loaded, args.bankSourceId, { trigger: args.trigger ?? "auto_start", actor: SYSTEM_ACTOR });
  },
});

export const getRun = internalQuery({
  args: { runId: v.string() }, returns: v.union(orch.disbursementRun, v.null()),
  handler: async (ctx, { runId }) => { const run = await ctx.db.query("financeDisbursementRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique(); return run ? recordOnly(run) : null; },
});

export const recordRetry = internalMutation({
  args: { runId: v.string(), error: investigationError }, returns: v.boolean(),
  handler: async (ctx, { runId, error }) => {
    const run = await findRun(ctx, runId);
    if (run.status !== "investigating" || run.retries >= MAX_AUTOMATIC_RETRIES) return false;
    await ctx.db.patch("financeDisbursementRuns", run._id, { retries: run.retries + 1 });
    const orchestration = await findOrchestration(ctx, run.taskId);
    if (orchestration) await step(ctx, orchestration, { kind: "retry", to: "investigating", trigger: "provider_error", actor: SYSTEM_ACTOR, runId, error, reason: { code: error.code, message: `${error.message} Retrying once automatically.` } });
    return true;
  },
});

/** The Disbursement agent in its configured mode, then (in a paid checker mode) the Evidence Checker, in one bounded action. */
export const execute = internalAction({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const run = await ctx.runQuery(internal.financeTrust.getRun, { runId });
    if (!run || run.status !== "investigating") return null;
    const timeoutMs = parseProviderTimeoutMs(env.PROVIDER_TIMEOUT_MS);
    const save = <T,>(write: () => Promise<T>) => retryWriteConflicts(write);
    const failure = (error: unknown) => error instanceof FinanceProviderError ? { code: error.code, message: error.message, retryable: error.retryable } : { code: "provider_failure", message: "The Disbursement agent failed unexpectedly.", retryable: false };
    try {
      const config = configFor("disbursement");
      const provider = createAgentProvider<DisbursementInput>(config, mockDisbursementProvider, DISBURSEMENT_REPORT_FIELDS, { timeoutMs });
      let execution = await callWithRetry(() => provider.start(run.input as DisbursementInput), { timeoutMs, phase: "start", paid: config.realRuns === 1, onRetry: async error => await save(() => ctx.runMutation(internal.financeTrust.recordRetry, { runId, error: failure(error) })) });
      const deadline = run.deadline;
      while (execution.status === "pending") {
        if (Date.now() >= deadline) throw new FinanceProviderError("provider_timeout", "The Disbursement agent did not finish before the run deadline.");
        await new Promise(resolve => setTimeout(resolve, 3000));
        execution = await provider.poll(execution.externalRunId);
      }
      if (execution.status === "failed") throw new FinanceProviderError(execution.error.code, execution.error.message);
      const checkerJob = await save(() => ctx.runMutation(internal.financeTrust.recordResult, { runId, externalRunId: execution.externalRunId, outputJson: JSON.stringify(execution.output) }));
      if (!checkerJob) return null;
      const checker = configFor("evidence_checker");
      const checkerProvider = createAgentProvider<CheckerInput>(checker, { mode: "mock", async start(input) { return { status: "completed", externalRunId: `mock-checker:${input.runId}`, output: mockCheckerOutput(input) }; }, async poll() { throw new FinanceProviderError("mock_poll_unsupported", "mock"); } }, ["schemaVersion", "verdicts"], { timeoutMs });
      let check = await callWithRetry(() => checkerProvider.start(JSON.parse(checkerJob) as CheckerInput), { timeoutMs, phase: "check", paid: checker.realRuns === 1, onRetry: async () => false });
      while (check.status === "pending") {
        if (Date.now() >= deadline) throw new FinanceProviderError("provider_timeout", "The Evidence Checker did not finish before the run deadline.");
        await new Promise(resolve => setTimeout(resolve, 3000));
        check = await checkerProvider.poll(check.externalRunId);
      }
      if (check.status === "failed") throw new FinanceProviderError(check.error.code, `Evidence Checker: ${check.error.message}`);
      await save(() => ctx.runMutation(internal.financeTrust.recordCheck, { runId, outputJson: JSON.stringify(check.output) }));
    } catch (error) {
      await save(() => ctx.runMutation(internal.financeTrust.recordFailure, { runId, error: failure(error) }));
    }
    return null;
  },
});

async function fail(ctx: MutationCtx, run: Doc<"financeDisbursementRuns">, error: { code: string; message: string; retryable: boolean; details?: Array<{ path: string; reason: string }> }, trigger: string) {
  if (!ACTIVE.has(run.status)) return;
  await ctx.db.patch("financeDisbursementRuns", run._id, { status: "failed", error, updatedAt: Date.now() });
  const orchestration = await findOrchestration(ctx, run.taskId);
  if (orchestration) await step(ctx, orchestration, { to: "failed", trigger, actor: trigger === "validation_failed" ? CODE_ACTOR : SYSTEM_ACTOR, runId: run.runId, activeRunId: null, error, reason: { code: error.code, message: `Failed, needs a person: ${error.message}` } });
  await captureStep(ctx, { runId: run.runId, taskId: run.taskId, accountId: run.accountId, agent: "disbursement", kind: "failed", actor: SYSTEM_ACTOR, provenance: run.provenance, startedAt: run.updatedAt, input: run.input, output: null, message: `${error.code}: ${error.message}` });
}

export const recordFailure = internalMutation({
  args: { runId: v.string(), error: investigationError }, returns: v.null(),
  handler: async (ctx, { runId, error }) => { await fail(ctx, await findRun(ctx, runId), error, error.code === "provider_timeout" ? "timeout" : "provider_error"); return null; },
});

/** Validates the agent's lines (never repaired) and code-checks each against the signed statement. Returns the checker input JSON when a paid checker must run, else settles with the mock inline. */
export const recordResult = internalMutation({
  args: { runId: v.string(), externalRunId: v.string(), outputJson: v.string() }, returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const run = await findRun(ctx, args.runId);
    if (run.status !== "investigating") return null;
    if (Date.now() >= run.deadline) { await fail(ctx, run, { code: "timeout", message: "The disbursement run timed out.", retryable: false }, "timeout"); return null; }
    const answeredAt = run.updatedAt;
    let orchestration = (await findOrchestration(ctx, run.taskId))!;
    await ctx.db.patch("financeDisbursementRuns", run._id, { status: "validating", externalRunId: args.externalRunId, updatedAt: Date.now() });
    orchestration = await step(ctx, orchestration, { to: "validating", trigger: "provider_result", actor: agentActor(run.provenance), runId: run.runId, reason: { code: "ANSWER_RECEIVED", message: "The Disbursement agent answered; validating it." } });
    const input = run.input as DisbursementInput;
    let output: DisbursementOutput;
    try {
      if (args.outputJson.length > 60_000) throw new Error("too large");
      output = validateDisbursementOutput(JSON.parse(args.outputJson) as unknown, input);
    } catch (error) {
      const details = error instanceof DisbursementValidationError ? error.details : [{ path: "$", reason: "Output must be one raw JSON object within the supported size." }];
      await fail(ctx, { ...run, status: "validating" }, { code: "validation_failed", message: "The Disbursement agent's answer failed validation. No payout was proposed.", retryable: false, details }, "validation_failed");
      return null;
    }
    const lineChecks = codeCheckPayoutLines(output, input);
    await ctx.db.patch("financeDisbursementRuns", run._id, { status: "checking", output, lineChecks, updatedAt: Date.now() });
    await step(ctx, orchestration, { to: "checking", trigger: "validated", actor: CODE_ACTOR, runId: run.runId, reason: { code: "VALIDATED", message: `Valid answer: ${output.outcome}, ${output.lines.length} line(s). Code checked each line against the signed statement; the Evidence Checker runs next.` } });
    await captureStep(ctx, { runId: run.runId, taskId: run.taskId, accountId: run.accountId, agent: "disbursement", kind: "output_validated", actor: agentActor(run.provenance), provenance: run.provenance, startedAt: answeredAt, input, output, message: `${output.outcome}: ${output.summary.slice(0, 200)}` });
    const checkerInput = buildCheckerInput(run.runId, { ...(input as unknown as CheckerInput["investigationInput"]), records: disbursementRecords(input), humanClarifications: input.humanClarifications, approvedPolicies: input.approvedPolicies }, disbursementClaims(output, input));
    if (configFor("evidence_checker").mode !== "mock") return JSON.stringify(checkerInput);
    await settle(ctx, await findRun(ctx, run.runId), checkerInput, JSON.stringify(mockCheckerOutput(checkerInput)));
    return null;
  },
});

/** The checker reads the matter's records in the investigation-input shape it already knows. */
function disbursementRecords(input: DisbursementInput): CheckerInput["investigationInput"]["records"] {
  return {
    transactions: [], owners: [input.client, ...(input.firm ? [input.firm] : [])].map(o => ({ synthetic: true as const, caseId: `disb:${input.accountId}`, ownerId: o.ownerId, name: o.name })),
    documents: input.documents.map(d => ({ synthetic: true as const, caseId: `disb:${input.accountId}`, documentId: d.raw.rawId, sourceId: d.sourceId, title: d.title, mimeType: "text/plain" as const, text: `${d.text}${d.signed ? "\nSigned." : "\nNot signed."}${d.lines ? `\n${d.lines.map(l => `${l.label}: ${formatCents(l.amountCents, input.currency)}`).join("\n")}` : ""}${d.feeBasisPoints ? `\nFee: ${d.feeBasisPoints / 100}%` : ""}`, excerpt: d.excerpt, version: d.version, effectiveAt: null })),
    invoices: input.invoices.map(i => ({ recordId: i.raw.rawId, sourceId: i.sourceId, version: i.raw.datasetVersion, excerpt: `${i.excerpt} (${i.status})` })), agreements: [],
    bankBalance: null, controlBalance: null, ownerBalances: null, ownerBalancesComplete: false, timingDifferences: [], existingAllocations: [], allocationHistoryComplete: true, missingEvidence: [], coverage: "available_records_only" as const,
    bankTransactions: input.settlementDeposit ? [input.settlementDeposit] : [], obligations: input.invoices,
  };
}

export const recordCheck = internalMutation({
  args: { runId: v.string(), outputJson: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const run = await findRun(ctx, args.runId);
    if (run.status !== "checking" || !run.output) return null;
    const input = run.input as DisbursementInput;
    const checkerInput = buildCheckerInput(run.runId, { ...(input as unknown as CheckerInput["investigationInput"]), records: disbursementRecords(input), humanClarifications: input.humanClarifications, approvedPolicies: input.approvedPolicies }, disbursementClaims(run.output as DisbursementOutput, input));
    await settle(ctx, run, checkerInput, args.outputJson);
    return null;
  },
});

/** Verdicts stored, then each line becomes a payment proposal through the lock. Nothing posts; a person approves each line. */
async function settle(ctx: MutationCtx, run: Doc<"financeDisbursementRuns">, checkerInput: CheckerInput, checkerOutputJson: string) {
  const input = run.input as DisbursementInput;
  const output = run.output as DisbursementOutput;
  const checkStartedAt = run.updatedAt;
  const code = checkerInput.claims.map(c => ({ findingId: c.findingId, claim: c.claim, sourceRefs: c.sourceRefs, verdict: c.codeVerdict, checkedBy: "code" as const, reason: c.codeReason, facts: [], missing: [], sourceSays: null }));
  let claimCheck;
  try { claimCheck = finalizeClaimCheck(code, validateCheckerOutput(JSON.parse(checkerOutputJson) as unknown, checkerInput), (configFor("evidence_checker").mode ?? "mock"), Date.now()); }
  catch (error) {
    const details = error instanceof CheckerOutputValidationError ? error.details : [{ path: "$", reason: "Checker output must be one raw JSON object." }];
    await fail(ctx, run, { code: "checker_validation_failed", message: "The Evidence Checker's answer failed validation; no line counts as checked.", retryable: false, details }, "checker_failed");
    return;
  }
  const orchestration = (await findOrchestration(ctx, run.taskId))!;
  const checkerActor: OrchestratorActor = { type: "agent", identity: `agent:evidence-checker:${claimCheck.agentMode}` };
  await captureStep(ctx, { runId: run.runId, taskId: run.taskId, accountId: run.accountId, agent: "evidence_checker", kind: "claims_checked", actor: checkerActor, provenance: provenanceFor("evidence_checker"), startedAt: checkStartedAt, input: checkerInput, output: claimCheck, checkerVerdicts: claimCheck.claims, message: `Evidence Checker (${claimCheck.agentMode}): ${claimCheck.status}.` });
  const unsupportedLine = run.lineChecks.find(l => !l.supported);
  if (claimCheck.status === "rejected" || unsupportedLine) {
    await ctx.db.patch("financeDisbursementRuns", run._id, { status: "rejected", claimCheck, updatedAt: Date.now() });
    const why = unsupportedLine ? `Line ${unsupportedLine.lineId}: ${unsupportedLine.reason}` : `"${claimCheck.claims.find(c => c.verdict === "not_supported")!.claim}" ${claimCheck.claims.find(c => c.verdict === "not_supported")!.reason}`;
    await step(ctx, orchestration, { to: "rejected", trigger: "checker_result", actor: unsupportedLine ? CODE_ACTOR : checkerActor, runId: run.runId, activeRunId: null, reason: { code: "CHECKER_REJECTED", message: `${why} Nothing was sent for approval.` } });
    return;
  }
  if (output.outcome === "needs_information") {
    await ctx.db.patch("financeDisbursementRuns", run._id, { status: "needs_person", claimCheck, updatedAt: Date.now() });
    await step(ctx, orchestration, { to: "needs_person", trigger: "checker_result", actor: checkerActor, runId: run.runId, activeRunId: null, reason: { code: "QUESTION_ASKED", message: `The Disbursement agent asked instead of guessing: ${output.questions.map(q => q.question).join(" ")}` } });
    return;
  }
  const loaded = await loadAccount(ctx, run.accountId);
  const actor = { identity: `agent:disbursement:${run.runId}`, authenticated: false, role: "system" as const };
  const results: Array<{ proposalId: string; status: string; lock: LockResult }> = [];
  const lockStartedAt = Date.now();
  for (const line of output.lines) {
    const now = Date.now();
    const draft: MoneyProposal = {
      proposalId: await nextProposalId(ctx, run.accountId, "payment"), accountId: run.accountId, kind: "payment", status: "proposed", currency: loaded.state.account.currency, requestedBy: actor.identity,
      // Evidence is the signed documents only: a bank sourceId in an entry's sourceRefs would read as a second recording of the deposit. The deposit is the funding link.
      origin: { type: "agent", taskId: run.taskId, runId: run.runId, agentProposalIds: [line.lineId] }, evidenceSourceIds: [...new Set(line.sourceRefs)].slice(0, 20),
      ownerId: run.clientOwnerId, amountCents: line.amountCents, purpose: `${line.label} (Disbursement agent, ${run.matterId}; unapproved)`, ...(input.settlementDeposit ? { fundingSourceId: input.settlementDeposit.sourceId } : {}),
      payoutKind: line.kind, matterId: run.matterId, settlementSourceId: run.settlementSourceId, ...(line.payeeOwnerId ? { payeeOwnerId: line.payeeOwnerId } : {}), createdAt: now, updatedAt: now,
    };
    const { proposal, lock } = await submitProposal(ctx, draft, actor);
    results.push({ proposalId: proposal.proposalId, status: proposal.status, lock });
  }
  await ctx.db.patch("financeDisbursementRuns", run._id, { status: results.some(r => r.status === "blocked") ? "needs_person" : "ready_for_approval", claimCheck, proposalIds: results.map(r => r.proposalId), updatedAt: Date.now() });
  await captureStep(ctx, { runId: run.runId, taskId: run.taskId, accountId: run.accountId, agent: "disbursement", kind: "lock_evaluated", actor: CODE_ACTOR, provenance: run.provenance, startedAt: lockStartedAt, input: output.lines, output: results.map(r => ({ proposalId: r.proposalId, status: r.status })), lockResults: results.map(r => r.lock), message: `Lock at request: ${results.map(r => `${r.proposalId} ${r.status}${r.lock.allowed ? "" : ` (${r.lock.failures.map(f => f.rule).join(", ")})`}`).join("; ")}.` });
  const settled = settledState({ checkerRejected: false, outcome: "proposal_ready", depositPending: false, lockBlocked: results.some(r => r.status === "blocked") });
  await step(ctx, orchestration, { to: settled.state, trigger: "checker_result", actor: checkerActor, runId: run.runId, activeRunId: null, reason: { code: settled.reason.code, message: `${output.lines.length} payout line(s) ${settled.state === "ready_for_approval" ? "passed the lock and wait for a person" : `: ${results.filter(r => r.status === "blocked").map(r => `${r.proposalId} blocked by ${r.lock.failures.map(f => f.rule).join(", ")}`).join("; ")}`}.` } });
}

const lineView = v.object({ proposalId: v.union(v.string(), v.null()), status: v.union(v.string(), v.null()), line: orch.payoutLine, check: v.union(orch.lineCheck, v.null()), lock: v.union(money.lockResult, v.null()) });

/** One disbursement run with its lines, their checks, the proposals they became and the lock's decisions. */
export const getDisbursement = query({
  args: { runId: v.string() },
  returns: v.union(v.null(), v.object({ run: orch.disbursementRun, state: v.union(orch.state, v.null()), lines: v.array(lineView), events: v.array(orch.event.extend({ snapshotId: v.union(v.string(), v.null()) })) })),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.query("financeDisbursementRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique();
    if (!run) return null;
    const orchestration = await ctx.db.query("financeOrchestrations").withIndex("by_orchestrationId", q => q.eq("orchestrationId", run.orchestrationId)).unique();
    const events = await ctx.db.query("financeOrchestratorEvents").withIndex("by_orchestrationId_and_sequence", q => q.eq("orchestrationId", run.orchestrationId)).take(200);
    const snapshots = await ctx.db.query("financeOrchestratorSnapshots").withIndex("by_orchestrationId_and_sequence", q => q.eq("orchestrationId", run.orchestrationId)).take(200);
    const output = run.output as DisbursementOutput | null;
    const lines = await Promise.all((output?.lines ?? []).map(async (line, i) => {
      const proposalId = run.proposalIds[i] ?? null;
      const proposal = proposalId ? await ctx.db.query("financeProposals").withIndex("by_proposalId", q => q.eq("proposalId", proposalId)).unique() : null;
      const transitions = proposalId ? await ctx.db.query("financeProposalTransitions").withIndex("by_proposalId", q => q.eq("proposalId", proposalId)).take(50) : [];
      const lock = [...transitions].reverse().find(t => t.lock)?.lock ?? null;
      return { proposalId, status: proposal?.status ?? null, line, check: run.lineChecks.find(c => c.lineId === line.lineId) ?? null, lock };
    }));
    return { run: recordOnly(run), state: orchestration?.state ?? null, lines, events: events.map(e => ({ ...recordOnly(e), snapshotId: snapshots.find(s => s.eventId === e.eventId)?.snapshotId ?? null })) };
  },
});

export const listDisbursements = query({
  args: { accountId: v.string() }, returns: v.array(orch.disbursementRun),
  handler: async (ctx, { accountId }) => (await ctx.db.query("financeDisbursementRuns").withIndex("by_accountId", q => q.eq("accountId", accountId)).order("desc").take(50)).map(recordOnly),
});

/* ---------- Disputes (trust rule L10) ---------- */

/** A person records that part of a client's balance is disputed. Payments beyond the undisputed part are held, not blocked, until resolved. */
export const recordDispute = mutation({
  args: { accountId: v.string(), ownerId: v.string(), amountCents: v.number(), reason: v.string(), sourceIds: v.optional(v.array(v.string())), dev: money.devIdentity }, returns: money.dispute,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    const loaded = await loadAccount(ctx, args.accountId);
    const owner = loaded.state.owners.find(o => o.ownerId === args.ownerId);
    if (!owner) throw new ConvexError("Unknown owner for this account.");
    if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0) throw new ConvexError("The disputed amount must be positive integer cents.");
    const reason = args.reason.trim();
    if (!reason || reason.length > 2000) throw new ConvexError("Give the reason for the dispute (1–2000 characters).");
    const count = (await ctx.db.query("financeDisputes").withIndex("by_accountId", q => q.eq("accountId", args.accountId)).take(500)).length;
    const now = Date.now();
    const dispute = { disputeId: `${args.accountId}:dispute:${String(count + 1).padStart(3, "0")}`, accountId: args.accountId, ownerId: args.ownerId, amountCents: args.amountCents, reason, status: "open" as const, recordedBy: actor.identity, recordedAt: now, sourceIds: (args.sourceIds ?? []).slice(0, 20) };
    await ctx.db.insert("financeDisputes", dispute);
    await appendMoneyEvent(ctx, { accountId: args.accountId, type: "finance.money.hold_updated", actor, operationId: dispute.disputeId, stage: "dispute_recorded", message: `${actor.identity} recorded a ${formatCents(args.amountCents)} dispute on ${owner.name}'s balance: ${reason}. That amount stays in trust (L10) until a person records the resolution.`, sourceIds: [owner.sourceId, ...dispute.sourceIds], threeWay: checkAccount((await loadAccount(ctx, args.accountId)).state, now) });
    await recheckHeldProposals(ctx, args.accountId);
    return dispute;
  },
});

/** Approver only: records how the dispute was resolved. Held payments are re-checked; nothing moves by itself. */
export const resolveDispute = mutation({
  args: { disputeId: v.string(), resolution: v.string(), dev: money.devIdentity }, returns: money.dispute,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (actor.role !== "approver") throw new ConvexError("Switch to the approver role to resolve a dispute.");
    const row = await ctx.db.query("financeDisputes").withIndex("by_disputeId", q => q.eq("disputeId", args.disputeId)).unique();
    if (!row) throw new ConvexError("Unknown dispute.");
    if (row.status !== "open") throw new ConvexError("This dispute is already resolved.");
    const resolution = args.resolution.trim();
    if (!resolution || resolution.length > 2000) throw new ConvexError("Record how the dispute was resolved (1–2000 characters).");
    if (row.recordedBy === actor.identity) throw new ConvexError("L4: a different person must record the resolution than the one who recorded the dispute.");
    const now = Date.now();
    await ctx.db.patch("financeDisputes", row._id, { status: "resolved", resolvedBy: actor.identity, resolvedAt: now, resolution });
    const next = { ...recordOnly(row), status: "resolved" as const, resolvedBy: actor.identity, resolvedAt: now, resolution };
    await appendMoneyEvent(ctx, { accountId: row.accountId, type: "finance.money.hold_updated", actor, operationId: row.disputeId, stage: "dispute_resolved", message: `${actor.identity} resolved dispute ${row.disputeId} (${formatCents(row.amountCents)}): ${resolution}. Held payments are re-checked; a person still continues them.`, sourceIds: row.sourceIds, threeWay: checkAccount((await loadAccount(ctx, row.accountId)).state, now) });
    await recheckHeldProposals(ctx, row.accountId);
    return next;
  },
});

export const listDisputes = query({
  args: { accountId: v.string() }, returns: v.array(money.dispute),
  handler: async (ctx, { accountId }) => (await ctx.db.query("financeDisputes").withIndex("by_accountId", q => q.eq("accountId", accountId)).take(200)).map(recordOnly),
});

export type { Orchestration };
