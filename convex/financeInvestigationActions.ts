import type { InvestigationError } from "@mangekyo/contracts";
import { createFinanceAgentProvider, FinanceProviderError, type ProviderExecution } from "@mangekyo/finance-core/agent";
import { internal } from "./_generated/api";
import { env, internalAction, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";

function safeError(error: unknown): InvestigationError {
  if (error instanceof FinanceProviderError) return { code: error.code, message: error.message, retryable: error.retryable };
  // Provider exceptions may contain request URLs or secrets. Never persist raw exception text.
  return { code: "provider_failure", message: "Provider execution failed unexpectedly. No mock fallback or financial action occurred.", retryable: false };
}

async function saveExecution(ctx: ActionCtx, runId: string, execution: ProviderExecution): Promise<void> {
  if (execution.status === "pending") {
    await ctx.runMutation(internal.financeInvestigations.recordPending, { runId, externalRunId: execution.externalRunId });
  } else if (execution.status === "completed") {
    await ctx.runMutation(internal.financeInvestigations.recordResult, { runId, externalRunId: execution.externalRunId, outputJson: JSON.stringify(execution.output), ...(execution.reportSource ? { reportSource: execution.reportSource } : {}) });
  } else {
    await ctx.runMutation(internal.financeInvestigations.recordFailure, { runId, externalRunId: execution.externalRunId, error: execution.error });
  }
}

/** One claimed start per attempt. A lost POST response is never retried automatically. */
export const execute = internalAction({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const run = await ctx.runMutation(internal.financeInvestigations.claimExecution, { runId });
    if (!run) return null;
    try {
      if (!run.providerInput) throw new Error("Missing immutable provider context");
      const provider = createFinanceAgentProvider({ mode: run.mode, appId: run.providerAppId ?? env.CREAO_APP_ID, apiKey: env.CREAO_API_KEY });
      await saveExecution(ctx, runId, await provider.start(run.providerInput));
    } catch (error) {
      await ctx.runMutation(internal.financeInvestigations.recordFailure, { runId, error: safeError(error) });
    }
    return null;
  },
});

/** Each pending response schedules the next poll; no blocking loop or fresh run POST. */
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
      const provider = createFinanceAgentProvider({ mode: run.mode, appId: run.providerAppId ?? env.CREAO_APP_ID, apiKey: env.CREAO_API_KEY });
      await saveExecution(ctx, runId, await provider.poll(run.externalRunId));
    } catch (error) {
      const failure = safeError(error);
      if (failure.retryable && run.pollCount < 200) {
        await ctx.runMutation(internal.financeInvestigations.recordPending, { runId, externalRunId: run.externalRunId });
      } else {
        await ctx.runMutation(internal.financeInvestigations.recordFailure, { runId, error: failure });
      }
    }
    return null;
  },
});
