import { describe, expect, it, vi } from "vitest";
import { createFinanceAgentProvider, validateFinanceAgentOutput } from "../src/agent";
import { isIntegerCents, reconcileBalances, runDeterministicChecks, validateAllocationProposals } from "../src/checks";
import type { ProposedAllocation } from "@mangekyo/contracts";
import { sampleInput } from "./fixtures";

const proposed = (): ProposedAllocation => ({ proposalId: "proposal-1", transactionId: "deposit-1", ownerId: "owner-1", amountCents: 125000, currency: "USD", evidenceSourceIds: ["note:1"] });

describe("financial code checks", () => {
  it("validates cents without floating arithmetic or unsafe sums", () => {
    for (const amount of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "125000"]) expect(isIntegerCents(amount)).toBe(false);
    expect(isIntegerCents(125000)).toBe(true);
    const input = sampleInput(); input.records.transactions[0].amountCents = 1.2;
    expect(runDeterministicChecks(input.records, input.scope).amounts.status).toBe("failed");
  });
  it("rejects amount totals, currencies, unknown references, and duplicate allocations", () => {
    const input = sampleInput(); input.records.allocationHistoryComplete = true;
    expect(validateAllocationProposals([proposed()], input.records, input.scope).status).toBe("passed");
    for (const proposal of [
      { ...proposed(), amountCents: 124999 }, { ...proposed(), amountCents: -1 },
      { ...proposed(), ownerId: "nonexistent" }, { ...proposed(), transactionId: "nonexistent" },
      { ...proposed(), currency: "EUR" },
    ]) expect(validateAllocationProposals([proposal], input.records, input.scope).status).toBe("failed");
    expect(validateAllocationProposals([proposed(), proposed()], input.records, input.scope).status).toBe("failed");
    input.records.existingAllocations = [proposed()];
    expect(validateAllocationProposals([proposed()], input.records, input.scope).status).toBe("failed");
    input.records.existingAllocations = [{ ...proposed(), proposalId: "different-proposal", ownerId: "different-owner" }];
    expect(validateAllocationProposals([proposed()], input.records, input.scope).status).toBe("failed");
  });
  it("does not infer a bank closing balance from one deposit", () => {
    const input = sampleInput();
    expect(reconcileBalances(input.records, input.scope)).toMatchObject({ status: "insufficient_data", adjustedBankCents: null, ownerAllocationsVerified: false });
    expect(validateAllocationProposals([proposed()], input.records, input.scope).status).toBe("insufficient_data");
  });
  it("preserves documented timing differences and distinguishes matching totals from ownership", () => {
    const input = sampleInput();
    const balance = { accountId: "test-bank", currency: "USD", cutoff: 1000, sourceId: "balance:1", balanceId: "b1", amountCents: 125000 };
    input.records.bankBalance = { ...balance, amountCents: 126000 };
    input.records.controlBalance = { ...balance, balanceId: "b2" };
    input.records.ownerBalances = [{ ...balance, balanceId: "b3", ownerId: "owner-1" }];
    input.records.ownerBalancesComplete = true;
    input.records.timingDifferences = [{ differenceId: "timing-1", sourceId: "timing:1", accountId: "test-bank", currency: "USD", cutoff: 1000, appliesTo: "bank", amountCents: -1000, description: "SYNTHETIC documented bank timing adjustment", documented: true }];
    const result = reconcileBalances(input.records, input.scope);
    expect(result).toMatchObject({ status: "balanced_totals", adjustedBankCents: 125000, adjustedControlCents: 125000, adjustedOwnerCents: 125000, ownerAllocationsVerified: false });
    expect(result.timingDifferences).toEqual(input.records.timingDifferences);
    input.records.controlBalance.cutoff = 999;
    expect(reconcileBalances(input.records, input.scope).status).toBe("insufficient_data");
    input.records.controlBalance.cutoff = 1000; input.records.timingDifferences[0].documented = false;
    expect(reconcileBalances(input.records, input.scope).status).toBe("insufficient_data");
  });
});

describe("provider contract and mock", () => {
  it("explicit mock mode is deterministic, simulated, and asks instead of allocating", async () => {
    const provider = createFinanceAgentProvider({ mode: "mock" }); const input = sampleInput();
    const first = await provider.start(input); const second = await provider.start(input);
    expect(first).toEqual(second); expect(provider.mode).toBe("mock");
    if (first.status !== "completed") throw new Error("Mock did not complete");
    const output = validateFinanceAgentOutput(first.output, input);
    expect(output.summary).toContain("SIMULATED"); expect(output.outcome).toBe("needs_information");
    expect(output.questions[0].question).toContain("bank payer reference");
    expect(output.proposedAllocations).toEqual([]);
    expect(output.candidatePolicies[0].status).toBe("proposed");
  });
  it("rejects unsupported evidence, fractional cents and model-approved fields", async () => {
    const input = sampleInput(); const run = await createFinanceAgentProvider({ mode: "mock" }).start(input);
    if (run.status !== "completed") throw new Error("Mock did not complete");
    const result = validateFinanceAgentOutput(run.output, input);
    const badSource = structuredClone(result); badSource.findings[0].sourceRefs = ["invented-document"];
    expect(() => validateFinanceAgentOutput(badSource, input)).toThrow(/Citation does not exist/);
    expect(() => validateFinanceAgentOutput({ ...result, approved: true }, input)).toThrow(/Unsupported field/);
    expect(() => validateFinanceAgentOutput({ ...result, proposedAllocations: [{ ...proposed(), amountCents: 125000.1 }] }, input)).toThrow(/integer cents/);
    expect(() => validateFinanceAgentOutput({ ...result, outcome: "proposal_ready", questions: [], proposedAllocations: [{ ...proposed(), ownerId: "invented-owner" }] }, input)).toThrow(/financial checks/);
    expect(() => validateFinanceAgentOutput({ ...result, proposedActions: [{ kind: "execute_payment", description: "Pay now", sourceRefs: [] }] }, input)).toThrow(/execution is disabled/);
  });
  it("does not invent a deposit when the explicit historical period contains no transactions", async () => {
    const input = sampleInput(); input.scope.kind = "historical_onboarding"; input.records.transactions = [];
    const execution = await createFinanceAgentProvider({ mode: "mock" }).start(input);
    if (execution.status !== "completed") throw new Error("Mock did not complete");
    const output = validateFinanceAgentOutput(execution.output, input);
    expect(output.summary).toContain("0 available transaction(s)");
    expect(output.questions[0].question).toContain("no deposit was included");
    expect(output.questions[0].question).not.toContain("1,250");
  });
  it("never silently selects mock for missing or real-mode credentials", () => {
    expect(() => createFinanceAgentProvider({ mode: undefined })).toThrow(/explicitly/);
    expect(() => createFinanceAgentProvider({ mode: "creao" })).toThrow(/CREAO_APP_ID/);
    expect(() => createFinanceAgentProvider({ mode: "creao", appId: "app-1", apiKey: "cr_sk_wrong_family" })).toThrow(/app-scoped/);
  });
});

describe("CREAO app-scoped adapter", () => {
  it("uses inputs.finance_context, retains the external run ID and parses result.text", async () => {
    const input = sampleInput(); const mock = await createFinanceAgentProvider({ mode: "mock" }).start(input);
    if (mock.status !== "completed") throw new Error("Mock did not complete");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "external-1", appId: "app-1", status: "pending" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ id: "external-1", status: "running" }))
      .mockResolvedValueOnce(Response.json({ id: "external-1", status: "completed", result: { text: JSON.stringify(mock.output), artifacts: [] } }));
    const provider = createFinanceAgentProvider({ mode: "creao", appId: "app-1", apiKey: "capi_synthetic_test_key" }, fetcher);
    expect(await provider.start(input)).toEqual({ status: "pending", externalRunId: "external-1" });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://agent.creao.ai/api/v1/apps/app-1/runs");
    expect(JSON.parse(String(options?.body))).toEqual({ inputs: { finance_context: JSON.stringify(input) } });
    expect(await provider.poll("external-1")).toEqual({ status: "pending", externalRunId: "external-1" });
    const completed = await provider.poll("external-1");
    expect(completed.status).toBe("completed");
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    if (completed.status === "completed") expect(validateFinanceAgentOutput(completed.output, input)).toEqual(mock.output);
  });
  it("surfaces authentication failure and sanitizes response details", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private provider body", { status: 401 }));
    const provider = createFinanceAgentProvider({ mode: "creao", appId: "app-1", apiKey: "capi_synthetic_test_key" }, fetcher);
    await expect(provider.start(sampleInput())).rejects.toMatchObject({ code: "provider_authentication_error", retryable: false });
  });
  it("does not auto-retry ambiguous paid starts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection failed"));
    const provider = createFinanceAgentProvider({ mode: "creao", appId: "app-1", apiKey: "capi_synthetic_test_key" }, fetcher);
    await expect(provider.start(sampleInput())).rejects.toMatchObject({ code: "provider_start_ambiguous", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(provider.poll("external-1")).rejects.toMatchObject({ code: "provider_network_error", retryable: true });
  });
  it("marks an accepted but malformed start response as ambiguous instead of retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("not JSON", { status: 202 }));
    const provider = createFinanceAgentProvider({ mode: "creao", appId: "app-1", apiKey: "capi_synthetic_test_key" }, fetcher);
    await expect(provider.start(sampleInput())).rejects.toMatchObject({ code: "provider_start_ambiguous", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed terminal text and reports cancellation without simulated success", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "external-1", status: "completed", result: { text: "not JSON" } }))
      .mockResolvedValueOnce(Response.json({ id: "external-1", status: "cancelled" }));
    const provider = createFinanceAgentProvider({ mode: "creao", appId: "app-1", apiKey: "capi_synthetic_test_key" }, fetcher);
    await expect(provider.poll("external-1")).rejects.toMatchObject({ code: "validation_failed" });
    expect(await provider.poll("external-1")).toMatchObject({ status: "failed", externalRunId: "external-1", error: { code: "provider_cancelled" } });
  });
});
