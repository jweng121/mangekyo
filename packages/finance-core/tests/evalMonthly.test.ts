import type { FinanceInvestigationRun } from "@mangekyo/contracts";
import { describe, expect, it } from "vitest";
import { lawFirmBundle } from "../fixtures/lawFirm";
import { evalCaseFromCorrection, evalCaseFromRejection, replayIntakeCase, summarizeEval } from "../src/eval";
import { monthEnd, monthlyReconciliation } from "../src/reconciliation/monthly";
import { entry, NOW, stateFrom } from "./money";
import { sampleInput } from "./fixtures";

function rejectedRun(): FinanceInvestigationRun {
  const input = sampleInput();
  const result = { schemaVersion: "finance-investigation-output/v1" as const, outcome: "proposal_ready" as const, summary: "x", findings: [{ findingId: "f1", summary: "The note names SYNTHETIC candidate for $9,999.00.", sourceRefs: ["note:1"] }], questions: [], proposedAllocations: [{ proposalId: "p", transactionId: "deposit-1", ownerId: "owner-1", amountCents: 125000, currency: "USD", evidenceSourceIds: ["note:1"] }], proposedActions: [], candidatePolicies: [] };
  return { caseId: "c", taskId: "task-1", runId: "run-1", parentRunId: null, attempt: 1, mode: "mock", simulated: true, status: "checker_rejected", scope: input.scope, createdAt: 1, updatedAt: 2, externalRunId: null, providerInput: input, result, error: null,
    claimCheck: { schemaVersion: "finance-claim-check/v1", agentMode: "mock", status: "rejected", checkedAt: 2, claims: [{ findingId: "f1", claim: result.findings[0].summary, sourceRefs: ["note:1"], verdict: "not_supported", checkedBy: "code", reason: "missing $9,999.00", facts: ["$9,999.00"], missing: ["$9,999.00"], sourceSays: "May belong" }] } };
}

describe("eval cases", () => {
  it("a checker rejection becomes a case that fails if the agent repeats the claim and passes once it stops", () => {
    const run = rejectedRun();
    const evalCase = evalCaseFromRejection(run, NOW)!;
    expect(evalCase).toMatchObject({ agent: "intake", kind: "checker_rejection", expectation: { mustNotRepeatClaim: "The note names SYNTHETIC candidate for $9,999.00." } });
    expect(replayIntakeCase(evalCase, () => run.result!)).toMatchObject({ verdict: "failed", detail: expect.stringContaining("repeated the claim") });
    const better = { ...run.result!, outcome: "needs_information" as const, findings: [], proposedAllocations: [], questions: [{ key: "who", question: "Who sent it?", sourceRefs: ["note:1"] }] };
    expect(replayIntakeCase(evalCase, () => better).verdict).toBe("changed");
    expect(replayIntakeCase({ ...evalCase, observedOutput: better }, () => better).verdict).toBe("passed");
    expect(replayIntakeCase(evalCase, () => { throw new Error("boom"); })).toMatchObject({ verdict: "failed", detail: "The agent threw: boom" });
    expect(evalCaseFromRejection({ ...run, status: "completed" }, NOW)).toBeNull();
  });

  it("a correction becomes a case that expects the corrected outcome and owner", () => {
    const old = rejectedRun();
    const fixed: FinanceInvestigationRun = { ...old, runId: "run-2", parentRunId: "run-1", attempt: 2, status: "review_required", result: { ...old.result!, findings: [{ findingId: "f1", summary: "A person said the deposit is the candidate's.", sourceRefs: ["note:1"] }] } };
    const evalCase = evalCaseFromCorrection(old, fixed, "cite_clarification", NOW)!;
    expect(evalCase.expectation).toMatchObject({ expectedOutcome: "proposal_ready", expectedOwnerId: "owner-1" });
    expect(replayIntakeCase(evalCase, () => fixed.result!).verdict).toBe("passed");
    expect(replayIntakeCase(evalCase, () => ({ ...fixed.result!, proposedAllocations: [], outcome: "findings" as const })).detail).toContain("outcome findings, expected proposal_ready");
    const report = summarizeEval("e1", "intake", "finance-investigator/v1", [{ evalCaseId: "a", verdict: "passed", detail: "" }, { evalCaseId: "b", verdict: "failed", detail: "" }, { evalCaseId: "c", verdict: "changed", detail: "" }], NOW);
    expect(report).toMatchObject({ passed: 1, failed: 1, changed: 1, total: 3, mode: "mock" });
  });
});

describe("monthly reconciliation report", () => {
  it("computes bank, books, each client ledger and the reconciling items at the month's end", () => {
    const state = stateFrom(lawFirmBundle());
    state.entries.push(entry({ entryId: "pay:1", ownerId: "demo:owner:westbrook", amountCents: -100_000, kind: "disbursement", bankReference: "PAY:1", sourceRefs: ["demo:document:westbrook-settlement:v1"], effectiveAt: Date.UTC(2026, 9, 20) }));
    const report = monthlyReconciliation(state, "2026-10", { outstandingMaxDays: 30, now: Date.UTC(2026, 9, 31, 23, 59) });
    expect(report).toMatchObject({ month: "2026-10", periodEnd: Date.UTC(2026, 10, 1) - 1, bookCents: 33_850_000, threeWay: { status: "matched", bankMinusBook: 0 } });
    expect(report.bank.adjustedCents).toBe(33_850_000);
    expect(report.clientLedgers.map(l => l.ownerKind)).toEqual(["client", "client", "client", "client", "client", "client", "firm", "unallocated"]);
    expect(report.reconcilingItems).toEqual([expect.objectContaining({ kind: "outstanding_payment", entryId: "pay:1", amountCents: -100_000 })]);
    expect(() => monthEnd("2026-13")).toThrow("YYYY-MM");
    expect(monthlyReconciliation(state, "2026-09").threeWay.status).toBe("insufficient_data");
  });
});
