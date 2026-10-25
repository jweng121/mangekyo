import { ConvexError, v, type Infer } from "convex/values";
import type { FinanceAgentInput, InvestigationScope, LedgerEntry, MoneyProposal, NormalizedAccountBundle, NormalizedBankTransaction } from "@mangekyo/contracts";
import type { AgentName, OrchestratorActor } from "@mangekyo/contracts/orchestration";
import { FinanceProviderError, INVESTIGATION_REPORT_FIELDS, mockFinanceAgentProvider, validateFinanceAgentOutput, type ProviderExecution } from "@mangekyo/finance-core/agent";
import { agentEnvNames, createAgentProvider, type AgentProvider } from "@mangekyo/finance-core/agents";
import { AUDIT_REPORT_FIELDS, combineAuditFindings, validateAuditOutput, type AuditInput } from "@mangekyo/finance-core/auditor";
import { buildCheckerInput, codeCheckClaims, finalizeClaimCheck, validateCheckerOutput, type CheckerInput } from "@mangekyo/finance-core/checker";
import { buildDisbursementInput, DISBURSEMENT_REPORT_FIELDS, validateDisbursementOutput, type DisbursementInput } from "@mangekyo/finance-core/disbursement";
import { demoAccountId } from "@mangekyo/finance-core/fixtures/demo-money";
import { lawFirmBundle } from "@mangekyo/finance-core/fixtures/law-firm";
import { lawFirmFeedBundle, lawId } from "@mangekyo/finance-core/fixtures/law-firm-feed";
import { buildPostingEntries } from "@mangekyo/finance-core/gateway";
import { buildDepositRecordSet, depositCaseId } from "@mangekyo/finance-core/intake";
import { activeAllocations } from "@mangekyo/finance-core/ledger";
import { parseProviderTimeoutMs, retryWriteConflicts } from "@mangekyo/finance-core/orchestrator";
import { buildReconciliationInput, RECON_REPORT_FIELDS, reconcilableCauses, validateReconciliationOutput, type ReconciliationInput } from "@mangekyo/finance-core/reconciliation";
import { internal } from "./_generated/api";
import { env, internalAction, internalMutation } from "./_generated/server";
import { auditInputFrom, drillHistory } from "./financeAudit";
import { depositTaskId, importBundle, nextDemoRun } from "./financeIntake";
import { buildIntakeInput } from "./financeInvestigations";
import { matterOf } from "./financeTrust";
import { captureStep, configFor, provenanceFor } from "./lib/agents";
import { appendMoneyEvent, checkAccount, loadAccount, type LoadedAccount } from "./lib/money";
import { checkBudget } from "./lib/orchestrator";

/**
 * Real-agent smoke test. One call of one agent, in the mode its <AGENT>_MODE says (creao or external only), on that agent's normal
 * frozen input for a fixed law-firm case on a fresh DEMO account. The answer goes through the agent's normal strict validator and is
 * returned; it is never checked further, queued or posted. The scenario on top of the imported fixture (an allocation, a returned
 * check, the drill's history) exists only in the frozen input, so the account's ledger holds import entries only and nothing starts on it.
 */

const agentName = v.union(v.literal("intake"), v.literal("disbursement"), v.literal("evidence_checker"), v.literal("reconciler"), v.literal("auditor"));
const SMOKE_ACTOR: OrchestratorActor = { type: "system", identity: "system:smoke-test" };
const RILEY = "dev-unverified:riley";
const SAM = "dev-unverified:sam";
/** Convex stops an action at 10 minutes; a CREAO run that hasn't finished by this point is reported as a timeout. */
const SMOKE_DEADLINE_MS = 8 * 60 * 1000;
const POLL_EVERY_MS = 3000;
const PREVIEW_CHARS = 2000;
/** The normal size bound each agent's answer is held to before its validator runs. */
const MAX_OUTPUT_CHARS: Record<AgentName, number> = { intake: 120_000, disbursement: 60_000, evidence_checker: 120_000, reconciler: 60_000, auditor: 200_000 };
const REPORT_FIELDS: Record<AgentName, readonly string[]> = { intake: INVESTIGATION_REPORT_FIELDS, disbursement: DISBURSEMENT_REPORT_FIELDS, evidence_checker: ["schemaVersion", "verdicts"], reconciler: RECON_REPORT_FIELDS, auditor: AUDIT_REPORT_FIELDS };

export const smokeTaskId = (accountId: string, agent: AgentName) => `smoke:${accountId}:${agent}`;

function paidModeOrRefuse(agent: AgentName) {
  const config = configFor(agent);
  if (config.mode !== "creao" && config.mode !== "external") {
    throw new ConvexError(`${agentEnvNames(agent).mode[0]} is ${config.mode ?? "invalid"}. The smoke test calls a real agent, so it runs only when that agent's mode is creao or external.`);
  }
  if (!config.configured) throw new ConvexError(config.message);
  return config as typeof config & { mode: "creao" | "external" };
}

/** A posted allocation of the whole deposit to one owner, as rows only (requested by riley, approved and posted by sam). */
function postedAllocation(accountId: string, deposit: NormalizedBankTransaction, ownerId: string, evidenceSourceIds: string[], at: number): { proposal: MoneyProposal; entries: LedgerEntry[] } {
  const proposalId = `${accountId}:alloc:smoke-1`;
  const approvalId = `${proposalId}:transition:2`;
  const proposal: MoneyProposal = { proposalId, accountId, kind: "allocation", status: "posted", currency: deposit.currency, requestedBy: RILEY, approvedBy: SAM, approvalId, origin: { type: "person" },
    evidenceSourceIds, bankSourceId: deposit.sourceId, shares: [{ ownerId, amountCents: deposit.amountCents }], amountCents: deposit.amountCents, purpose: "Allocation for the smoke test (frozen input only)", createdAt: at - 1000, updatedAt: at };
  const entries = buildPostingEntries(proposal, at, SAM, approvalId);
  return { proposal: { ...proposal, postedEntryIds: entries.map(e => e.entryId) }, entries };
}

function withRows(loaded: LoadedAccount, rows: { proposals?: MoneyProposal[]; entries?: LedgerEntry[]; bankTransactions?: NormalizedBankTransaction[] }): LoadedAccount {
  return { ...loaded, proposals: [...loaded.proposals, ...(rows.proposals ?? [])],
    state: { ...loaded.state, entries: [...loaded.state.entries, ...(rows.entries ?? [])], bankTransactions: [...loaded.state.bankTransactions, ...(rows.bankTransactions ?? [])] } };
}

const cleared = (bundle: NormalizedAccountBundle): NormalizedAccountBundle => ({ ...bundle, bankTransactions: bundle.bankTransactions.map(t => ({ ...t, clearing: "cleared" as const })) });

/** Trust Intake's normal input for the cleared $85,000.00 Harborline deposit. */
function intakeInput(loaded: LoadedAccount, runId: string, now: number): FinanceAgentInput {
  const accountId = loaded.state.account.accountId;
  const deposit = loaded.state.bankTransactions.find(t => t.sourceId === lawId(accountId, "bank:txn:harborline-delgado"));
  if (!deposit) throw new Error("The Harborline deposit is missing from the smoke account.");
  const scope: InvestigationScope = { kind: "deposit_investigation", accountId, currency: loaded.state.account.currency, from: null, cutoff: now };
  const caseId = depositCaseId(accountId);
  const records = buildDepositRecordSet({ state: loaded.state, documents: loaded.documents, obligations: loaded.obligations, deposit, caseId, system: loaded.account.system, datasetVersion: loaded.account.datasetVersion, scope });
  // A fresh account has no approved policies and no saved answers yet.
  return buildIntakeInput({ caseId, taskId: depositTaskId(accountId, deposit.sourceId), runId, scope, now, records, threeWay: checkAccount(loaded.state, now), approvedPolicies: [], humanClarifications: [] });
}

const prepareResult = v.union(
  v.object({ refused: v.literal(false), runId: v.string(), taskId: v.string(), accountId: v.string(), inputJson: v.string() }),
  v.object({ refused: v.literal(true), code: v.string(), message: v.string() }),
);
type PrepareResult = Infer<typeof prepareResult>;

/** Builds the fresh account and the agent's frozen input, checks and records one real run, and saves the input as step 0. */
export const prepare = internalMutation({
  args: { agent: agentName },
  returns: prepareResult,
  handler: async (ctx, { agent }): Promise<PrepareResult> => {
    paidModeOrRefuse(agent);
    const now = Date.now();
    const accountId = demoAccountId(await nextDemoRun(ctx));
    const taskId = smokeTaskId(accountId, agent);
    const budget = await checkBudget(ctx, taskId, 1, now);
    if (!budget.allowed) return { refused: true as const, code: budget.code, message: budget.message };
    const runId = `${taskId}:run:1`;
    await importBundle(ctx, lawFirmBundle(accountId), "demo", { automatic: false });
    let input: unknown;
    if (agent === "intake" || agent === "evidence_checker" || agent === "disbursement") {
      await importBundle(ctx, cleared(lawFirmFeedBundle(1, accountId, now - 60_000)), "demo", { automatic: false });
      const loaded = await loadAccount(ctx, accountId);
      if (agent === "intake") input = intakeInput(loaded, runId, now);
      else if (agent === "evidence_checker") {
        // Intake's claims for that deposit come from the mock Intake, so this smoke test spends exactly one real run: the checker's.
        const intake = intakeInput(loaded, runId, now);
        const execution = await mockFinanceAgentProvider.start(intake);
        if (execution.status !== "completed") throw new Error("The mock Trust Intake always completes");
        const claims = codeCheckClaims(validateFinanceAgentOutput(execution.output, intake), intake);
        if (claims.length === 0) throw new Error("The mock Trust Intake made no claims to check for the Harborline deposit.");
        input = buildCheckerInput(runId, intake, claims);
      } else {
        const bankSourceId = lawId(accountId, "bank:txn:harborline-delgado");
        const deposit = loaded.state.bankTransactions.find(t => t.sourceId === bankSourceId)!;
        const { proposal, entries } = postedAllocation(accountId, deposit, lawId(accountId, "owner:maria-delgado"), [deposit.sourceId, ...deposit.documentSourceIds], now - 30_000);
        const allocated = withRows(loaded, { proposals: [proposal], entries });
        const { matter, clientOwnerId } = matterOf(allocated, bankSourceId);
        input = buildDisbursementInput({ runId, state: allocated.state, documents: allocated.documents, obligations: allocated.obligations, matterId: matter.matterId, clientOwnerId, settlementDeposit: deposit, cutoff: now, approvedPolicies: [], humanClarifications: [] });
      }
    } else if (agent === "reconciler") {
      // Okafor's $2,500.00 retainer check, allocated to him, then returned by the bank.
      await importBundle(ctx, lawFirmFeedBundle(4, accountId, now - 60_000), "demo", { automatic: false });
      const loaded = await loadAccount(ctx, accountId);
      const original = loaded.state.bankTransactions.find(t => t.sourceId === lawId(accountId, "bank:txn:okafor-retainer"));
      const owner = loaded.state.owners.find(o => o.ownerId === lawId(accountId, "owner:daniel-okafor"));
      if (!original || !owner) throw new Error("The Okafor retainer is missing from the smoke account.");
      const { proposal, entries } = postedAllocation(accountId, original, owner.ownerId, [original.sourceId, ...original.documentSourceIds], now - 30_000);
      const sourceId = `${original.sourceId}:returned`;
      const returned: NormalizedBankTransaction = { ...original, sourceId, direction: "outflow", clearing: "cleared", bookedAt: now, reference: `RETURN ${original.reference}`, ownerHintSourceId: owner.sourceId, duplicateOfSourceId: null, raw: { ...original.raw, recordType: "client-check-return", rawId: sourceId } };
      const bounced = withRows(loaded, { proposals: [proposal], entries, bankTransactions: [returned] });
      if (activeAllocations(bounced.state.entries, original.sourceId).length !== 1) throw new Error("The Okafor allocation did not apply.");
      const threeWay = checkAccount(bounced.state, now);
      const cause = reconcilableCauses(threeWay).find(c => c.sourceIds.includes(sourceId));
      if (!cause) throw new Error("The returned Okafor check did not produce a reconcilable three-way cause.");
      input = buildReconciliationInput({ runId, state: bounced.state, threeWay, cause, documents: bounced.documents });
    } else {
      // The auditor drill's four planted mistakes, over the drill's period.
      const loaded = await loadAccount(ctx, accountId);
      const t0 = now - 3 * 86_400_000;
      const history = drillHistory(accountId, t0);
      input = auditInputFrom(withRows(loaded, history), history.transitions, [], runId, t0 - 1000, now);
    }
    await ctx.db.insert("financeRealRuns", { runId, taskId, accountId, provider: agent, day: new Date(now).toISOString().slice(0, 10), at: now });
    const provenance = provenanceFor(agent);
    const snapshot = await captureStep(ctx, { runId, taskId, accountId, agent, kind: "input_frozen", actor: SMOKE_ACTOR, provenance, startedAt: now, input, message: `Smoke test: exactly what ${agent} (${provenance.mode}, ${provenance.model}) is given. One real run; nothing is queued or posted.` });
    await appendMoneyEvent(ctx, { accountId, type: "finance.money.snapshot_captured", actor: { identity: SMOKE_ACTOR.identity, authenticated: false, role: "system" }, operationId: runId, stage: "snapshot", message: `finance.snapshot.captured ${runId} step ${snapshot.stepIndex} (${snapshot.snapshotId}).`, sourceIds: [snapshot.snapshotId, runId] });
    return { refused: false as const, runId, taskId, accountId, inputJson: JSON.stringify(input) };
  },
});

/** Saves the validated answer (or why there is none) as the run's second and last step. */
export const finish = internalMutation({
  args: { agent: agentName, runId: v.string(), taskId: v.string(), accountId: v.string(), startedAt: v.number(), inputJson: v.string(), ok: v.boolean(), outputJson: v.union(v.string(), v.null()), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const snapshot = await captureStep(ctx, { runId: args.runId, taskId: args.taskId, accountId: args.accountId, agent: args.agent, kind: args.ok ? "output_validated" : "failed", actor: SMOKE_ACTOR, provenance: provenanceFor(args.agent),
      startedAt: args.startedAt, input: JSON.parse(args.inputJson) as unknown, output: args.outputJson === null ? null : JSON.parse(args.outputJson) as unknown, message: args.message.slice(0, 2000) });
    await appendMoneyEvent(ctx, { accountId: args.accountId, type: "finance.money.snapshot_captured", actor: { identity: SMOKE_ACTOR.identity, authenticated: false, role: "system" }, operationId: args.runId, stage: "snapshot", message: `finance.snapshot.captured ${args.runId} step ${snapshot.stepIndex} (${snapshot.snapshotId}).`, sourceIds: [snapshot.snapshotId, args.runId] });
    return null;
  },
});

const smokeResult = v.object({
  agent: agentName, mode: v.union(v.literal("creao"), v.literal("external")), model: v.string(), appId: v.union(v.string(), v.null()),
  runId: v.union(v.string(), v.null()), accountId: v.union(v.string(), v.null()),
  ok: v.boolean(), outcome: v.union(v.string(), v.null()), validationErrors: v.array(v.object({ path: v.string(), reason: v.string() })),
  error: v.union(v.object({ code: v.string(), message: v.string() }), v.null()), rawOutputPreview: v.union(v.string(), v.null()), durationMs: v.number(),
});

type SmokeResult = Infer<typeof smokeResult>;
type Validated = { outcome: string; output: unknown };

/** The agent's normal strict validator; nothing is repaired. Returns the outcome a person would see next. */
function validate(agent: AgentName, value: unknown, input: unknown, mode: "creao" | "external"): Validated {
  if (agent === "intake") { const out = validateFinanceAgentOutput(value, input as FinanceAgentInput); return { outcome: out.outcome, output: out }; }
  if (agent === "disbursement") { const out = validateDisbursementOutput(value, input as DisbursementInput); return { outcome: out.outcome, output: out }; }
  if (agent === "reconciler") { const out = validateReconciliationOutput(value, input as ReconciliationInput); return { outcome: out.outcome, output: out }; }
  if (agent === "auditor") { const out = validateAuditOutput(value, input as AuditInput); return { outcome: combineAuditFindings((input as AuditInput).codeFindings, out).length ? "findings" : "clean", output: out }; }
  const checker = input as CheckerInput;
  const out = validateCheckerOutput(value, checker);
  const code = checker.claims.map(c => ({ findingId: c.findingId, claim: c.claim, sourceRefs: c.sourceRefs, verdict: c.codeVerdict, checkedBy: "code" as const, reason: c.codeReason, facts: [], missing: [], sourceSays: null }));
  return { outcome: finalizeClaimCheck(code, out, mode, Date.now()).status, output: out };
}

/**
 * Run from the CLI: npx convex run financeSmoke:runAgentOnce "{agent: 'intake'}". Refuses unless that agent's mode is creao or
 * external. Counts one real run against MAX_REAL_RUNS_PER_DAY; never posts money.
 */
export const runAgentOnce = internalAction({
  args: { agent: agentName }, returns: smokeResult,
  handler: async (ctx, { agent }): Promise<SmokeResult> => {
    const config = paidModeOrRefuse(agent);
    const base = { agent, mode: config.mode, model: config.model, appId: config.appId };
    const job: PrepareResult = await ctx.runMutation(internal.financeSmoke.prepare, { agent });
    if (job.refused) return { ...base, runId: null, accountId: null, ok: false, outcome: null, validationErrors: [], error: { code: job.code, message: job.message }, rawOutputPreview: null, durationMs: 0 };
    const input = JSON.parse(job.inputJson) as unknown;
    // Every response body is kept so a reply that can't be parsed is still shown in the preview.
    let lastBody: string | null = null;
    const recordingFetch: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      try { lastBody = await response.clone().text(); } catch { lastBody = null; }
      return response;
    };
    const unusedMock: AgentProvider<unknown> = { mode: "mock", async start() { throw new FinanceProviderError("configuration_error", "The smoke test never runs the mock."); }, async poll() { throw new FinanceProviderError("configuration_error", "The smoke test never runs the mock."); } };
    const provider = createAgentProvider<unknown>(config, unusedMock, REPORT_FIELDS[agent], { fetchImpl: recordingFetch, timeoutMs: parseProviderTimeoutMs(env.PROVIDER_TIMEOUT_MS) });
    const startedAt = Date.now();
    let execution: ProviderExecution | null = null;
    let error: { code: string; message: string } | null = null;
    let validationErrors: Array<{ path: string; reason: string }> = [];
    try {
      execution = await provider.start(input);
      while (execution.status === "pending") {
        if (Date.now() - startedAt >= SMOKE_DEADLINE_MS) throw new FinanceProviderError("provider_timeout", `The agent had not finished after ${SMOKE_DEADLINE_MS / 60_000} minutes. External run ${execution.externalRunId} may still finish in CREAO.`);
        await new Promise(resolve => setTimeout(resolve, POLL_EVERY_MS));
        execution = await provider.poll(execution.externalRunId);
      }
      if (execution.status === "failed") throw new FinanceProviderError(execution.error.code, execution.error.message);
    } catch (caught) {
      // Provider messages never carry keys; anything else is replaced so raw exception text (URLs, keys) is never returned.
      error = caught instanceof FinanceProviderError ? { code: caught.code, message: caught.message } : { code: "provider_failure", message: "The agent call failed unexpectedly." };
      // The external adapter refuses fenced or non-JSON text before any validator sees it: that is a validation failure too.
      if (error.code === "validation_failed") validationErrors = [{ path: "$", reason: error.message }];
    }
    const durationMs = Date.now() - startedAt;
    const output = execution?.status === "completed" ? execution.output : undefined;
    let outcome: string | null = null;
    let validated: unknown = null;
    if (output !== undefined) {
      try {
        if (JSON.stringify(output).length > MAX_OUTPUT_CHARS[agent]) throw new FinanceProviderError("validation_failed", `The answer exceeds ${MAX_OUTPUT_CHARS[agent]} characters.`);
        ({ outcome, output: validated } = validate(agent, output, input, config.mode));
      } catch (caught) {
        const details = caught instanceof FinanceProviderError && "details" in caught && Array.isArray(caught.details) ? caught.details as Array<{ path: string; reason: string }> : [];
        validationErrors = details.length ? details : [{ path: "$", reason: caught instanceof Error ? caught.message : "The answer failed validation." }];
        error = { code: "validation_failed", message: "The answer failed the agent's normal validator. Nothing was proposed." };
      }
    }
    const ok = error === null && outcome !== null;
    const raw = output !== undefined ? JSON.stringify(output) : lastBody;
    const message = ok ? `Smoke test: ${agent} answered ${outcome} in ${durationMs} ms and passed validation.` : `Smoke test: ${error?.code}: ${error?.message}${validationErrors.length ? ` ${validationErrors.slice(0, 5).map(e => `${e.path}: ${e.reason}`).join("; ")}` : ""}`;
    try {
      await retryWriteConflicts(() => ctx.runMutation(internal.financeSmoke.finish, { agent, runId: job.runId, taskId: job.taskId, accountId: job.accountId, startedAt, inputJson: job.inputJson, ok, outputJson: ok ? JSON.stringify(validated) : null, message }));
    } catch {
      // The result below is what the person running the test needs; a failed snapshot save must not hide it.
      console.error(`Smoke test ${job.runId}: the final step snapshot could not be saved.`);
    }
    return { ...base, runId: job.runId, accountId: job.accountId, ok, outcome, validationErrors, error, rawOutputPreview: raw === null ? null : raw.slice(0, PREVIEW_CHARS), durationMs };
  },
});
