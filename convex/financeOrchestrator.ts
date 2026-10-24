import { v } from "convex/values";
import { ORCHESTRATOR_STATES, parseMockFault, parseProviderTimeoutMs, utcDay } from "@mangekyo/finance-core/orchestrator";
import { env, query } from "./_generated/server";
import { checkerConfiguration, providerMode } from "./financeInvestigations";
import { recordOnly } from "./lib/investigationRecords";
import { budgetLimits } from "./lib/orchestrator";
import * as orch from "./lib/orchestratorValidators";

const modeConfig = v.object({ mode: v.union(v.literal("mock"), v.literal("creao"), v.null()), configured: v.boolean(), message: v.string() });

/** Everything that decides how runs behave, minus secrets. `now` lets the query count today's real runs without reading the clock. */
export const getConfiguration = query({
  args: { now: v.number() },
  returns: v.object({ investigator: v.union(v.literal("mock"), v.literal("creao"), v.null()), checker: modeConfig, timeoutMs: v.number(), mockFault: v.union(v.string(), v.null()),
    budget: v.object({ perDay: v.number(), perDeposit: v.number(), usedToday: v.number(), day: v.string() }) }),
  handler: async (ctx, { now }) => {
    const day = utcDay(now);
    const usedToday = (await ctx.db.query("financeRealRuns").withIndex("by_day", q => q.eq("day", day)).take(1000)).length;
    return { investigator: providerMode(), checker: checkerConfiguration(), timeoutMs: parseProviderTimeoutMs(env.PROVIDER_TIMEOUT_MS),
      mockFault: providerMode() === "mock" ? parseMockFault(env.MOCK_PROVIDER_FAULT) : null, budget: { ...budgetLimits(), usedToday, day } };
  },
});

const timelineEvent = orch.event.extend({ snapshotId: v.union(v.string(), v.null()) });

/** The orchestrator timeline for one deposit task (or mismatch): states, retries and budget checks, oldest first. */
export const getTimeline = query({
  args: { taskId: v.string() },
  returns: v.union(v.null(), v.object({ orchestration: orch.orchestration, events: v.array(timelineEvent) })),
  handler: async (ctx, { taskId }) => {
    const orchestration = await ctx.db.query("financeOrchestrations").withIndex("by_taskId", q => q.eq("taskId", taskId)).unique();
    if (!orchestration) return null;
    const events = await ctx.db.query("financeOrchestratorEvents").withIndex("by_orchestrationId_and_sequence", q => q.eq("orchestrationId", orchestration.orchestrationId)).take(300);
    const snapshots = await ctx.db.query("financeOrchestratorSnapshots").withIndex("by_orchestrationId_and_sequence", q => q.eq("orchestrationId", orchestration.orchestrationId)).take(300);
    const bySequence = new Map(snapshots.map(s => [s.eventId, s.snapshotId]));
    return { orchestration: recordOnly(orchestration), events: events.map(e => ({ ...recordOnly(e), snapshotId: bySequence.get(e.eventId) ?? null })) };
  },
});

/** Every orchestrator on an account with its current state, newest first, plus counts per state. */
export const getPipeline = query({
  args: { accountId: v.string() },
  returns: v.object({ counts: v.record(v.string(), v.number()), rows: v.array(orch.orchestration) }),
  handler: async (ctx, { accountId }) => {
    const rows = (await ctx.db.query("financeOrchestrations").withIndex("by_accountId", q => q.eq("accountId", accountId)).order("desc").take(400)).map(recordOnly);
    const counts: Record<string, number> = Object.fromEntries(ORCHESTRATOR_STATES.map(s => [s, 0]));
    for (const row of rows) counts[row.state]++;
    return { counts, rows };
  },
});
