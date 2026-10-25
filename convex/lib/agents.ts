import type { ClaimCheck, LockResult } from "@mangekyo/contracts";
import type { AgentName, OrchestratorActor, RunStepKind, StepSnapshot } from "@mangekyo/contracts/orchestration";
import { agentConfig, AGENTS, INSTRUCTION_VERSIONS, provenance as provenanceOf, type AgentConfig, type AgentRunProvenance, type EnvReader } from "@mangekyo/finance-core/agents";
import type { Doc } from "../_generated/dataModel";
import { env, type MutationCtx, type QueryCtx } from "../_generated/server";
import { recordOnly } from "./investigationRecords";

/** The typed Convex env, read by name so the registry's alias rules apply. */
export const readEnv: EnvReader = name => (env as unknown as Record<string, string | undefined>)[name];

export function configFor(agent: AgentName): AgentConfig { return agentConfig(agent, readEnv); }
export function provenanceFor(agent: AgentName): AgentRunProvenance { return provenanceOf(agent, configFor(agent), INSTRUCTION_VERSIONS[agent]); }

/** Public view of every agent's mode and model, minus keys. */
export function agentConfigurations() {
  return (Object.keys(AGENTS) as AgentName[]).map(agent => {
    const c = configFor(agent);
    return { agent, label: AGENTS[agent].label, aliases: AGENTS[agent].aliases, plannedModel: AGENTS[agent].plannedModel, mode: c.mode, model: c.model, configured: c.configured, message: c.message, realRuns: c.realRuns, instructionVersion: INSTRUCTION_VERSIONS[agent] };
  });
}

/**
 * Writes one immutable step snapshot for a run and returns it. The caller appends the finance.snapshot.captured event to the run's
 * own stream (investigation runs) or the account stream; this helper never patches an existing snapshot.
 */
export async function captureStep(ctx: MutationCtx, args: {
  runId: string; taskId: string; accountId: string | null; agent: AgentName; kind: RunStepKind; actor: OrchestratorActor; provenance: AgentRunProvenance;
  startedAt: number; input: unknown; output?: unknown | null; checkerVerdicts?: ClaimCheck[] | null; lockResults?: LockResult[] | null; message: string;
}): Promise<StepSnapshot> {
  const last = await ctx.db.query("financeStepSnapshots").withIndex("by_runId_and_stepIndex", q => q.eq("runId", args.runId)).order("desc").first();
  const stepIndex = last ? last.stepIndex + 1 : 0;
  const finishedAt = Date.now();
  const snapshot: StepSnapshot = {
    snapshotId: `${args.runId}:step:${stepIndex}`, runId: args.runId, taskId: args.taskId, accountId: args.accountId, agent: args.agent, stepIndex, kind: args.kind, actor: args.actor,
    model: args.provenance.model, mode: args.provenance.mode, instructionVersion: args.provenance.instructionVersion, startedAt: args.startedAt, finishedAt,
    input: args.input, output: args.output ?? null, checkerVerdicts: args.checkerVerdicts ?? null, lockResults: args.lockResults ?? null, message: args.message,
  };
  await ctx.db.insert("financeStepSnapshots", snapshot);
  return snapshot;
}

export async function stepsForRun(ctx: QueryCtx | MutationCtx, runId: string): Promise<Array<ReturnType<typeof recordOnly<Doc<"financeStepSnapshots">>>>> {
  return (await ctx.db.query("financeStepSnapshots").withIndex("by_runId_and_stepIndex", q => q.eq("runId", runId)).take(100)).map(recordOnly);
}

/**
 * Memory: the task's own clarifications plus every answer on the account (rows saved with accountId), newest first, bounded to 100.
 * Older rows without accountId are still found through their task.
 */
export async function accountClarifications(ctx: QueryCtx | MutationCtx, taskId: string, accountId: string | null, until: number) {
  const own = await ctx.db.query("financeClarifications").withIndex("by_taskId_and_timestamp", q => q.eq("taskId", taskId).lte("timestamp", until)).take(101);
  if (own.length > 100) throw new Error("Context exceeds the bounded development policy/clarification limit");
  const shared = accountId ? await ctx.db.query("financeClarifications").withIndex("by_accountId_and_timestamp", q => q.eq("accountId", accountId).lte("timestamp", until)).order("desc").take(100) : [];
  const seen = new Set(own.map(c => c.clarificationId));
  const rows = [...own, ...shared.filter(c => !seen.has(c.clarificationId))].sort((a, b) => a.timestamp - b.timestamp);
  return rows.slice(Math.max(0, rows.length - 100)).map(recordOnly);
}
