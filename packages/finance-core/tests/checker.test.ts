import { FINANCE_INPUT_VERSION, FINANCE_INSTRUCTION_VERSION, FINANCE_OUTPUT_VERSION, type FinanceAgentInput, type FinanceAgentOutput } from "@mangekyo/contracts";
import { describe, expect, it } from "vitest";
import { checkClaims, claimFacts, codeCheckClaims, combineVerdicts, mockClaimChecker } from "../src/checker";
import { runDeterministicChecks } from "../src/checks";
import { buildDepositRecordSet, depositCaseId } from "../src/intake/context";
import { demoIds, demoMoneyBundle } from "../fixtures/demoMoney";
import { NOW, stateFrom } from "./money";

function input(depositSourceId = demoIds.depositA): FinanceAgentInput {
  const bundle = demoMoneyBundle();
  const scope = { kind: "deposit_investigation" as const, accountId: bundle.account.accountId, currency: "USD", from: null, cutoff: NOW };
  const records = buildDepositRecordSet({ state: stateFrom(bundle), documents: bundle.documents, obligations: bundle.obligations, deposit: bundle.bankTransactions.find(t => t.sourceId === depositSourceId)!, caseId: depositCaseId(bundle.account.accountId), system: "demo", datasetVersion: "test", scope });
  return { schemaVersion: FINANCE_INPUT_VERSION, instructionVersion: FINANCE_INSTRUCTION_VERSION, caseId: "c", taskId: "t", runId: "r", scope, records, evidenceRefs: [], deterministicChecks: runDeterministicChecks(records, scope), approvedPolicies: [], humanClarifications: [] };
}
const out = (findings: FinanceAgentOutput["findings"]): FinanceAgentOutput => ({ schemaVersion: FINANCE_OUTPUT_VERSION, outcome: "findings", summary: "s", findings, questions: [], proposedAllocations: [], proposedActions: [], candidatePolicies: [] });

describe("claim checker, code part", () => {
  it("extracts amounts (dollars or cents), dates, references and owner names", () => {
    const facts = claimFacts("DEMO Alpha Holdings Trust paid $1,500.00 (150,000 cents) on 2026-10-20 for DEMO-INV-A-1001.", input()).map(f => f.label);
    expect(facts).toEqual(["$1,500.00", "2026-10-20", "DEMO-INV-A-1001", "DEMO Alpha Holdings Trust"]);
  });

  it("supports a claim whose quoted facts appear in its cited records", () => {
    const [claim] = codeCheckClaims(out([{ findingId: "f", summary: "SIMULATED: DEMO remittance advice names DEMO Alpha Holdings Trust for $1,500.00.", sourceRefs: ["demo:document:remit-a-001:v1"] }]), input());
    expect(claim).toMatchObject({ verdict: "supported", checkedBy: "code", missing: [] });
  });

  it("rejects a claim that cites a record which doesn't say it, and shows what the source says", () => {
    const [claim] = codeCheckClaims(out([{ findingId: "f", summary: "The bank memo names DEMO Owner Y — Yankee Trust as the owner.", sourceRefs: ["demo:document:note-b-001:v1"] }]), input(demoIds.depositB));
    expect(claim).toMatchObject({ verdict: "not_supported", missing: ["DEMO Owner Y — Yankee Trust"] });
    expect(claim.sourceSays).toContain("TRANSFER 4471");
  });

  it("rejects a quoted amount or reference that isn't in the cited record, and unknown sourceIds", () => {
    const [amount, unknown] = codeCheckClaims(out([
      { findingId: "a", summary: "The remittance says $9,999.00.", sourceRefs: ["demo:document:remit-a-001:v1"] },
      { findingId: "b", summary: "Something.", sourceRefs: ["demo:document:invented:v1"] },
    ]), input());
    expect(amount).toMatchObject({ verdict: "not_supported", missing: ["$9,999.00"] });
    expect(amount.sourceSays).toContain("Beneficial owner: DEMO Alpha Holdings Trust");
    expect(unknown).toMatchObject({ verdict: "not_supported", missing: ["demo:document:invented:v1"] });
  });

  it("marks claims with nothing checkable as not checkable, and the result passes unless something is not supported", async () => {
    const result = await checkClaims(input(), out([{ findingId: "f", summary: "The note is unverified.", sourceRefs: ["demo:document:remit-a-001:v1"] }]), "off", null, NOW);
    expect(result).toMatchObject({ status: "passed", agentMode: "off", claims: [expect.objectContaining({ verdict: "not_checkable", checkedBy: "none" })] });
  });
});

describe("claim checker, agent part (mock)", () => {
  it("judges only what code could not, deterministically, from the cited records", async () => {
    const i = input();
    const findings = out([
      { findingId: "overlap", summary: "The remittance advice names the beneficial owner and the payer.", sourceRefs: ["demo:document:remit-a-001:v1"] },
      { findingId: "unrelated", summary: "Weather conditions were excellent.", sourceRefs: ["demo:document:remit-a-001:v1"] },
      { findingId: "contradiction", summary: "The remittance says $9,999.00.", sourceRefs: ["demo:document:remit-a-001:v1"] },
    ]);
    const code = codeCheckClaims(findings, i);
    const agent = await mockClaimChecker.check(i, findings, code);
    expect(agent.map(a => [a.findingId, a.verdict])).toEqual([["overlap", "supported"], ["unrelated", "not_checkable"]]);
    expect(await mockClaimChecker.check(i, findings, code)).toEqual(agent);
    const combined = combineVerdicts(code, [...agent, { findingId: "contradiction", verdict: "supported", reason: "agent tried to overrule" }]);
    expect(combined.find(c => c.findingId === "contradiction")?.verdict).toBe("not_supported");
    expect((await checkClaims(i, findings, "mock", mockClaimChecker, NOW)).status).toBe("rejected");
  });
});
