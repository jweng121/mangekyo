import type { InvestigationError } from "@mangekyo/contracts";
import { createFinanceAgentProvider, FinanceProviderError, type ProviderExecution } from "@mangekyo/finance-core/agent";
import { createClaimCheckerProvider, type CheckerInput } from "@mangekyo/finance-core/checker";
import { callWithRetry, isRetryable, parseMockFault, parseProviderTimeoutMs, withMockFault, withTimeout } from "@mangekyo/finance-core/orchestrator";
import { internal } from "./_generated/api";
import { env, internalAction, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";

function safeError(error: unknown): InvestigationError {
  if (error instanceof FinanceProviderError) return { code: error.code, message: error.message, retryable: error.retryable };
  // Provider exceptions may contain request URLs or secrets. Never persist raw exception text.
  return { code: "provider_failure", message: "Provider execution failed unexpectedly. No mock fallback or financial action occurred.", retryable: false };
}

const timeoutMs = () => parseProviderTimeoutMs(env.PROVIDER_TIMEOUT_MS);
const retry = (ctx: ActionCtx, runId: string, provider: "investigator" | "checker") =>
  async (error: FinanceProviderError) => await ctx.runMutation(internal.financeInvestigations.recordRetry, { runId, provider, error: safeError(error) });

async function saveExecution(ctx: ActionCtx, runId: string, execution: ProviderExecution): Promise<void> {
  if (execution.status === "pending") {
    await ctx.runMutation(internal.financeInvestigations.recordPending, { runId, externalRunId: execution.externalRunId });
  } else if (execution.status === "completed") {
    const needsChecker = await ctx.runMutation(internal.financeInvestigations.recordResult, { runId, externalRunId: execution.externalRunId, outputJson: JSON.stringify(execution.output), ...(execution.reportSource ? { reportSource: execution.reportSource } : {}) });
    if (needsChecker) await startChecker(ctx, runId);
  } else {
    await ctx.runMutation(internal.financeInvestigations.recordFailure, { runId, externalRunId: execution.externalRunId, error: execution.error });
  }
}

/**
 * One claimed start per attempt, with a timeout and at most one automatic retry for provider or network trouble.
 * A lost POST response of a paid run is ambiguous and never retried.
 */
export const execute = internalAction({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const run = await ctx.runMutation(internal.financeInvestigations.claimExecution, { runId });
    if (!run) return null;
    try {
      if (!run.providerInput) throw new Error("Missing immutable provider context");
      const base = createFinanceAgentProvider({ mode: run.mode, appId: run.providerAppId ?? env.CREAO_APP_ID, apiKey: env.CREAO_API_KEY, timeoutMs: timeoutMs() });
      const provider = withMockFault(base, run.mode === "mock" ? parseMockFault(env.MOCK_PROVIDER_FAULT) : null);
      const execution = await callWithRetry(() => provider.start(run.providerInput!), { timeoutMs: timeoutMs(), phase: "start", paid: run.mode === "creao", onRetry: retry(ctx, runId, "investigator") });
      await saveExecution(ctx, runId, execution);
    } catch (error) {
      await ctx.runMutation(internal.financeInvestigations.recordFailure, { runId, error: safeError(error) });
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
      await ctx.runMutation(internal.financeInvestigations.expireRun, { runId });
      return null;
    }
    try {
      const provider = createFinanceAgentProvider({ mode: run.mode, appId: run.providerAppId ?? env.CREAO_APP_ID, apiKey: env.CREAO_API_KEY, timeoutMs: timeoutMs() });
      await saveExecution(ctx, runId, await withTimeout(() => provider.poll(run.externalRunId!), timeoutMs(), "poll", run.mode === "creao"));
    } catch (error) {
      const failure = safeError(error);
      if (isRetryable(failure) && await ctx.runMutation(internal.financeInvestigations.recordRetry, { runId, provider: "investigator", error: failure })) {
        await ctx.runMutation(internal.financeInvestigations.recordPending, { runId, externalRunId: run.externalRunId });
      } else {
        await ctx.runMutation(internal.financeInvestigations.recordFailure, { runId, error: failure });
      }
    }
    return null;
  },
});

async function saveCheck(ctx: ActionCtx, runId: string, execution: ProviderExecution): Promise<void> {
  if (execution.status === "pending") await ctx.runMutation(internal.financeInvestigations.recordCheckerPending, { runId, externalRunId: execution.externalRunId });
  else if (execution.status === "completed") await ctx.runMutation(internal.financeInvestigations.recordCheck, { runId, externalRunId: execution.externalRunId, outputJson: JSON.stringify(execution.output) });
  else await ctx.runMutation(internal.financeInvestigations.recordCheckFailure, { runId, error: execution.error });
}

/** CHECKER_MODE=creao only: starts the checker agent for a validated run. Never called for mock, which runs inside recordResult. */
async function startChecker(ctx: ActionCtx, runId: string): Promise<void> {
  const job = await ctx.runQuery(internal.financeInvestigations.getCheckerJob, { runId });
  if (!job) return;
  const input = JSON.parse(job.checkerInputJson) as CheckerInput;
  try {
    // No claims means nothing for a paid checker run to judge.
    if (job.claims === 0) { await ctx.runMutation(internal.financeInvestigations.recordCheck, { runId, outputJson: JSON.stringify({ schemaVersion: "finance-claim-check-output/v1", verdicts: [] }) }); return; }
    const provider = createClaimCheckerProvider({ mode: "creao", appId: job.appId ?? env.CREAO_CHECKER_APP_ID, apiKey: env.CREAO_CHECKER_API_KEY ?? env.CREAO_API_KEY, timeoutMs: timeoutMs() });
    await saveCheck(ctx, runId, await callWithRetry(() => provider.start(input), { timeoutMs: timeoutMs(), phase: "check", paid: true, onRetry: retry(ctx, runId, "checker") }));
  } catch (error) {
    await ctx.runMutation(internal.financeInvestigations.recordCheckFailure, { runId, error: safeError(error) });
  }
}

export const pollChecker = internalAction({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const job = await ctx.runQuery(internal.financeInvestigations.getCheckerJob, { runId });
    if (!job?.externalRunId) return null;
    if (Date.now() >= job.deadline) { await ctx.runMutation(internal.financeInvestigations.expireRun, { runId }); return null; }
    try {
      const provider = createClaimCheckerProvider({ mode: "creao", appId: job.appId ?? env.CREAO_CHECKER_APP_ID, apiKey: env.CREAO_CHECKER_API_KEY ?? env.CREAO_API_KEY, timeoutMs: timeoutMs() });
      await saveCheck(ctx, runId, await withTimeout(() => provider.poll(job.externalRunId!), timeoutMs(), "poll", true));
    } catch (error) {
      const failure = safeError(error);
      if (isRetryable(failure) && await ctx.runMutation(internal.financeInvestigations.recordRetry, { runId, provider: "checker", error: failure })) {
        await ctx.runMutation(internal.financeInvestigations.recordCheckerPending, { runId, externalRunId: job.externalRunId });
      } else {
        await ctx.runMutation(internal.financeInvestigations.recordCheckFailure, { runId, error: failure });
      }
    }
    return null;
  },
});
