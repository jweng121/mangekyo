import type { InvestigationError } from "@mangekyo/contracts";
import { FinanceProviderError, INVESTIGATION_REPORT_FIELDS, mockFinanceAgentProvider, type FinanceAgentProvider, type ProviderExecution } from "@mangekyo/finance-core/agent";
import { createAgentProvider } from "@mangekyo/finance-core/agents";
import { mockClaimCheckerProvider, type CheckerInput, type ClaimCheckerProvider } from "@mangekyo/finance-core/checker";
import { callWithRetry, isRetryable, parseMockFault, parseProviderTimeoutMs, retryWriteConflicts, withMockFault, withTimeout, WRITE_CONFLICT } from "@mangekyo/finance-core/orchestrator";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { internal } from "./_generated/api";
import { env, internalAction, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { configFor } from "./lib/agents";

function safeError(error: unknown): InvestigationError {
  if (error instanceof FinanceProviderError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof Error && WRITE_CONFLICT.test(error.message)) return { code: "save_conflict", message: "The provider answered, but saving the answer kept conflicting with other runs settling at the same time. Nothing was sent for approval.", retryable: false };
  // Provider exceptions may contain request URLs or secrets. Never persist raw exception text.
  return { code: "provider_failure", message: "Provider execution failed unexpectedly. No mock fallback or financial action occurred.", retryable: false };
}

/** Every save goes through this: a write that conflicts with other runs settling is retried with backoff; the provider is not called again. */
const mutate = <M extends FunctionReference<"mutation", "internal">>(ctx: ActionCtx, ref: M, args: FunctionArgs<M>): Promise<FunctionReturnType<M>> =>
  retryWriteConflicts(() => ctx.runMutation(ref, args));
const timeoutMs = () => parseProviderTimeoutMs(env.PROVIDER_TIMEOUT_MS);
const retry = (ctx: ActionCtx, runId: string, provider: "investigator" | "checker") =>
  async (error: FinanceProviderError) => await mutate(ctx, internal.financeInvestigations.recordRetry, { runId, provider, error: safeError(error) });

/** Trust Intake in its configured mode (mock, its CREAO app, or an external model), behind the one provider interface. */
function intakeProvider(mode: string, appId: string | undefined): FinanceAgentProvider {
  const config = configFor("intake");
  if (config.mode !== mode) throw new FinanceProviderError("configuration_error", `This run was started in ${mode} mode but INTAKE_MODE is now ${config.mode ?? "invalid"}; it needs a person.`);
  const base = createAgentProvider(appId ? { ...config, appId } : config, mockFinanceAgentProvider, INVESTIGATION_REPORT_FIELDS, { timeoutMs: timeoutMs() });
  return { mode: config.mode, start: input => base.start(input), poll: id => base.poll(id) };
}

async function saveExecution(ctx: ActionCtx, runId: string, execution: ProviderExecution): Promise<void> {
  if (execution.status === "pending") {
    await mutate(ctx, internal.financeInvestigations.recordPending, { runId, externalRunId: execution.externalRunId });
  } else if (execution.status === "completed") {
    const needsChecker = await mutate(ctx, internal.financeInvestigations.recordResult, { runId, externalRunId: execution.externalRunId, outputJson: JSON.stringify(execution.output), ...(execution.reportSource ? { reportSource: execution.reportSource } : {}) });
    if (needsChecker) await startChecker(ctx, runId);
  } else {
    await mutate(ctx, internal.financeInvestigations.recordFailure, { runId, externalRunId: execution.externalRunId, error: execution.error });
  }
}

/**
 * One claimed start per attempt, with a timeout and at most one automatic retry for provider or network trouble.
 * A lost POST response of a paid run is ambiguous and never retried.
 */
export const execute = internalAction({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const run = await mutate(ctx, internal.financeInvestigations.claimExecution, { runId });
    if (!run) return null;
    try {
      if (!run.providerInput) throw new Error("Missing immutable provider context");
      const base = intakeProvider(run.mode, run.providerAppId);
      const provider = withMockFault(base as never, run.mode === "mock" ? parseMockFault(env.MOCK_PROVIDER_FAULT) : null) as unknown as FinanceAgentProvider;
      const execution = await callWithRetry(() => provider.start(run.providerInput!), { timeoutMs: timeoutMs(), phase: "start", paid: run.mode !== "mock", onRetry: retry(ctx, runId, "investigator") });
      await saveExecution(ctx, runId, execution);
    } catch (error) {
      await mutate(ctx, internal.financeInvestigations.recordFailure, { runId, error: safeError(error) });
    }
    return null;
  },
});

/** Each pending response schedules the next poll; no blocking loop or fresh run POST. A failed status check is retried once. */
export const poll = internalAction({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const run = await ctx.runQuery(internal.financeInvestigations.getRun, { runId });
    if (!run || run.status !== "provider_pending" || !run.externalRunId) return null;
    if (Date.now() >= run.deadline) {
      await mutate(ctx, internal.financeInvestigations.expireRun, { runId });
      return null;
    }
    try {
      const provider = intakeProvider(run.mode, run.providerAppId);
      await saveExecution(ctx, runId, await withTimeout(() => provider.poll(run.externalRunId!), timeoutMs(), "poll", run.mode !== "mock"));
    } catch (error) {
      const failure = safeError(error);
      if (isRetryable(failure) && await mutate(ctx, internal.financeInvestigations.recordRetry, { runId, provider: "investigator", error: failure })) {
        await mutate(ctx, internal.financeInvestigations.recordPending, { runId, externalRunId: run.externalRunId });
      } else {
        await mutate(ctx, internal.financeInvestigations.recordFailure, { runId, error: failure });
      }
    }
    return null;
  },
});

async function saveCheck(ctx: ActionCtx, runId: string, execution: ProviderExecution): Promise<void> {
  if (execution.status === "pending") await mutate(ctx, internal.financeInvestigations.recordCheckerPending, { runId, externalRunId: execution.externalRunId });
  else if (execution.status === "completed") await mutate(ctx, internal.financeInvestigations.recordCheck, { runId, externalRunId: execution.externalRunId, outputJson: JSON.stringify(execution.output) });
  else await mutate(ctx, internal.financeInvestigations.recordCheckFailure, { runId, error: execution.error });
}

/** The Evidence Checker in a paid mode (its CREAO app or an external model). Never called for mock, which runs inside recordResult. */
function checkerProvider(appId: string | null): ClaimCheckerProvider {
  const config = configFor("evidence_checker");
  if (config.mode === "mock" || config.mode === null) throw new FinanceProviderError("configuration_error", "The Evidence Checker's mode changed while this run was waiting; it needs a person.");
  const base = createAgentProvider<CheckerInput>(appId ? { ...config, appId } : config, mockClaimCheckerProvider, ["schemaVersion", "verdicts"], { timeoutMs: timeoutMs() });
  return { mode: config.mode, start: input => base.start(input), poll: id => base.poll(id) };
}

async function startChecker(ctx: ActionCtx, runId: string): Promise<void> {
  const job = await ctx.runQuery(internal.financeInvestigations.getCheckerJob, { runId });
  if (!job) return;
  const input = JSON.parse(job.checkerInputJson) as CheckerInput;
  try {
    // No claims means nothing for a paid checker run to judge.
    if (job.claims === 0) { await mutate(ctx, internal.financeInvestigations.recordCheck, { runId, outputJson: JSON.stringify({ schemaVersion: "finance-claim-check-output/v1", verdicts: [] }) }); return; }
    const provider = checkerProvider(job.appId);
    await saveCheck(ctx, runId, await callWithRetry(() => provider.start(input), { timeoutMs: timeoutMs(), phase: "check", paid: true, onRetry: retry(ctx, runId, "checker") }));
  } catch (error) {
    await mutate(ctx, internal.financeInvestigations.recordCheckFailure, { runId, error: safeError(error) });
  }
}

export const pollChecker = internalAction({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const job = await ctx.runQuery(internal.financeInvestigations.getCheckerJob, { runId });
    if (!job?.externalRunId) return null;
    if (Date.now() >= job.deadline) { await mutate(ctx, internal.financeInvestigations.expireRun, { runId }); return null; }
    try {
      const provider = checkerProvider(job.appId);
      await saveCheck(ctx, runId, await withTimeout(() => provider.poll(job.externalRunId!), timeoutMs(), "poll", true));
    } catch (error) {
      const failure = safeError(error);
      if (isRetryable(failure) && await mutate(ctx, internal.financeInvestigations.recordRetry, { runId, provider: "checker", error: failure })) {
        await mutate(ctx, internal.financeInvestigations.recordCheckerPending, { runId, externalRunId: job.externalRunId });
      } else {
        await mutate(ctx, internal.financeInvestigations.recordCheckFailure, { runId, error: failure });
      }
    }
    return null;
  },
});
