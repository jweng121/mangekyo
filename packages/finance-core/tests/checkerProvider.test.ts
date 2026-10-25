import { FINANCE_INPUT_VERSION, FINANCE_INSTRUCTION_VERSION, FINANCE_OUTPUT_VERSION, type FinanceAgentInput, type FinanceAgentOutput } from "@mangekyo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  buildCheckerInput, CHECKER_OUTPUT_VERSION, codeCheckClaims, combineVerdicts, createClaimCheckerProvider, CreaoClaimCheckerProvider, finalizeClaimCheck,
  mockCheckerOutput, mockClaimCheckerProvider, parseCheckerMode, validateCheckerOutput, type CheckerInput,
} from "../src/checker";
import { runDeterministicChecks } from "../src/checks";
import { buildDepositRecordSet, depositCaseId } from "../src/intake/context";
import { demoIds, demoMoneyBundle } from "../fixtures/demoMoney";
import { NOW, stateFrom } from "./money";

function input(): FinanceAgentInput {
  const bundle = demoMoneyBundle();
  const scope = { kind: "deposit_investigation" as const, accountId: bundle.account.accountId, currency: "USD", from: null, cutoff: NOW };
  const records = buildDepositRecordSet({ state: stateFrom(bundle), documents: bundle.documents, obligations: bundle.obligations, deposit: bundle.bankTransactions.find(t => t.sourceId === demoIds.depositA)!, caseId: depositCaseId(bundle.account.accountId), system: "demo", datasetVersion: "test", scope });
  return { schemaVersion: FINANCE_INPUT_VERSION, instructionVersion: FINANCE_INSTRUCTION_VERSION, caseId: "c", taskId: "t", runId: "r", scope, records, evidenceRefs: [], deterministicChecks: runDeterministicChecks(records, scope), approvedPolicies: [], humanClarifications: [] };
}
const DOC = "demo:document:remit-a-001:v1";
const out = (findings: FinanceAgentOutput["findings"]): FinanceAgentOutput => ({ schemaVersion: FINANCE_OUTPUT_VERSION, outcome: "findings", summary: "s", findings, questions: [], proposedAllocations: [], proposedActions: [], candidatePolicies: [] });
function checkerInput(): CheckerInput {
  const i = input();
  return buildCheckerInput("run-1", i, codeCheckClaims(out([
    { findingId: "supported", summary: "The remittance names DEMO Alpha Holdings Trust for $1,500.00.", sourceRefs: [DOC] },
    { findingId: "vague", summary: "The payer seems to be a regular client.", sourceRefs: [DOC] },
  ]), i));
}
const verdict = (findingId: string, fields: Record<string, unknown> = {}) => ({ findingId, verdict: "supported", sourceIds: [DOC], sourceSays: null, reason: "The remittance says so.", ...fields });

describe("checker input and strict output validation", () => {
  it("sends the investigator's frozen input unchanged plus each claim with code's verdict", () => {
    const c = checkerInput();
    expect(c).toMatchObject({ schemaVersion: "finance-claim-check-input/v1", instructionVersion: "finance-claim-checker/v1", runId: "run-1" });
    expect(c.investigationInput).toEqual(input());
    expect(c.claims.map(x => [x.findingId, x.codeVerdict])).toEqual([["supported", "supported"], ["vague", "not_checkable"]]);
  });

  it("accepts exactly one verdict per claim, in order, citing only that claim's sourceIds", () => {
    const c = checkerInput();
    expect(validateCheckerOutput({ schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: [verdict("supported"), verdict("vague", { verdict: "not_checkable", sourceIds: [] })] }, c).verdicts).toHaveLength(2);
  });

  it.each([
    ["an extra field", { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: [], note: "hi" }, "$[property#2]"],
    ["a missing verdict", { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: [verdict("supported")] }, "$.verdicts"],
    ["reordered findingIds", { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: [verdict("vague"), verdict("supported")] }, "$.verdicts[0].findingId"],
    ["a citation the claim doesn't make", { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: [verdict("supported", { sourceIds: ["demo:document:other:v1"] }), verdict("vague")] }, "$.verdicts[0].sourceIds"],
    ["a supported verdict with no sourceIds", { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: [verdict("supported", { sourceIds: [] }), verdict("vague")] }, "$.verdicts[0].sourceIds"],
    ["a not_supported verdict without the source's text", { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: [verdict("supported"), verdict("vague", { verdict: "not_supported" })] }, "$.verdicts[1].sourceSays"],
    ["a quote that isn't verbatim", { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: [verdict("supported"), verdict("vague", { verdict: "not_supported", sourceSays: "Amount: $9,999.00" })] }, "$.verdicts[1].sourceSays"],
    ["a wrong schemaVersion", { schemaVersion: "v2", verdicts: [] }, "$.schemaVersion"],
  ])("rejects %s and never repairs it", (_, value, path) => {
    expect(() => validateCheckerOutput(value, checkerInput())).toThrow(expect.objectContaining({ code: "checker_validation_failed", details: [expect.objectContaining({ path })] }));
  });

  it("accepts a verbatim quote of what the source actually says", () => {
    const value = { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: [verdict("supported"), verdict("vague", { verdict: "not_supported", sourceSays: "Payer: DEMO Alpha Payer LLC" })] };
    expect(validateCheckerOutput(value, checkerInput()).verdicts[1].sourceSays).toBe("Payer: DEMO Alpha Payer LLC");
  });
});

describe("combining code and agent verdicts", () => {
  const code = [
    { findingId: "a", claim: "x", sourceRefs: [], verdict: "not_supported" as const, checkedBy: "code" as const, reason: "code says no", facts: [], missing: ["$1.00"], sourceSays: "src" },
    { findingId: "b", claim: "y", sourceRefs: [], verdict: "supported" as const, checkedBy: "code" as const, reason: "code says yes", facts: ["$1.00"], missing: [], sourceSays: null },
    { findingId: "c", claim: "z", sourceRefs: [], verdict: "not_checkable" as const, checkedBy: "none" as const, reason: "no facts", facts: [], missing: [], sourceSays: null },
  ];
  it("keeps a code contradiction final, lets the agent find one code missed, and decides only what code couldn't", () => {
    const combined = combineVerdicts(code, [
      { findingId: "a", verdict: "supported", reason: "agent overrules" },
      { findingId: "b", verdict: "not_supported", reason: "the meaning differs", sourceSays: "src text" },
      { findingId: "c", verdict: "supported", reason: "agent confirms" },
    ]);
    expect(combined.map(c => [c.verdict, c.checkedBy])).toEqual([["not_supported", "code"], ["not_supported", "agent"], ["supported", "agent"]]);
    expect(combineVerdicts(code, [{ findingId: "b", verdict: "not_checkable", reason: "unsure" }])[1].verdict).toBe("supported");
  });
});

describe("the checker behind the provider interface", () => {
  it("CHECKER_MODE is mock by default; anything other than mock or creao is a configuration error", () => {
    expect(parseCheckerMode(undefined)).toBe("mock");
    expect(parseCheckerMode(" CREAO ")).toBe("creao");
    expect(parseCheckerMode("off")).toBeNull();
  });

  it("the mock answers every claim with a valid output that agrees with code", async () => {
    const c = checkerInput();
    const execution = await mockClaimCheckerProvider.start(c);
    expect(execution.status).toBe("completed");
    const validated = validateCheckerOutput((execution as { output: unknown }).output, c);
    const result = finalizeClaimCheck(codeCheckClaims(out([{ findingId: "supported", summary: "The remittance names DEMO Alpha Holdings Trust for $1,500.00.", sourceRefs: [DOC] }, { findingId: "vague", summary: "The payer seems to be a regular client.", sourceRefs: [DOC] }]), input()), validated, "mock", 1);
    expect(result).toMatchObject({ agentMode: "mock", status: "passed" });
    expect(mockCheckerOutput(c).verdicts[0]).toMatchObject({ verdict: "supported", sourceIds: [DOC] });
  });

  it("the CREAO adapter posts the frozen input as finance_context to the checker app and reads back raw JSON", async () => {
    const report = { schemaVersion: CHECKER_OUTPUT_VERSION, verdicts: [verdict("supported"), verdict("vague", { verdict: "not_checkable", sourceIds: [] })] };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "checker-run-1" }))
      .mockResolvedValueOnce(Response.json({ id: "checker-run-1", status: "running" }))
      .mockResolvedValueOnce(Response.json({ id: "checker-run-1", status: "completed", result: { text: JSON.stringify(report) } }));
    const provider = new CreaoClaimCheckerProvider("checker-app", "capi_test_only", fetchImpl);
    const c = checkerInput();
    expect(await provider.start(c)).toEqual({ status: "pending", externalRunId: "checker-run-1" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://agent.creao.ai/api/v1/apps/checker-app/runs");
    expect(JSON.parse(String(init?.body))).toEqual({ inputs: { finance_context: JSON.stringify(c) } });
    expect(await provider.poll("checker-run-1")).toEqual({ status: "pending", externalRunId: "checker-run-1" });
    const done = await provider.poll("checker-run-1");
    expect(done).toMatchObject({ status: "completed", output: report, reportSource: { field: "result.text", format: "json" } });
  });

  it("a refused start (503) is retryable once; a 500 start may have created a paid run and is not", async () => {
    const c = checkerInput();
    await expect(new CreaoClaimCheckerProvider("a", "capi_x", vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }))).start(c)).rejects.toMatchObject({ code: "provider_http_503", retryable: true });
    await expect(new CreaoClaimCheckerProvider("a", "capi_x", vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 500 }))).start(c)).rejects.toMatchObject({ code: "provider_http_500", retryable: false });
    await expect(new CreaoClaimCheckerProvider("a", "capi_x", vi.fn<typeof fetch>().mockRejectedValue(new Error("socket hang up"))).start(c)).rejects.toMatchObject({ code: "provider_start_ambiguous", retryable: false });
  });

  it("refuses to build the CREAO checker without its own app ID and an app-scoped key", () => {
    expect(() => createClaimCheckerProvider({ mode: "creao", appId: "", apiKey: "capi_x" })).toThrow("CREAO_CHECKER_APP_ID");
    expect(() => createClaimCheckerProvider({ mode: "creao", appId: "app", apiKey: "cr_sk_account_key" })).toThrow(expect.objectContaining({ code: "configuration_error" }));
    expect(createClaimCheckerProvider({ mode: "mock" })).toBe(mockClaimCheckerProvider);
  });
});
