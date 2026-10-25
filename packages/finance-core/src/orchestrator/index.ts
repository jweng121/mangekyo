import { FinanceProviderError } from "../agent/types";

/**
 * One orchestrator per deposit (or per code-found mismatch). Pure rules only: Convex saves every
 * transition as an event plus a snapshot, and refuses any transition this table doesn't allow.
 */
export const ORCHESTRATOR_STATES = ["received", "investigating", "validating", "checking", "needs_person", "ready_for_approval", "rejected", "waiting_to_clear", "failed"] as const;
export type OrchestratorState = (typeof ORCHESTRATOR_STATES)[number];
export type OrchestratorKind = "deposit" | "reconciliation" | "disbursement" | "audit";

/** A run is in flight; a second start returns it instead of starting another. */
export const ACTIVE_STATES: ReadonlySet<OrchestratorState> = new Set(["investigating", "validating", "checking"]);
/** Where a run stops. Each one is a place a person, the bank feed or a new attempt picks it up again. */
export const SETTLED_STATES: ReadonlySet<OrchestratorState> = new Set(["needs_person", "ready_for_approval", "rejected", "waiting_to_clear", "failed"]);

const SETTLED = ["needs_person", "ready_for_approval", "rejected", "waiting_to_clear", "failed"] as const;
export const ALLOWED: Record<OrchestratorState, readonly OrchestratorState[]> = {
  // A budget refusal goes straight to a person; nothing ran.
  received: ["investigating", "needs_person"],
  // investigating → investigating is the single automatic retry.
  investigating: ["investigating", "validating", "failed"],
  validating: ["checking", "failed"],
  // checking → checking is the checker's own single automatic retry.
  checking: ["checking", "needs_person", "ready_for_approval", "rejected", "waiting_to_clear", "failed"],
  needs_person: ["investigating", "needs_person"],
  ready_for_approval: ["investigating", "needs_person"],
  rejected: ["investigating", "needs_person"],
  waiting_to_clear: ["investigating", "needs_person"],
  failed: ["investigating", "needs_person"],
};

export class IllegalTransitionError extends Error {
  constructor(public readonly from: OrchestratorState, public readonly to: OrchestratorState) {
    super(`Orchestrator cannot move from ${from} to ${to}.`); this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: OrchestratorState, to: OrchestratorState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: OrchestratorState, to: OrchestratorState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export type EventKind = "transition" | "retry" | "budget_check";
export type Trigger =
  | "deposit_received" | "auto_start" | "person_started" | "person_answered" | "person_corrected" | "deposit_cleared"
  | "mismatch_found" | "budget_refused" | "provider_result" | "provider_error" | "timeout" | "validated" | "validation_failed"
  | "checker_result" | "checker_failed" | "person_approved_correction" | "person_rejected_correction" | "audit_requested" | "allocation_posted";
export interface OrchestratorActor { type: "system" | "agent" | "code" | "person"; identity: string }
export interface OrchestratorReason { code: string; message: string }

/** What a finished, validated and checked run means for the deposit. */
export function settledState(args: { checkerRejected: boolean; outcome: "findings" | "needs_information" | "proposal_ready"; depositPending: boolean; lockBlocked: boolean }): { state: (typeof SETTLED)[number]; reason: OrchestratorReason } {
  if (args.checkerRejected) return { state: "rejected", reason: { code: "CHECKER_REJECTED", message: "The checker found a claim its sources don't support. Nothing was sent for approval." } };
  if (args.outcome === "needs_information") return { state: "needs_person", reason: { code: "QUESTION_ASKED", message: "The investigator asked a person instead of guessing." } };
  if (args.outcome === "proposal_ready") return args.lockBlocked
    ? { state: "needs_person", reason: { code: "LOCK_BLOCKED", message: "The lock blocked the proposed allocation; a person decides what to do." } }
    : { state: "ready_for_approval", reason: { code: "PROPOSAL_READY", message: "Every claim was checked and the lock passed. A person approves, then posts." } };
  if (args.depositPending) return { state: "waiting_to_clear", reason: { code: "WAITING_TO_CLEAR", message: "The deposit hasn't cleared; it is investigated again when it does." } };
  return { state: "needs_person", reason: { code: "FINDINGS_ONLY", message: "Findings only. A person reviews them; nothing was proposed." } };
}

/* ---------- Reliability ---------- */

export const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;
export const MAX_AUTOMATIC_RETRIES = 1;

/** PROVIDER_TIMEOUT_MS: how long one provider call may take. Whole milliseconds, 100 ms to 10 minutes. */
export function parseProviderTimeoutMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value || !/^\d{1,7}$/.test(value)) return DEFAULT_PROVIDER_TIMEOUT_MS;
  const ms = Number(value);
  return ms >= 100 && ms <= 600_000 ? ms : DEFAULT_PROVIDER_TIMEOUT_MS;
}

/** Only provider and network trouble is retried. Validation, checker and configuration failures never are. */
const NEVER_RETRY = /^(validation_failed|checker_|configuration_error|provider_start_ambiguous|provider_authentication_error|provider_(failed|cancelled)|provider_conflicting_reports|provider_report_delivery_unsupported|budget_)/;
export function isRetryable(error: { code: string; retryable: boolean }): boolean {
  return error.retryable && !NEVER_RETRY.test(error.code);
}

/**
 * Bounds one provider call. A timed-out start of a paid run is ambiguous (the run may exist), so it is
 * never retryable; a timed-out status check or a simulated call is.
 */
export async function withTimeout<T>(call: () => Promise<T>, ms: number, phase: "start" | "poll" | "check", paid: boolean): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FinanceProviderError("provider_timeout",
      phase === "poll" || !paid ? `The provider didn't answer within ${ms} ms.` : `The provider didn't answer within ${ms} ms. A paid run may exist; inspect the provider before rerunning.`,
      phase === "poll" || !paid)), ms);
  });
  try { return await Promise.race([call(), timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * One provider call with a timeout and at most one automatic retry, only for provider or network trouble.
 * onRetry records the retry (and may refuse it, e.g. when this run already used its retry); it returns false to stop.
 */
export async function callWithRetry<T>(call: () => Promise<T>, options: { timeoutMs: number; phase: "start" | "poll" | "check"; paid: boolean; onRetry(error: FinanceProviderError): Promise<boolean> }): Promise<T> {
  try { return await withTimeout(call, options.timeoutMs, options.phase, options.paid); }
  catch (error) {
    if (!(error instanceof FinanceProviderError) || !isRetryable(error)) throw error;
    if (!(await options.onRetry(error))) throw error;
    return await withTimeout(call, options.timeoutMs, options.phase, options.paid);
  }
}

/** Convex's message when a mutation kept conflicting with concurrent writes and gave up. */
export const WRITE_CONFLICT = /changed while this mutation was being run/i;

/**
 * Saving a provider's answer is retried (up to 10 times, backoff capped at 5 s) when the database was busy: every settle
 * appends to the account's one event stream, so many runs settling at once take turns. This is not a
 * provider retry: the provider is not called again, and the save mutations are idempotent through their status guards.
 */
export async function retryWriteConflicts<T>(write: () => Promise<T>, options: { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void>; random?: () => number } = {}): Promise<T> {
  const attempts = options.attempts ?? 10;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try { return await write(); }
    catch (error) {
      if (attempt >= attempts || !(error instanceof Error) || !WRITE_CONFLICT.test(error.message)) throw error;
      await sleep(Math.min(5000, (options.baseMs ?? 400) * 2 ** (attempt - 1)) * (0.5 + (options.random ?? Math.random)()));
    }
  }
}

/** MOCK_PROVIDER_FAULT (mock mode only): deterministic provider trouble for tests and demos. */
export type MockFault = "network_once" | "network_always" | "hang" | "invalid_output";
export function parseMockFault(raw: string | undefined): MockFault | null {
  const value = raw?.trim().toLowerCase();
  return value === "network_once" || value === "network_always" || value === "hang" || value === "invalid_output" ? value : null;
}

export interface StartableProvider<I> { mode: "mock" | "creao" | "external"; start(input: I): Promise<{ status: string; externalRunId: string } & Record<string, unknown>> }

/** Wraps a mock provider so its first (or every) call fails, hangs, or answers with invalid output. Calls are counted per instance. */
export function withMockFault<I, P extends StartableProvider<I>>(provider: P, fault: MockFault | null): P {
  if (!fault || provider.mode !== "mock") return provider;
  let calls = 0;
  return { ...provider, async start(input: I) {
    calls++;
    if (fault === "network_always" || (fault === "network_once" && calls === 1)) throw new FinanceProviderError("provider_network_error", "Simulated network error (MOCK_PROVIDER_FAULT).", true);
    if (fault === "hang") return await new Promise<never>(() => undefined);
    const result = await provider.start(input);
    return fault === "invalid_output" && result.status === "completed" ? { ...result, output: { unexpected: "MOCK_PROVIDER_FAULT=invalid_output" } } : result;
  } };
}

/* ---------- Real-run budget ---------- */

export interface BudgetLimits { perDay: number; perDeposit: number }
export const DEFAULT_BUDGET: BudgetLimits = { perDay: 5, perDeposit: 2 };

function limit(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  return value && /^\d{1,4}$/.test(value) ? Number(value) : fallback;
}
/** MAX_REAL_RUNS_PER_DAY / MAX_REAL_RUNS_PER_DEPOSIT: whole numbers; 0 refuses every real run. */
export function parseBudget(env: { perDay?: string; perDeposit?: string }): BudgetLimits {
  return { perDay: limit(env.perDay, DEFAULT_BUDGET.perDay), perDeposit: limit(env.perDeposit, DEFAULT_BUDGET.perDeposit) };
}

export function utcDay(at: number): string { return new Date(at).toISOString().slice(0, 10); }

export interface BudgetDecision { allowed: boolean; code: string; message: string; needed: number; usedToday: number; usedForDeposit: number; limits: BudgetLimits }

/** `needed` is how many real (paid) provider runs the attempt will make: the investigator and/or the checker. Mock runs need 0. */
export function budgetDecision(args: { needed: number; usedToday: number; usedForDeposit: number; limits: BudgetLimits }): BudgetDecision {
  const { needed, usedToday, usedForDeposit, limits } = args;
  const base = { needed, usedToday, usedForDeposit, limits };
  if (needed === 0) return { ...base, allowed: true, code: "BUDGET_NOT_APPLICABLE", message: "Mock runs don't count against the real-run budget." };
  if (usedToday + needed > limits.perDay) return { ...base, allowed: false, code: "BUDGET_DAY_EXCEEDED", message: `Refused: ${usedToday} of ${limits.perDay} real runs already used today (UTC); this attempt needs ${needed}. Raise MAX_REAL_RUNS_PER_DAY or wait until tomorrow.` };
  if (usedForDeposit + needed > limits.perDeposit) return { ...base, allowed: false, code: "BUDGET_DEPOSIT_EXCEEDED", message: `Refused: ${usedForDeposit} of ${limits.perDeposit} real runs already used for this deposit; this attempt needs ${needed}. A person decides whether it's worth raising MAX_REAL_RUNS_PER_DEPOSIT.` };
  return { ...base, allowed: true, code: "BUDGET_OK", message: `Allowed: ${usedToday + needed} of ${limits.perDay} real runs today, ${usedForDeposit + needed} of ${limits.perDeposit} for this deposit.` };
}
