import type { FinanceAgentInput, FinanceAgentOutput, FinanceInvestigationRun } from "@mangekyo/contracts";
import type { AgentName, CorrectionKind, EvalCase, EvalCaseResult, EvalReport, EvalVerdict } from "@mangekyo/contracts/orchestration";
import { codeCheckClaims } from "../checker";

/**
 * Eval cases: every correction a person made and every checker rejection becomes a replayable case. evaluateInstructions
 * replays them in mock mode and reports passed / failed / changed, so a change to an agent's instructions is measured
 * against what people already decided.
 */

/** A checker rejection: the next version must not repeat the unsupported claim. */
export function evalCaseFromRejection(run: FinanceInvestigationRun, now: number): EvalCase | null {
  if (run.status !== "checker_rejected" || !run.providerInput || !run.result || !run.claimCheck) return null;
  const bad = run.claimCheck.claims.find(c => c.verdict === "not_supported");
  if (!bad) return null;
  return { evalCaseId: `eval:${run.runId}:checker_rejection`, agent: "intake", instructionVersion: run.providerInput.instructionVersion, kind: "checker_rejection", runId: run.runId, taskId: run.taskId,
    input: run.providerInput, observedOutput: run.result, expectation: { mustNotRepeatClaim: bad.claim, mustNotCite: [] }, createdAt: now };
}

/** A correction: replaying the corrected attempt's input must reach the outcome (and owner) the corrected attempt reached. */
export function evalCaseFromCorrection(corrected: FinanceInvestigationRun, newRun: FinanceInvestigationRun, kind: CorrectionKind, now: number): EvalCase | null {
  if (!newRun.providerInput || !newRun.result) return null;
  const owner = newRun.result.proposedAllocations[0]?.ownerId;
  return { evalCaseId: `eval:${newRun.runId}:correction`, agent: "intake", instructionVersion: newRun.providerInput.instructionVersion, kind: "correction", runId: newRun.runId, taskId: newRun.taskId,
    input: newRun.providerInput, observedOutput: newRun.result,
    // For a cited answer, the replay must keep citing whichever of the person's answers the corrected run relied on.
    expectation: { expectedOutcome: newRun.status === "checker_rejected" ? "checker_rejected" : newRun.result.outcome, ...(owner ? { expectedOwnerId: owner } : {}),
      mustCite: kind === "cite_clarification" ? newRun.providerInput.humanClarifications.map(c => c.sourceId).filter(id => newRun.result!.findings.some(f => f.sourceRefs.includes(id)) || newRun.result!.proposedAllocations.some(a => a.evidenceSourceIds.includes(id))) : [] }, createdAt: now };
}

const canonical = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

/** Replays one intake case through the mock and judges it against the expectation; the stored observed output tells "changed" from "passed". */
export function replayIntakeCase(evalCase: EvalCase, agent: (input: FinanceAgentInput) => FinanceAgentOutput): EvalCaseResult {
  const input = evalCase.input as FinanceAgentInput;
  let output: FinanceAgentOutput;
  try { output = agent(input); } catch (error) { return { evalCaseId: evalCase.evalCaseId, verdict: "failed", detail: `The agent threw: ${error instanceof Error ? error.message : "unknown error"}` }; }
  const claims = codeCheckClaims(output, input);
  const rejected = claims.some(c => c.verdict === "not_supported");
  const e = evalCase.expectation;
  const problems: string[] = [];
  if (e.mustNotRepeatClaim !== undefined) {
    if (output.findings.some(f => f.summary.replace(/^SIMULATED: /, "") === e.mustNotRepeatClaim)) problems.push("repeated the claim the checker rejected");
    if (rejected) problems.push(`the code check still rejects a claim: ${claims.find(c => c.verdict === "not_supported")!.reason}`);
  }
  if (e.expectedOutcome !== undefined) {
    const outcome = rejected ? "checker_rejected" : output.outcome;
    if (outcome !== e.expectedOutcome) problems.push(`outcome ${outcome}, expected ${e.expectedOutcome}`);
  }
  if (e.expectedOwnerId !== undefined && !output.proposedAllocations.some(a => a.ownerId === e.expectedOwnerId)) problems.push(`no allocation to ${e.expectedOwnerId}`);
  for (const id of e.mustCite ?? []) if (!output.findings.some(f => f.sourceRefs.includes(id)) && !output.proposedAllocations.some(a => a.evidenceSourceIds.includes(id))) problems.push(`does not cite ${id}`);
  for (const id of e.mustNotCite ?? []) if (output.findings.some(f => f.sourceRefs.includes(id))) problems.push(`cites ${id}`);
  if (problems.length) return { evalCaseId: evalCase.evalCaseId, verdict: "failed", detail: problems.join("; ") };
  // passed: the expectation holds and the answer is the recorded one; changed: the expectation holds but the answer differs.
  const same = canonical(output) === canonical(evalCase.observedOutput);
  const verdict: EvalVerdict = same ? "passed" : "changed";
  return { evalCaseId: evalCase.evalCaseId, verdict, detail: same ? "Same answer as recorded." : "Meets the expectation; the answer differs from the recorded one." };
}

export function summarizeEval(evalRunId: string, agent: AgentName, instructionVersion: string, results: EvalCaseResult[], ranAt: number): EvalReport {
  const count = (v: EvalVerdict) => results.filter(r => r.verdict === v).length;
  return { evalRunId, agent, instructionVersion, mode: "mock", passed: count("passed"), failed: count("failed"), changed: count("changed"), total: results.length, results, ranAt };
}
