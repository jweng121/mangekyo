import type { FinanceInvestigationRun } from "@mangekyo/contracts";
import { assertTransition, budgetDecision, parseBudget, utcDay, type BudgetDecision, type EventKind, type OrchestratorActor, type OrchestratorKind, type OrchestratorReason, type OrchestratorState, type Trigger } from "@mangekyo/finance-core/orchestrator";
import type { Doc } from "../_generated/dataModel";
import { env, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { InvestigationError } from "@mangekyo/contracts";

export type Orchestration = Doc<"financeOrchestrations">;
export const SYSTEM_ACTOR: OrchestratorActor = { type: "system", identity: "system:orchestrator" };
export const CODE_ACTOR: OrchestratorActor = { type: "code", identity: "code:finance-core" };

export function orchestrationIdFor(taskId: string) { return `${taskId}:orchestrator`; }

export async function findOrchestration(ctx: QueryCtx | MutationCtx, taskId: string): Promise<Orchestration | null> {
  return await ctx.db.query("financeOrchestrations").withIndex("by_taskId", q => q.eq("taskId", taskId)).unique();
}

type RunLike = Pick<FinanceInvestigationRun, "runId" | "attempt" | "status" | "mode" | "result" | "claimCheck">;
function summarize(run: RunLike | null) {
  if (!run) return null;
  const count = (verdict: string) => run.claimCheck?.claims.filter(c => c.verdict === verdict).length ?? 0;
  return { runId: run.runId, attempt: run.attempt, status: run.status, mode: run.mode, outcome: run.result?.outcome ?? null,
    checker: run.claimCheck ? { status: run.claimCheck.status, agentMode: run.claimCheck.agentMode, supported: count("supported"), notSupported: count("not_supported"), notCheckable: count("not_checkable") } : null };
}

export interface StepArgs {
  kind?: EventKind; to: OrchestratorState; trigger: Trigger | string; actor: OrchestratorActor; reason: OrchestratorReason;
  runId?: string | null; run?: RunLike | null; budget?: BudgetDecision; error?: InvestigationError; activeRunId?: string | null;
}

/**
 * Saves one orchestrator step: checks the transition table, appends the event and the snapshot, and updates the
 * orchestration row. Retries and budget checks are events that don't change the state.
 */
export async function step(ctx: MutationCtx, orchestration: Orchestration, args: StepArgs): Promise<Orchestration> {
  const kind = args.kind ?? "transition";
  const from = orchestration.state;
  if (kind === "transition") assertTransition(from, args.to);
  else if (args.to !== from || (kind === "retry" && from !== "investigating" && from !== "checking")) throw new Error(`A ${kind} event can't change the state (${from} → ${args.to}).`);
  const sequence = orchestration.sequence + 1;
  const timestamp = Date.now();
  const eventId = `${orchestration.orchestrationId}:event:${sequence}`;
  const runId = args.runId ?? args.run?.runId ?? orchestration.activeRunId ?? orchestration.lastRunId;
  const next: Omit<Orchestration, "_id" | "_creationTime"> = {
    orchestrationId: orchestration.orchestrationId, kind: orchestration.kind, taskId: orchestration.taskId, accountId: orchestration.accountId, subjectSourceId: orchestration.subjectSourceId,
    state: args.to, activeRunId: args.activeRunId !== undefined ? args.activeRunId : orchestration.activeRunId, lastRunId: runId ?? null, sequence,
    retries: orchestration.retries + (kind === "retry" ? 1 : 0), reason: kind === "transition" ? args.reason : orchestration.reason, createdAt: orchestration.createdAt, updatedAt: timestamp,
  };
  await ctx.db.insert("financeOrchestratorEvents", {
    eventId, orchestrationId: orchestration.orchestrationId, taskId: orchestration.taskId, accountId: orchestration.accountId, runId: runId ?? null, sequence,
    kind, from, to: args.to, trigger: args.trigger, actor: args.actor, reason: args.reason, timestamp,
    ...(args.budget ? { budget: { allowed: args.budget.allowed, code: args.budget.code, message: args.budget.message, needed: args.budget.needed, usedToday: args.budget.usedToday, usedForDeposit: args.budget.usedForDeposit, limits: args.budget.limits } } : {}),
    ...(args.error ? { error: args.error } : {}),
  });
  await ctx.db.insert("financeOrchestratorSnapshots", { snapshotId: `${orchestration.orchestrationId}:snapshot:${sequence}`, eventId, orchestrationId: orchestration.orchestrationId, sequence, timestamp, orchestration: next, run: summarize(args.run ?? null) });
  await ctx.db.patch("financeOrchestrations", orchestration._id, next);
  return { ...orchestration, ...next };
}

/** Creates the orchestration in `received`, with its first event and snapshot. Idempotent per task. */
export async function ensureOrchestration(ctx: MutationCtx, args: { kind: OrchestratorKind; taskId: string; accountId: string | null; subjectSourceId: string | null; trigger: Trigger | string; actor: OrchestratorActor; reason: OrchestratorReason }): Promise<Orchestration> {
  const existing = await findOrchestration(ctx, args.taskId);
  if (existing) return existing;
  const now = Date.now();
  const orchestrationId = orchestrationIdFor(args.taskId);
  const row = { orchestrationId, kind: args.kind, taskId: args.taskId, accountId: args.accountId, subjectSourceId: args.subjectSourceId, state: "received" as const, activeRunId: null, lastRunId: null, sequence: 1, retries: 0, reason: args.reason, createdAt: now, updatedAt: now };
  const id = await ctx.db.insert("financeOrchestrations", row);
  const eventId = `${orchestrationId}:event:1`;
  await ctx.db.insert("financeOrchestratorEvents", { eventId, orchestrationId, taskId: args.taskId, accountId: args.accountId, runId: null, sequence: 1, kind: "transition", from: null, to: "received", trigger: args.trigger, actor: args.actor, reason: args.reason, timestamp: now });
  await ctx.db.insert("financeOrchestratorSnapshots", { snapshotId: `${orchestrationId}:snapshot:1`, eventId, orchestrationId, sequence: 1, timestamp: now, orchestration: row, run: null });
  return (await ctx.db.get("financeOrchestrations", id))!;
}

/** Moves the run's orchestration when it has one; runs saved before the orchestrator existed have none. */
export async function stepForRun(ctx: MutationCtx, run: RunLike & { taskId: string }, args: Omit<StepArgs, "run">): Promise<Orchestration | null> {
  const orchestration = await findOrchestration(ctx, run.taskId);
  if (!orchestration || (orchestration.activeRunId !== null && orchestration.activeRunId !== run.runId)) return null;
  if (args.kind === undefined && orchestration.state === args.to) return orchestration;
  return await step(ctx, orchestration, { ...args, run });
}

/* ---------- Real-run budget ---------- */

export function budgetLimits() {
  return parseBudget({ perDay: env.MAX_REAL_RUNS_PER_DAY, perDeposit: env.MAX_REAL_RUNS_PER_DEPOSIT });
}

/** Counts real runs recorded today (UTC) and for this deposit. Bounded reads: a limit above 1000 is not meaningful here. */
export async function checkBudget(ctx: QueryCtx | MutationCtx, taskId: string, needed: number, now: number): Promise<BudgetDecision> {
  const limits = budgetLimits();
  if (needed === 0) return budgetDecision({ needed, usedToday: 0, usedForDeposit: 0, limits });
  const usedToday = (await ctx.db.query("financeRealRuns").withIndex("by_day", q => q.eq("day", utcDay(now))).take(1000)).length;
  const usedForDeposit = (await ctx.db.query("financeRealRuns").withIndex("by_taskId", q => q.eq("taskId", taskId)).take(1000)).length;
  return budgetDecision({ needed, usedToday, usedForDeposit, limits });
}
