import { describe, expect, it, vi } from "vitest";
import { FinanceProviderError } from "../src/agent/types";
import { mockFinanceAgentProvider } from "../src/agent/mock";
import {
  ACTIVE_STATES, ALLOWED, assertTransition, budgetDecision, callWithRetry, canTransition, IllegalTransitionError, isRetryable, ORCHESTRATOR_STATES,
  parseBudget, parseMockFault, parseProviderTimeoutMs, settledState, SETTLED_STATES, utcDay, withMockFault, withTimeout,
} from "../src/orchestrator";
import { sampleInput } from "./fixtures";

describe("orchestrator state machine", () => {
  it("walks the happy path received → investigating → validating → checking → ready_for_approval", () => {
    const path = ["received", "investigating", "validating", "checking", "ready_for_approval"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });

  it("refuses shortcuts: nothing reaches a person's queue without validating and checking", () => {
    expect(() => assertTransition("investigating", "ready_for_approval")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("validating", "ready_for_approval")).toThrow("cannot move from validating to ready_for_approval");
    expect(() => assertTransition("received", "checking")).toThrow(IllegalTransitionError);
    expect(canTransition("checking", "investigating")).toBe(false);
  });

  it("every settled state can start a new attempt, and only active states block one", () => {
    for (const state of SETTLED_STATES) expect(canTransition(state, "investigating")).toBe(true);
    expect([...ACTIVE_STATES].sort()).toEqual(["checking", "investigating", "validating"]);
    expect(ORCHESTRATOR_STATES.every(state => state in ALLOWED)).toBe(true);
  });

  it("maps a checked run to where it settles", () => {
    expect(settledState({ checkerRejected: true, outcome: "proposal_ready", depositPending: false, lockBlocked: false }).state).toBe("rejected");
    expect(settledState({ checkerRejected: false, outcome: "needs_information", depositPending: false, lockBlocked: false }).state).toBe("needs_person");
    expect(settledState({ checkerRejected: false, outcome: "proposal_ready", depositPending: false, lockBlocked: false }).state).toBe("ready_for_approval");
    expect(settledState({ checkerRejected: false, outcome: "proposal_ready", depositPending: false, lockBlocked: true }).reason.code).toBe("LOCK_BLOCKED");
    expect(settledState({ checkerRejected: false, outcome: "findings", depositPending: true, lockBlocked: false }).state).toBe("waiting_to_clear");
    expect(settledState({ checkerRejected: false, outcome: "findings", depositPending: false, lockBlocked: false }).state).toBe("needs_person");
  });
});

describe("reliability", () => {
  it("retries only provider and network trouble, never validation, checker, configuration or an ambiguous paid start", () => {
    expect(isRetryable({ code: "provider_network_error", retryable: true })).toBe(true);
    expect(isRetryable({ code: "provider_http_503", retryable: true })).toBe(true);
    expect(isRetryable({ code: "provider_timeout", retryable: true })).toBe(true);
    for (const code of ["validation_failed", "checker_validation_failed", "configuration_error", "provider_start_ambiguous", "provider_authentication_error"]) expect(isRetryable({ code, retryable: true })).toBe(false);
    expect(isRetryable({ code: "provider_network_error", retryable: false })).toBe(false);
  });

  it("reads PROVIDER_TIMEOUT_MS, falling back to 20 s for missing or out-of-range values", () => {
    expect(parseProviderTimeoutMs(undefined)).toBe(20_000);
    expect(parseProviderTimeoutMs("5000")).toBe(5000);
    expect(parseProviderTimeoutMs("50")).toBe(20_000);
    expect(parseProviderTimeoutMs("ten")).toBe(20_000);
  });

  it("times out a hung call; a paid start is ambiguous and not retryable, a status check is", async () => {
    const never = () => new Promise<never>(() => undefined);
    await expect(withTimeout(never, 20, "start", true)).rejects.toMatchObject({ code: "provider_timeout", retryable: false });
    await expect(withTimeout(never, 20, "poll", true)).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
    await expect(withTimeout(never, 20, "start", false)).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
    await expect(withTimeout(async () => "ok", 20, "start", true)).resolves.toBe("ok");
  });

  it("makes exactly one automatic retry, records it first, and stops if the retry is refused", async () => {
    const onRetry = vi.fn(async () => true);
    const call = vi.fn().mockRejectedValueOnce(new FinanceProviderError("provider_network_error", "down", true)).mockResolvedValueOnce("second try");
    await expect(callWithRetry(call, { timeoutMs: 100, phase: "start", paid: false, onRetry })).resolves.toBe("second try");
    expect(call).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);

    const twice = vi.fn().mockRejectedValue(new FinanceProviderError("provider_network_error", "still down", true));
    await expect(callWithRetry(twice, { timeoutMs: 100, phase: "start", paid: false, onRetry: async () => true })).rejects.toMatchObject({ code: "provider_network_error" });
    expect(twice).toHaveBeenCalledTimes(2);

    const refused = vi.fn().mockRejectedValue(new FinanceProviderError("provider_network_error", "down", true));
    await expect(callWithRetry(refused, { timeoutMs: 100, phase: "start", paid: false, onRetry: async () => false })).rejects.toThrow("down");
    expect(refused).toHaveBeenCalledTimes(1);

    const invalid = vi.fn().mockRejectedValue(new FinanceProviderError("validation_failed", "bad", false));
    const neverAsked = vi.fn(async () => true);
    await expect(callWithRetry(invalid, { timeoutMs: 100, phase: "start", paid: false, onRetry: neverAsked })).rejects.toThrow("bad");
    expect(neverAsked).not.toHaveBeenCalled();
  });

  it("MOCK_PROVIDER_FAULT wraps only the mock provider", async () => {
    expect(parseMockFault("network_once")).toBe("network_once");
    expect(parseMockFault("anything")).toBeNull();
    const once = withMockFault(mockFinanceAgentProvider, "network_once");
    await expect(once.start(sampleInput())).rejects.toMatchObject({ code: "provider_network_error", retryable: true });
    await expect(once.start(sampleInput())).resolves.toMatchObject({ status: "completed" });
    const invalid = withMockFault(mockFinanceAgentProvider, "invalid_output");
    expect(await invalid.start(sampleInput())).toMatchObject({ output: { unexpected: "MOCK_PROVIDER_FAULT=invalid_output" } });
    const creaoLike = { ...mockFinanceAgentProvider, mode: "creao" as const };
    expect(withMockFault(creaoLike, "network_always")).toBe(creaoLike);
  });
});

describe("real-run budget", () => {
  it("defaults to 5 a day and 2 per deposit, and reads whole numbers", () => {
    expect(parseBudget({})).toEqual({ perDay: 5, perDeposit: 2 });
    expect(parseBudget({ perDay: "0", perDeposit: "7" })).toEqual({ perDay: 0, perDeposit: 7 });
    expect(parseBudget({ perDay: "-1", perDeposit: "x" })).toEqual({ perDay: 5, perDeposit: 2 });
  });

  it("mock runs never count; real runs are refused with the reason once a limit would be exceeded", () => {
    const limits = { perDay: 5, perDeposit: 2 };
    expect(budgetDecision({ needed: 0, usedToday: 99, usedForDeposit: 99, limits })).toMatchObject({ allowed: true, code: "BUDGET_NOT_APPLICABLE" });
    expect(budgetDecision({ needed: 1, usedToday: 4, usedForDeposit: 1, limits })).toMatchObject({ allowed: true, code: "BUDGET_OK" });
    expect(budgetDecision({ needed: 1, usedToday: 5, usedForDeposit: 0, limits })).toMatchObject({ allowed: false, code: "BUDGET_DAY_EXCEEDED", message: expect.stringContaining("5 of 5 real runs already used today") });
    expect(budgetDecision({ needed: 2, usedToday: 0, usedForDeposit: 1, limits })).toMatchObject({ allowed: false, code: "BUDGET_DEPOSIT_EXCEEDED" });
    expect(utcDay(Date.UTC(2026, 9, 24, 23, 59))).toBe("2026-10-24");
  });
});
