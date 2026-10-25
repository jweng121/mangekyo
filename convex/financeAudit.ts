import { ConvexError, v } from "convex/values";
import type { LedgerEntry, MoneyProposal, ProposalTransition } from "@mangekyo/contracts";
import type { AuditFinding, AuditReport, OrchestratorActor } from "@mangekyo/contracts/orchestration";
import { FinanceProviderError } from "@mangekyo/finance-core/agent";
import { createAgentProvider } from "@mangekyo/finance-core/agents";
import { AUDIT_REPORT_FIELDS, AuditValidationError, auditReport, buildAuditInput, combineAuditFindings, DRILL_PLANTS, mockAuditorProvider, monthOf, scoreAudit, validateAuditOutput, type AuditInput } from "@mangekyo/finance-core/auditor";
import { demoAccountId } from "@mangekyo/finance-core/fixtures/demo-money";
import { lawFirmBundle } from "@mangekyo/finance-core/fixtures/law-firm";
import { lawId } from "@mangekyo/finance-core/fixtures/law-firm-feed";
import { monthEnd, monthlyReconciliation } from "@mangekyo/finance-core/monthly";
import { callWithRetry, parseProviderTimeoutMs, retryWriteConflicts } from "@mangekyo/finance-core/orchestrator";
import { internal } from "./_generated/api";
import { env, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { importBundle, nextDemoRun } from "./financeIntake";
import { providerMode } from "./financeInvestigations";
import { captureStep, configFor, provenanceFor } from "./lib/agents";
import { recordOnly } from "./lib/investigationRecords";
import { appendMoneyEvent, compact, loadAccount, outstandingMaxDays, requireAccount, resolveActor, type LoadedAccount } from "./lib/money";
import * as money from "./lib/moneyValidators";
import * as orch from "./lib/orchestratorValidators";
import { checkBudget, CODE_ACTOR, ensureOrchestration, findOrchestration, step, SYSTEM_ACTOR } from "./lib/orchestrator";
import { investigationError } from "./lib/validators";

/**
 * Trust Compliance Auditor and monthly reconciliation. The auditor reviews POSTED activity for a period against the trust rules and
 * writes an append-only report; it never changes money. A person signs off each month's reconciliation; the signed report is immutable.
 */

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const auditTaskId = (accountId: string, from: number, to: number) => `audit:${accountId}:${from}-${to}`;

async function transitionsFor(ctx: QueryCtx | MutationCtx, proposals: MoneyProposal[]): Promise<ProposalTransition[]> {
  const rows: ProposalTransition[] = [];
  for (const p of proposals.slice(0, 500)) rows.push(...(await ctx.db.query("financeProposalTransitions").withIndex("by_proposalId", q => q.eq("proposalId", p.proposalId)).take(50)).map(recordOnly));
  return rows;
}

async function signedMonths(ctx: QueryCtx | MutationCtx, accountId: string): Promise<string[]> {
  return [...new Set((await ctx.db.query("financeMonthlyReconciliations").withIndex("by_accountId_and_month", q => q.eq("accountId", accountId)).take(200)).filter(r => r.signedOff).map(r => r.month))];
}

async function auditInputFor(ctx: QueryCtx | MutationCtx, loaded: LoadedAccount, runId: string, from: number, to: number): Promise<AuditInput> {
  const transitions = await transitionsFor(ctx, loaded.proposals);
  return buildAuditInput({
    runId, accountId: loaded.state.account.accountId, currency: loaded.state.account.currency, period: { from, to },
    owners: loaded.state.owners.map(o => ({ ownerId: o.ownerId, sourceId: o.sourceId, name: o.name, ...(o.ownerKind ? { ownerKind: o.ownerKind } : {}) })),
    entries: loaded.state.entries, bankTransactions: loaded.state.bankTransactions, proposals: loaded.proposals, transitions,
    documents: loaded.documents.map(d => ({ sourceId: d.sourceId, title: d.title, namedOwnerSourceIds: d.namedOwnerSourceIds, ...(d.signed !== undefined ? { signed: d.signed } : {}), ...(d.matterId ? { matterId: d.matterId } : {}), ...(d.lines ? { lines: d.lines } : {}), ...(d.feeBasisPoints ? { feeBasisPoints: d.feeBasisPoints } : {}) })),
    invoices: loaded.obligations.filter(o => o.kind === "invoice"), disputes: loaded.state.disputes ?? [], signedMonths: await signedMonths(ctx, loaded.state.account.accountId),
  });
}

/** A person asks for an audit of a period. Mock mode answers inside this mutation; a paid mode runs in an action after a budget check. */
export const runAudit = mutation({
  args: { accountId: v.string(), from: v.number(), to: v.number(), dev: money.devIdentity },
  returns: v.object({ runId: v.string(), reportId: v.union(v.string(), v.null()), refused: v.optional(v.object({ code: v.string(), message: v.string() })) }),
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (!Number.isSafeInteger(args.from) || !Number.isSafeInteger(args.to) || args.from > args.to) throw new ConvexError("Choose a period with from <= to.");
    const loaded = await loadAccount(ctx, args.accountId);
    const config = configFor("auditor");
    if (!config.mode) throw new ConvexError(config.message);
    const taskId = auditTaskId(args.accountId, args.from, args.to);
    const now = Date.now();
    const person: OrchestratorActor = { type: "person", identity: actor.identity };
    let orchestration = await ensureOrchestration(ctx, { kind: "audit", taskId, accountId: args.accountId, subjectSourceId: null, trigger: "audit_requested", actor: person, reason: { code: "RECEIVED", message: `Audit of ${new Date(args.from).toISOString().slice(0, 10)} to ${new Date(args.to).toISOString().slice(0, 10)} requested.` } });
    const previous = await ctx.db.query("financeAuditRuns").withIndex("by_accountId", q => q.eq("accountId", args.accountId)).order("desc").take(50);
    const attempt = previous.filter(r => r.taskId === taskId).length + 1;
    if (previous.some(r => r.taskId === taskId && (r.status === "investigating" || r.status === "validating"))) throw new ConvexError("An audit of this period is already running.");
    if (orchestration.state === "investigating" || orchestration.state === "validating" || orchestration.state === "checking") orchestration = await step(ctx, orchestration, { to: "failed", trigger: "timeout", actor: SYSTEM_ACTOR, activeRunId: null, reason: { code: "STALE", message: "The previous audit run was no longer active." } });
    const budget = await checkBudget(ctx, taskId, config.realRuns, now);
    orchestration = await step(ctx, orchestration, { kind: "budget_check", to: orchestration.state, trigger: "audit_requested", actor: CODE_ACTOR, reason: { code: budget.code, message: budget.message }, budget });
    if (!budget.allowed) { await step(ctx, orchestration, { to: "needs_person", trigger: "budget_refused", actor: CODE_ACTOR, reason: { code: budget.code, message: budget.message }, budget }); return { runId: "", reportId: null, refused: { code: budget.code, message: budget.message } }; }
    const runId = `${taskId}:audit:${attempt}`;
    const input = await auditInputFor(ctx, loaded, runId, args.from, args.to);
    const provenance = provenanceFor("auditor");
    await ctx.db.insert("financeAuditRuns", { runId, orchestrationId: orchestration.orchestrationId, taskId, accountId: args.accountId, period: { from: args.from, to: args.to }, provenance, status: "investigating", input, output: null, reportId: null, error: null, externalRunId: null, retries: 0, deadline: now + RUN_TIMEOUT_MS, requestedBy: actor.identity, createdAt: now, updatedAt: now });
    if (config.realRuns) await ctx.db.insert("financeRealRuns", { runId, taskId, accountId: args.accountId, provider: "auditor", day: new Date(now).toISOString().slice(0, 10), at: now });
    await step(ctx, orchestration, { to: "investigating", trigger: "audit_requested", actor: person, runId, activeRunId: runId, reason: { code: "ATTEMPT_STARTED", message: `Auditor ${config.mode} (${provenance.model}) reviews ${input.entries.length} posted entries; code found ${input.codeFindings.length} finding(s) first.` } });
    await captureStep(ctx, { runId, taskId, accountId: args.accountId, agent: "auditor", kind: "input_frozen", actor: person, provenance, startedAt: now, input, message: `Exactly what the Trust Compliance Auditor is given, including code's ${input.codeFindings.length} finding(s).` });
    if (config.mode === "mock") {
      const execution = await mockAuditorProvider.start(input);
      if (execution.status !== "completed") throw new Error("The mock auditor always completes");
      const reportId = await settleAudit(ctx, (await ctx.db.query("financeAuditRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique())!, execution.externalRunId, JSON.stringify(execution.output));
      return { runId, reportId };
    }
    await ctx.scheduler.runAfter(0, internal.financeAudit.execute, { runId });
    return { runId, reportId: null };
  },
});

export const getAuditRun = internalQuery({
  args: { runId: v.string() }, returns: v.union(orch.auditRun, v.null()),
  handler: async (ctx, { runId }) => { const run = await ctx.db.query("financeAuditRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique(); return run ? recordOnly(run) : null; },
});

export const execute = internalAction({
  args: { runId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const run = await ctx.runQuery(internal.financeAudit.getAuditRun, { runId });
    if (!run || run.status !== "investigating") return null;
    const timeoutMs = parseProviderTimeoutMs(env.PROVIDER_TIMEOUT_MS);
    const failure = (error: unknown) => error instanceof FinanceProviderError ? { code: error.code, message: error.message, retryable: error.retryable } : { code: "provider_failure", message: "The auditor failed unexpectedly.", retryable: false };
    try {
      const config = configFor("auditor");
      const provider = createAgentProvider<AuditInput>(config, mockAuditorProvider, AUDIT_REPORT_FIELDS, { timeoutMs });
      let execution = await callWithRetry(() => provider.start(run.input as AuditInput), { timeoutMs, phase: "start", paid: config.realRuns === 1, onRetry: async () => false });
      while (execution.status === "pending") {
        if (Date.now() >= run.deadline) throw new FinanceProviderError("provider_timeout", "The auditor did not finish before the run deadline.");
        await new Promise(resolve => setTimeout(resolve, 3000));
        execution = await provider.poll(execution.externalRunId);
      }
      if (execution.status === "failed") throw new FinanceProviderError(execution.error.code, execution.error.message);
      await retryWriteConflicts(() => ctx.runMutation(internal.financeAudit.recordResult, { runId, externalRunId: execution.externalRunId, outputJson: JSON.stringify(execution.output) }));
    } catch (error) {
      await retryWriteConflicts(() => ctx.runMutation(internal.financeAudit.recordFailure, { runId, error: failure(error) }));
    }
    return null;
  },
});

export const recordFailure = internalMutation({
  args: { runId: v.string(), error: investigationError }, returns: v.null(),
  handler: async (ctx, { runId, error }) => {
    const run = await ctx.db.query("financeAuditRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique();
    if (!run || (run.status !== "investigating" && run.status !== "validating")) return null;
    await ctx.db.patch("financeAuditRuns", run._id, { status: "failed", error, updatedAt: Date.now() });
    const orchestration = await findOrchestration(ctx, run.taskId);
    if (orchestration) await step(ctx, orchestration, { to: "failed", trigger: error.code === "validation_failed" ? "validation_failed" : "provider_error", actor: SYSTEM_ACTOR, runId, activeRunId: null, error, reason: { code: error.code, message: `Failed, needs a person: ${error.message}` } });
    return null;
  },
});

export const recordResult = internalMutation({
  args: { runId: v.string(), externalRunId: v.string(), outputJson: v.string() }, returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const run = await ctx.db.query("financeAuditRuns").withIndex("by_runId", q => q.eq("runId", args.runId)).unique();
    if (!run || run.status !== "investigating") return null;
    return await settleAudit(ctx, run, args.externalRunId, args.outputJson);
  },
});

/** Validates the auditor's answer (never repaired), combines it with code's findings and writes the append-only report. */
async function settleAudit(ctx: MutationCtx, run: Doc<"financeAuditRuns">, externalRunId: string, outputJson: string): Promise<string | null> {
  const input = run.input as AuditInput;
  const orchestration = (await findOrchestration(ctx, run.taskId))!;
  const answeredAt = run.updatedAt;
  await ctx.db.patch("financeAuditRuns", run._id, { status: "validating", externalRunId, updatedAt: Date.now() });
  const agent: OrchestratorActor = { type: "agent", identity: `agent:auditor:${run.provenance.mode}` };
  await step(ctx, orchestration, { to: "validating", trigger: "provider_result", actor: agent, runId: run.runId, reason: { code: "ANSWER_RECEIVED", message: "The auditor answered; validating every finding's citations." } });
  let output;
  try {
    if (outputJson.length > 200_000) throw new Error("too large");
    output = validateAuditOutput(JSON.parse(outputJson) as unknown, input);
  } catch (error) {
    const details = error instanceof AuditValidationError ? error.details : [{ path: "$", reason: "Output must be one raw JSON object within the supported size." }];
    const failure = { code: "validation_failed", message: "The auditor's answer failed validation. Code's findings stand but no report was written.", retryable: false, details };
    await ctx.db.patch("financeAuditRuns", run._id, { status: "failed", error: failure, updatedAt: Date.now() });
    await step(ctx, orchestration, { to: "failed", trigger: "validation_failed", actor: CODE_ACTOR, runId: run.runId, activeRunId: null, error: failure, reason: { code: failure.code, message: `Failed, needs a person: ${failure.message}` } });
    return null;
  }
  const findings: AuditFinding[] = combineAuditFindings(input.codeFindings, output);
  const now = Date.now();
  const reportId = `${run.runId}:report`;
  const report: AuditReport = auditReport({ reportId, input, findings, summary: output.summary, mode: run.provenance.mode, model: run.provenance.model, generatedAt: now, generatedBy: run.requestedBy });
  await ctx.db.insert("financeAuditReports", report);
  await ctx.db.patch("financeAuditRuns", run._id, { status: "needs_person", output, reportId, updatedAt: now });
  await captureStep(ctx, { runId: run.runId, taskId: run.taskId, accountId: run.accountId, agent: "auditor", kind: "output_validated", actor: agent, provenance: run.provenance, startedAt: answeredAt, input, output: report, message: `${report.status}: ${findings.length} finding(s).` });
  await step(ctx, orchestration, { to: "needs_person", trigger: "checker_result", actor: CODE_ACTOR, runId: run.runId, activeRunId: null, reason: { code: report.status === "clean" ? "AUDIT_CLEAN" : "AUDIT_FINDINGS", message: `Audit report ${reportId}: ${findings.length} finding(s) (${findings.filter(f => f.foundBy === "code").length} by code, ${findings.filter(f => f.foundBy === "agent").length} added by the agent). A person reads it; nothing moved.` } });
  await appendMoneyEvent(ctx, { accountId: run.accountId, type: "finance.money.audit_completed", actor: { identity: run.requestedBy, authenticated: false, role: "approver" }, operationId: reportId, stage: "audit", message: `Trust compliance audit ${reportId} (${run.provenance.mode}, ${run.provenance.model}): ${report.summary}`, sourceIds: findings.flatMap(f => f.entryIds).slice(0, 50) });
  return reportId;
}

/** The latest audit report for an account, or one by ID. */
export const getAuditReport = query({
  args: { accountId: v.string(), reportId: v.optional(v.string()) }, returns: v.union(orch.auditReport, v.null()),
  handler: async (ctx, { accountId, reportId }) => {
    const row = reportId ? await ctx.db.query("financeAuditReports").withIndex("by_reportId", q => q.eq("reportId", reportId)).unique()
      : await ctx.db.query("financeAuditReports").withIndex("by_accountId", q => q.eq("accountId", accountId)).order("desc").first();
    return row && row.accountId === accountId ? recordOnly(row) : null;
  },
});

export const listAuditReports = query({
  args: { accountId: v.string() }, returns: v.array(orch.auditReport),
  handler: async (ctx, { accountId }) => (await ctx.db.query("financeAuditReports").withIndex("by_accountId", q => q.eq("accountId", accountId)).order("desc").take(20)).map(recordOnly),
});

/* ---------- Auditor drill: four mistakes planted in posted history ---------- */

const RILEY = "dev-unverified:riley";
const SAM = "dev-unverified:sam";

/** Plants four mistakes directly into a fresh law-firm account's posted history, runs the mock audit, and returns the account for scoring. */
export const runAuditorDrill = mutation({
  args: {}, returns: v.object({ accountId: v.string(), reportId: v.union(v.string(), v.null()), scorecardId: v.string() }),
  handler: async (ctx) => {
    if (providerMode() !== "mock" || configFor("auditor").mode !== "mock") throw new ConvexError("The auditor drill runs only in mock mode.");
    const accountId = demoAccountId(await nextDemoRun(ctx));
    const id = (suffix: string) => lawId(accountId, suffix);
    await importBundle(ctx, lawFirmBundle(accountId), "demo");
    const t0 = Date.now() - 3 * 86_400_000;
    const base = { accountId, currency: "USD", status: "posted" as const };
    const proposal = async (p: Omit<MoneyProposal, "accountId" | "currency" | "createdAt" | "updatedAt" | "origin">, approvedBy: string, approvedAt: number) => {
      const row: MoneyProposal = { ...p, accountId, currency: "USD", origin: { type: "person" }, createdAt: approvedAt - 1000, updatedAt: approvedAt, approvedBy, approvalId: `${p.proposalId}:transition:2` };
      await ctx.db.insert("financeProposals", compact(row));
      await ctx.db.insert("financeProposalTransitions", { transitionId: `${p.proposalId}:transition:2`, proposalId: p.proposalId, accountId, from: "pending_approval", to: "approved", actor: approvedBy, reason: null, lock: null, at: approvedAt });
      await ctx.db.insert("financeProposalTransitions", { transitionId: `${p.proposalId}:transition:3`, proposalId: p.proposalId, accountId, from: "approved", to: "posted", actor: approvedBy, reason: null, lock: null, at: approvedAt + 1 });
    };
    const entry = async (e: Omit<LedgerEntry, "accountId" | "currency" | "status">) => ctx.db.insert("financeLedgerEntries", compact({ ...base, ...e }));
    // 1. Self-approved: riley requested, approved and posted her own $1,500 payment for Westbrook HOA.
    await proposal({ proposalId: `${accountId}:pay:drill-1`, kind: "payment", status: "posted", requestedBy: RILEY, evidenceSourceIds: [id("document:westbrook-settlement:v1")], ownerId: id("owner:westbrook"), amountCents: 150_000, purpose: "Westbrook HOA filing fees (drill)", postedEntryIds: ["drill:self-approved:entry:1"] }, RILEY, t0);
    await entry({ entryId: "drill:self-approved:entry:1", ownerId: id("owner:westbrook"), amountCents: -150_000, kind: "disbursement", sourceRefs: [id("document:westbrook-settlement:v1")], proposalId: `${accountId}:pay:drill-1`, approvalId: `${accountId}:pay:drill-1:transition:2`, bankReference: `PAY:${accountId}:pay:drill-1`, memo: "Westbrook HOA filing fees (drill)", effectiveAt: t0, createdAt: t0, createdBy: RILEY });
    // 2. Payout before funds cleared: Harborline's $85,000 check is still pending, yet $56,000 went to Maria Delgado.
    const deposit = id("bank:txn:drill-harborline");
    await ctx.db.insert("financeBankTransactions", { sourceId: deposit, accountId, subAccount: "IOLTA", direction: "inflow", amountCents: 8_500_000, currency: "USD", bookedAt: t0 + 1000, clearing: "pending", reference: "Claim HL-44812", counterparty: "Harborline Insurance", ownerHintSourceId: null, documentSourceIds: [id("document:delgado-settlement:v1")], duplicateOfSourceId: null, raw: { system: "demo", recordType: "bank-transaction", rawId: "drill-harborline", datasetVersion: "law-firm-demo-v1" } });
    await entry({ entryId: `import:${deposit}`, ownerId: null, amountCents: 8_500_000, kind: "deposit_received", sourceRefs: [deposit], fundsSourceId: deposit, memo: "Deposit received from bank feed; unallocated", effectiveAt: t0 + 1000, createdAt: t0 + 1000, createdBy: "import:demo-adapter" });
    await proposal({ proposalId: `${accountId}:alloc:drill-2`, kind: "allocation", status: "posted", requestedBy: RILEY, evidenceSourceIds: [deposit, id("document:delgado-settlement:v1")], bankSourceId: deposit, shares: [{ ownerId: id("owner:maria-delgado"), amountCents: 8_500_000 }], amountCents: 8_500_000, purpose: "Delgado settlement (drill)", postedEntryIds: ["drill:alloc:entry:1", "drill:alloc:entry:2"] }, SAM, t0 + 2000);
    await entry({ entryId: "drill:alloc:entry:1", ownerId: null, amountCents: -8_500_000, kind: "allocation", sourceRefs: [deposit], fundsSourceId: deposit, proposalId: `${accountId}:alloc:drill-2`, approvalId: `${accountId}:alloc:drill-2:transition:2`, memo: "Allocate to Maria Delgado", effectiveAt: t0 + 2000, createdAt: t0 + 2000, createdBy: SAM });
    await entry({ entryId: "drill:alloc:entry:2", ownerId: id("owner:maria-delgado"), amountCents: 8_500_000, kind: "allocation", sourceRefs: [deposit], fundsSourceId: deposit, proposalId: `${accountId}:alloc:drill-2`, approvalId: `${accountId}:alloc:drill-2:transition:2`, memo: "Delgado settlement (drill)", effectiveAt: t0 + 2000, createdAt: t0 + 2000, createdBy: SAM });
    await proposal({ proposalId: `${accountId}:pay:drill-2`, kind: "payment", status: "posted", requestedBy: RILEY, evidenceSourceIds: [id("document:delgado-settlement:v1")], ownerId: id("owner:maria-delgado"), amountCents: 5_600_000, purpose: "Delgado client share (drill)", payoutKind: "client_share", fundingSourceId: deposit, postedEntryIds: ["drill:uncleared:entry:1"] }, SAM, t0 + 3000);
    await entry({ entryId: "drill:uncleared:entry:1", ownerId: id("owner:maria-delgado"), amountCents: -5_600_000, kind: "disbursement", sourceRefs: [id("document:delgado-settlement:v1")], proposalId: `${accountId}:pay:drill-2`, approvalId: `${accountId}:pay:drill-2:transition:2`, bankReference: `PAY:${accountId}:pay:drill-2`, memo: "Delgado client share (drill)", effectiveAt: t0 + 3000, createdAt: t0 + 3000, createdBy: SAM });
    // 3. Fee taken with no invoice: $3,000 attorney fee from Chen & Park to the firm, approved by sam, with nothing earning it.
    await proposal({ proposalId: `${accountId}:pay:drill-3`, kind: "payment", status: "posted", requestedBy: RILEY, evidenceSourceIds: [id("owner-record:chen-park")], ownerId: id("owner:chen-park"), payeeOwnerId: id("owner:firm"), amountCents: 300_000, purpose: "Chen & Park attorney fee (drill)", payoutKind: "attorney_fee", postedEntryIds: ["drill:fee:entry:1"] }, SAM, t0 + 4000);
    await entry({ entryId: "drill:fee:entry:1", ownerId: id("owner:chen-park"), amountCents: -300_000, kind: "fee", sourceRefs: [id("owner-record:chen-park")], proposalId: `${accountId}:pay:drill-3`, approvalId: `${accountId}:pay:drill-3:transition:2`, bankReference: `PAY:${accountId}:pay:drill-3`, memo: "Attorney fee to the firm (drill)", effectiveAt: t0 + 4000, createdAt: t0 + 4000, createdBy: SAM });
    // 4. Unlinked reversal: a $1,200 reversal for James Nguyen that names an entry nobody can find.
    await entry({ entryId: "drill:reversal:entry:1", ownerId: id("owner:james-nguyen"), amountCents: 120_000, kind: "reversal", reversesEntryId: "drill:ghost-entry", sourceRefs: [id("owner-record:james-nguyen")], approvalId: "drill:reversal:approval", memo: "Reversal: refund of case fees (drill)", effectiveAt: t0 + 5000, createdAt: t0 + 5000, createdBy: SAM });
    const scorecardId = `${accountId}:scorecard:audit_drill`;
    await ctx.db.insert("financeScorecards", { scorecardId, accountId, kind: "audit_drill", count: DRILL_PLANTS.length, startedAt: Date.now() });
    await appendMoneyEvent(ctx, { accountId, type: "finance.money.import_completed", actor: { identity: "system:finance-money", authenticated: false, role: "system" }, operationId: scorecardId, stage: "audit_drill", message: `Auditor drill: ${DRILL_PLANTS.length} mistakes planted in posted history: ${DRILL_PLANTS.map(p => p.label).join(", ")}.` });
    // The audit itself, as sam, over the drill period.
    const audit = await auditFor(ctx, accountId, t0 - 1000, Date.now(), SAM);
    return { accountId, reportId: audit.reportId, scorecardId };
  },
});

/** Runs a mock audit inside a mutation on behalf of a named person (used by the drill). */
async function auditFor(ctx: MutationCtx, accountId: string, from: number, to: number, identity: string): Promise<{ runId: string; reportId: string | null }> {
  const loaded = await loadAccount(ctx, accountId);
  const taskId = auditTaskId(accountId, from, to);
  const now = Date.now();
  const person: OrchestratorActor = { type: "person", identity };
  let orchestration = await ensureOrchestration(ctx, { kind: "audit", taskId, accountId, subjectSourceId: null, trigger: "audit_requested", actor: person, reason: { code: "RECEIVED", message: "Audit requested (drill)." } });
  orchestration = await step(ctx, orchestration, { kind: "budget_check", to: orchestration.state, trigger: "audit_requested", actor: CODE_ACTOR, reason: { code: "BUDGET_NOT_APPLICABLE", message: "Mock runs don't count against the real-run budget." } });
  const runId = `${taskId}:audit:1`;
  const input = await auditInputFor(ctx, loaded, runId, from, to);
  const provenance = provenanceFor("auditor");
  await ctx.db.insert("financeAuditRuns", { runId, orchestrationId: orchestration.orchestrationId, taskId, accountId, period: { from, to }, provenance, status: "investigating", input, output: null, reportId: null, error: null, externalRunId: null, retries: 0, deadline: now + RUN_TIMEOUT_MS, requestedBy: identity, createdAt: now, updatedAt: now });
  await step(ctx, orchestration, { to: "investigating", trigger: "audit_requested", actor: person, runId, activeRunId: runId, reason: { code: "ATTEMPT_STARTED", message: `Auditor mock reviews ${input.entries.length} posted entries.` } });
  await captureStep(ctx, { runId, taskId, accountId, agent: "auditor", kind: "input_frozen", actor: person, provenance, startedAt: now, input, message: "Exactly what the auditor is given." });
  const execution = await mockAuditorProvider.start(input);
  if (execution.status !== "completed") throw new Error("The mock auditor always completes");
  const reportId = await settleAudit(ctx, (await ctx.db.query("financeAuditRuns").withIndex("by_runId", q => q.eq("runId", runId)).unique())!, execution.externalRunId, JSON.stringify(execution.output));
  return { runId, reportId };
}

const scorecardView = v.object({
  accountId: v.string(), reportId: v.union(v.string(), v.null()), planted: v.array(v.object({ key: v.string(), label: v.string(), entryId: v.string(), ruleId: orch.auditRuleId, status: v.union(v.literal("caught"), v.literal("missed")) })),
  caught: v.number(), missed: v.number(), falseAlarms: v.number(), falseAlarmFindings: v.array(v.object({ findingId: v.string(), ruleId: orch.auditRuleId, message: v.string() })), line: v.string(),
});

/** Caught / missed / false alarms for the auditor drill on an account. Null when the account isn't a drill. */
export const getAuditorScorecard = query({
  args: { accountId: v.string() }, returns: v.union(scorecardView, v.null()),
  handler: async (ctx, { accountId }) => {
    const card = await ctx.db.query("financeScorecards").withIndex("by_accountId", q => q.eq("accountId", accountId)).first();
    if (!card || card.kind !== "audit_drill") return null;
    const report = await ctx.db.query("financeAuditReports").withIndex("by_accountId", q => q.eq("accountId", accountId)).order("desc").first();
    return scoreAudit(accountId, report ? recordOnly(report) : null);
  },
});

/* ---------- Monthly reconciliation ---------- */

/** Bank, books, each client ledger and the reconciling items at a month's end, computed by code, with the person's sign-off if any. */
export const monthlyReconciliationReport = query({
  args: { accountId: v.string(), month: v.string() }, returns: orch.monthlyReport,
  handler: async (ctx, { accountId, month }) => {
    const signed = await ctx.db.query("financeMonthlyReconciliations").withIndex("by_accountId_and_month", q => q.eq("accountId", accountId).eq("month", month)).order("desc").first();
    if (signed) return recordOnly(signed);
    const loaded = await loadAccount(ctx, accountId);
    const periodEnd = monthEnd(month);
    const report = monthlyReconciliation(loaded.state, month, { outstandingMaxDays: outstandingMaxDays(), now: Math.max(periodEnd, loaded.state.account.openingAsOf) });
    return { ...report, reportId: `${accountId}:monthly:${month}:unsigned`, signedOff: null };
  },
});

/** Approver only: signs off the month. The report is saved exactly as computed at that moment and never edited. */
export const signOffMonthlyReconciliation = mutation({
  args: { accountId: v.string(), month: v.string(), note: v.optional(v.string()), dev: money.devIdentity }, returns: orch.monthlyReport,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (actor.role !== "approver") throw new ConvexError("Switch to the approver role to sign off a monthly reconciliation.");
    await requireAccount(ctx, args.accountId);
    const existing = await ctx.db.query("financeMonthlyReconciliations").withIndex("by_accountId_and_month", q => q.eq("accountId", args.accountId).eq("month", args.month)).first();
    if (existing) throw new ConvexError(`${args.month} is already signed off by ${existing.signedOff?.by}.`);
    const note = args.note?.trim() || null;
    if (note && note.length > 2000) throw new ConvexError("The note can be at most 2000 characters.");
    const loaded = await loadAccount(ctx, args.accountId);
    const periodEnd = monthEnd(args.month);
    if (periodEnd > Date.now()) throw new ConvexError("A month can be signed off only after it ends.");
    const now = Date.now();
    const report = { ...monthlyReconciliation(loaded.state, args.month, { outstandingMaxDays: outstandingMaxDays(), now: periodEnd }), reportId: `${args.accountId}:monthly:${args.month}`, signedOff: { by: actor.identity, at: now, note } };
    if (report.threeWay.status !== "matched") throw new ConvexError(`The three-way check for ${args.month} is ${report.threeWay.status}; resolve the causes before signing off.`);
    await ctx.db.insert("financeMonthlyReconciliations", report);
    await appendMoneyEvent(ctx, { accountId: args.accountId, type: "finance.money.lock_checked", actor, operationId: report.reportId, stage: "monthly_signoff", message: `${actor.identity} signed off the ${args.month} reconciliation: bank ${report.bank.adjustedCents}, books ${report.bookCents}, ${report.clientLedgers.length} ledgers, ${report.reconcilingItems.length} reconciling item(s).${note ? ` Note: ${note}` : ""}`, sourceIds: [report.reportId] });
    return report;
  },
});

export const listMonthlyReconciliations = query({
  args: { accountId: v.string() }, returns: v.array(orch.monthlyReport),
  handler: async (ctx, { accountId }) => (await ctx.db.query("financeMonthlyReconciliations").withIndex("by_accountId_and_month", q => q.eq("accountId", accountId)).take(120)).map(recordOnly),
});

export { monthOf };
