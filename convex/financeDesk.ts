import { v } from "convex/values";
import type { AnyFinanceEvent, FinanceInvestigationRun } from "@mangekyo/contracts";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import * as validators from "./lib/validators";
import { recordOnly } from "./lib/investigationRecords";

/** Read-only views for the operator desk. No writes; the desk acts through the existing mutations. */

function publicRun(row: Doc<"financeInvestigationRuns">): FinanceInvestigationRun {
  const { executionClaimed, pollCount, deadline, ...run } = recordOnly(row);
  return run as FinanceInvestigationRun;
}

const runSummary = v.object({
  runId: v.string(), taskId: v.string(), attempt: v.number(), parentRunId: v.union(v.string(), v.null()), status: validators.investigationStatus,
  mode: validators.mode, simulated: v.boolean(), createdAt: v.number(), updatedAt: v.number(),
  outcome: v.union(v.literal("findings"), v.literal("needs_information"), v.literal("proposal_ready"), v.null()), summary: v.union(v.string(), v.null()),
});
function summarize(run: FinanceInvestigationRun) {
  return { runId: run.runId, taskId: run.taskId, attempt: run.attempt, parentRunId: run.parentRunId, status: run.status, mode: run.mode, simulated: run.simulated,
    createdAt: run.createdAt, updatedAt: run.updatedAt, outcome: run.result?.outcome ?? null, summary: run.result?.summary ?? null };
}

export const getDeskData = query({
  args: { accountId: v.string() },
  returns: v.object({
    tasks: v.array(v.object({ taskId: v.string(), bankSourceId: v.union(v.string(), v.null()), status: v.string(), latestRun: v.union(runSummary, v.null()) })),
    questions: v.array(v.object({ questionId: v.string(), runId: v.string(), taskId: v.string(), bankSourceId: v.union(v.string(), v.null()), question: v.string(), sourceRefs: v.array(v.string()) })),
    policies: v.array(v.object({ policyId: v.string(), runId: v.string(), statement: v.string(), sourceRefs: v.array(v.string()) })),
    activity: v.array(validators.event),
    counts: v.object({ autoStarted: v.number(), blocked: v.number(), posted: v.number() }),
  }),
  handler: async (ctx, { accountId }) => {
    const tasks = await ctx.db.query("financeTasks").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(100);
    const taskRows = [];
    const questions = [];
    const policies = [];
    const taskEvents: AnyFinanceEvent[] = [];
    for (const task of tasks) {
      const latest = await ctx.db.query("financeInvestigationRuns").withIndex("by_taskId_and_attempt", (q) => q.eq("taskId", task.taskId)).order("desc").first();
      const run = latest ? publicRun(latest) : null;
      taskRows.push({ taskId: task.taskId, bankSourceId: task.bankSourceId ?? null, status: task.status, latestRun: run ? summarize(run) : null });
      const open = (await ctx.db.query("financeInvestigationQuestions").withIndex("by_taskId", (q) => q.eq("taskId", task.taskId)).take(50)).filter(row => row.status === "open");
      questions.push(...open.map(row => ({ questionId: row.questionId, runId: row.runId, taskId: row.taskId, bankSourceId: task.bankSourceId ?? null, question: row.question, sourceRefs: row.sourceRefs })));
      if (run?.result) policies.push(...run.result.candidatePolicies.map(p => ({ policyId: p.policyId, runId: run.runId, statement: p.statement, sourceRefs: p.sourceRefs })));
      const events = await ctx.db.query("financeEvents").withIndex("by_taskId_and_sequence", (q) => q.eq("taskId", task.taskId)).order("desc").take(15);
      taskEvents.push(...events.map(recordOnly) as AnyFinanceEvent[]);
    }
    const money = (await ctx.db.query("financeEvents").withIndex("by_taskId_and_sequence", (q) => q.eq("taskId", `money:${accountId}`)).order("desc").take(1000)).map(recordOnly) as AnyFinanceEvent[];
    const proposals = await ctx.db.query("financeProposals").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(2000);
    const autoStarted = money.filter(e => e.type === "finance.money.auto_investigation" && e.payload.allowed === true).length;
    const activity = [...money.slice(0, 60), ...taskEvents].sort((a, b) => b.timestamp - a.timestamp || b.sequence - a.sequence).slice(0, 60);
    return {
      tasks: taskRows, questions, policies, activity,
      counts: { autoStarted, blocked: proposals.filter(p => p.status === "blocked").length, posted: proposals.filter(p => p.status === "posted").length },
    };
  },
});

const step = v.object({ sequence: v.number(), eventId: v.string(), snapshotId: v.union(v.string(), v.null()), type: v.string(), timestamp: v.number(), message: v.string(), status: v.union(v.string(), v.null()) });

/** One run with every attempt for the same deposit (all kept) and its frozen steps. */
export const getRunView = query({
  args: { runId: v.string() },
  returns: v.union(v.null(), v.object({
    run: validators.run, runs: v.array(runSummary), steps: v.array(step), accountId: v.union(v.string(), v.null()), bankSourceId: v.union(v.string(), v.null()),
    clarifications: v.array(validators.clarification),
  })),
  handler: async (ctx, { runId }) => {
    const row = await ctx.db.query("financeInvestigationRuns").withIndex("by_runId", (q) => q.eq("runId", runId)).unique();
    if (!row) return null;
    const run = publicRun(row);
    const task = await ctx.db.query("financeTasks").withIndex("by_taskId", (q) => q.eq("taskId", run.taskId)).unique();
    const runs = (await ctx.db.query("financeInvestigationRuns").withIndex("by_taskId_and_attempt", (q) => q.eq("taskId", run.taskId)).take(50)).map(r => summarize(publicRun(r)));
    const events = (await ctx.db.query("financeEvents").withIndex("by_taskId_and_sequence", (q) => q.eq("taskId", run.taskId)).take(500)).filter(e => e.runId === runId);
    const snapshots = (await ctx.db.query("financeSnapshots").withIndex("by_taskId_and_sequence", (q) => q.eq("taskId", run.taskId)).take(500)).filter(s => s.runId === runId);
    const steps = events.map(e => {
      const snapshot = snapshots.find(s => s.eventId === e.eventId);
      const message = "payload" in e && "message" in e.payload ? e.payload.message : "";
      const status = snapshot && "output" in snapshot && "investigationStatus" in snapshot.output ? snapshot.output.investigationStatus : null;
      return { sequence: e.sequence, eventId: e.eventId, snapshotId: snapshot?.snapshotId ?? null, type: e.type, timestamp: e.timestamp, message, status };
    });
    const clarifications = (await ctx.db.query("financeClarifications").withIndex("by_taskId_and_timestamp", (q) => q.eq("taskId", run.taskId)).take(100)).map(recordOnly);
    return { run, runs, steps, accountId: task?.accountId ?? null, bankSourceId: task?.bankSourceId ?? null, clarifications };
  },
});
