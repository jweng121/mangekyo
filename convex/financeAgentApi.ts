import { ConvexError, v } from "convex/values";
import type { FinanceAgentInput } from "@mangekyo/contracts";
import type { EvalCase } from "@mangekyo/contracts/orchestration";
import { mockInvestigation } from "@mangekyo/finance-core/agent";
import { agentNamed, INSTRUCTION_VERSIONS } from "@mangekyo/finance-core/agents";
import { replayIntakeCase, summarizeEval } from "@mangekyo/finance-core/eval";
import { usedPolicyLabel } from "@mangekyo/finance-core/policy";
import { mutation, query } from "./_generated/server";
import { applyCorrection } from "./financeInvestigations";
import { stepsForRun } from "./lib/agents";
import { publicRun, recordOnly } from "./lib/investigationRecords";
import * as money from "./lib/moneyValidators";
import * as orch from "./lib/orchestratorValidators";
import { claimCheck } from "./lib/validators";

/**
 * The contract for the visual audit and the desk (names fixed by agreement): getRunSteps, getSnapshot, getClaims, submitCorrection,
 * listPolicies, plus evaluateInstructions and listEvalCases. getAuditReport lives in financeAudit, getScorecard in financeScorecard and
 * listTaskEvents in finance. Everything here reads saved state or creates new linked attempts; nothing edits history.
 */

/** Every step of a run (any agent), oldest first, with the snapshot ID to fetch each frozen input and output. */
export const getRunSteps = query({
  args: { runId: v.string() }, returns: v.array(orch.runStep),
  handler: async (ctx, { runId }) => (await stepsForRun(ctx, runId)).map(s => ({ stepIndex: s.stepIndex, snapshotId: s.snapshotId, kind: s.kind, actor: s.actor, model: s.model, mode: s.mode, startedAt: s.startedAt, finishedAt: s.finishedAt, message: s.message })),
});

/** One immutable step snapshot: actor, model, mode, timestamps, exact frozen input, validated output, checker verdicts and lock results. */
export const getSnapshot = query({
  args: { snapshotId: v.string() }, returns: v.union(orch.stepSnapshot, v.null()),
  handler: async (ctx, { snapshotId }) => {
    const row = await ctx.db.query("financeStepSnapshots").withIndex("by_snapshotId", q => q.eq("snapshotId", snapshotId)).unique();
    return row ? recordOnly(row) : null;
  },
});

const claimsView = v.object({ runId: v.string(), agent: orch.agentName, status: v.union(v.literal("passed"), v.literal("rejected"), v.literal("not_checked")), checkerMode: v.union(orch.agentMode, v.literal("off")), claims: claimCheck.fields.claims });

/** The Evidence Checker's verdict on every claim of a run: intake runs and disbursement runs. */
export const getClaims = query({
  args: { runId: v.string() }, returns: v.union(claimsView, v.null()),
  handler: async (ctx, { runId }) => {
    const intake = await ctx.db.query("financeInvestigationRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique();
    if (intake) { const run = publicRun(intake); return { runId, agent: "intake" as const, status: run.claimCheck?.status ?? "not_checked" as const, checkerMode: run.claimCheck?.agentMode ?? "off" as const, claims: run.claimCheck?.claims ?? [] }; }
    const disbursement = await ctx.db.query("financeDisbursementRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique();
    if (disbursement) return { runId, agent: "disbursement" as const, status: disbursement.claimCheck?.status ?? "not_checked" as const, checkerMode: disbursement.claimCheck?.agentMode ?? "off" as const, claims: disbursement.claimCheck?.claims ?? [] };
    return null;
  },
});

/**
 * A person corrects a run at a step. Kinds: cite_clarification, checker_wrong, add_document, correct_input_field ({path, value}).
 * Creates a new linked attempt; the corrected run is never changed. Every correction becomes an eval case once the new attempt settles.
 */
export const submitCorrection = mutation({
  args: { runId: v.string(), stepIndex: v.number(), kind: orch.correctionKind, payload: v.record(v.string(), v.string()), reason: v.string(), actor: money.devIdentity },
  returns: v.object({ correctionId: v.string(), newRunId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    const steps = await stepsForRun(ctx, args.runId);
    if (steps.length && !steps.some(s => s.stepIndex === args.stepIndex)) throw new ConvexError(`Run ${args.runId} has no step ${args.stepIndex}.`);
    const result = await applyCorrection(ctx, { runId: args.runId, stepIndex: args.stepIndex, kind: args.kind, payload: args.payload, reason: args.reason, actor: args.actor, onlyCheckerStopped: false });
    return { correctionId: result.correctionId, newRunId: result.runId, created: result.created };
  },
});

export const listCorrections = query({
  args: { runId: v.optional(v.string()), taskId: v.optional(v.string()) }, returns: v.array(orch.runCorrection),
  handler: async (ctx, { runId, taskId }) => {
    if (runId) return (await ctx.db.query("financeRunCorrections").withIndex("by_runId", q => q.eq("runId", runId)).take(50)).map(recordOnly);
    if (taskId) return (await ctx.db.query("financeRunCorrections").withIndex("by_taskId", q => q.eq("taskId", taskId)).take(50)).map(recordOnly);
    return [];
  },
});

const policyView = v.object({ policyId: v.string(), version: v.string(), statement: v.string(), status: v.literal("approved"), accountId: v.string(), currency: v.string(), approvedAt: v.number(), approvedBy: v.union(v.string(), v.null()), fromRunId: v.union(v.string(), v.null()), sourceId: v.string(), usedLabel: v.string(), backtest: v.union(orch.policyBacktest, v.null()) });

/** Approved policies for an account with the label shown wherever one is used and the backtest recorded at approval. */
export const listPolicies = query({
  args: { accountId: v.string() }, returns: v.array(policyView),
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.query("financeAccounts").withIndex("by_accountId", q => q.eq("accountId", accountId)).unique();
    if (!account) return [];
    const policies = await ctx.db.query("financeApprovedPolicies").withIndex("by_accountId_and_currency_and_approvedAt", q => q.eq("accountId", accountId).eq("currency", account.currency)).take(100);
    const backtests = await ctx.db.query("financePolicyBacktests").withIndex("by_accountId", q => q.eq("accountId", accountId)).take(100);
    return policies.map(p => ({ policyId: p.policyId, version: p.version, statement: p.statement, status: "approved" as const, accountId: p.accountId, currency: p.currency, approvedAt: p.approvedAt, approvedBy: p.approvedBy ?? null, fromRunId: p.fromRunId ?? null, sourceId: p.sourceId, usedLabel: usedPolicyLabel(p), backtest: (() => { const b = backtests.find(b => b.policyId === p.policyId); return b ? recordOnly(b) : null; })() }));
  },
});

export const listEvalCases = query({
  args: { agent: v.string(), instructionVersion: v.optional(v.string()) }, returns: v.array(orch.evalCase),
  handler: async (ctx, args) => {
    const agent = agentNamed(args.agent);
    if (!agent) throw new ConvexError(`Unknown agent ${args.agent}.`);
    const version = args.instructionVersion ?? INSTRUCTION_VERSIONS[agent];
    return (await ctx.db.query("financeEvalCases").withIndex("by_agent_and_instructionVersion", q => q.eq("agent", agent).eq("instructionVersion", version)).take(200)).map(recordOnly);
  },
});

/** Replays every saved eval case for an agent through its mock and reports passed / failed / changed. The report is saved. */
export const evaluateInstructions = mutation({
  args: { agent: v.string(), instructionVersion: v.optional(v.string()) }, returns: orch.evalRun,
  handler: async (ctx, args) => {
    const agent = agentNamed(args.agent);
    if (!agent) throw new ConvexError(`Unknown agent ${args.agent}. Use intake, disbursement, evidence_checker, reconciler or auditor (old names work too).`);
    if (agent !== "intake") throw new ConvexError(`Eval cases are recorded for the Trust Intake agent only so far; ${agent} has none to replay.`);
    const version = args.instructionVersion ?? INSTRUCTION_VERSIONS[agent];
    const cases = (await ctx.db.query("financeEvalCases").withIndex("by_agent_and_instructionVersion", q => q.eq("agent", agent).eq("instructionVersion", version)).take(200)).map(recordOnly) as EvalCase[];
    const results = cases.map(c => replayIntakeCase(c, (input: FinanceAgentInput) => mockInvestigation(input)));
    const count = (await ctx.db.query("financeEvalRuns").withIndex("by_agent", q => q.eq("agent", agent)).take(1000)).length;
    const report = summarizeEval(`eval:${agent}:${version}:${count + 1}`, agent, version, results, Date.now());
    await ctx.db.insert("financeEvalRuns", report);
    return report;
  },
});

export const listEvalRuns = query({
  args: { agent: v.string() }, returns: v.array(orch.evalRun),
  handler: async (ctx, { agent: name }) => {
    const agent = agentNamed(name);
    if (!agent) return [];
    return (await ctx.db.query("financeEvalRuns").withIndex("by_agent", q => q.eq("agent", agent)).order("desc").take(50)).map(recordOnly);
  },
});
