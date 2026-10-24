import { FINANCE_INPUT_VERSION, FINANCE_INSTRUCTION_VERSION, type FinanceAgentInput, type InvestigationScope } from "@mangekyo/contracts";
import { describe, expect, it } from "vitest";
import { createSeed } from "../../../apps/demo-erp/data/seed";
import { mockInvestigation } from "../src/agent/mock";
import { validateFinanceAgentOutput } from "../src/agent/validation";
import { runDeterministicChecks } from "../src/checks";
import { buildDepositRecordSet, depositCaseId } from "../src/intake/context";
import { normalizeErpState, type ErpState } from "../src/intake/erp";
import { threeWayCheck, type AccountLedgerState } from "../src/ledger";
import { demoIds, demoMoneyBundle } from "../fixtures/demoMoney";
import { NOW, stateFrom } from "./money";

function inputFor(bundle: ReturnType<typeof demoMoneyBundle>, depositSourceId: string, state: AccountLedgerState = stateFrom(bundle)): FinanceAgentInput {
  const scope: InvestigationScope = { kind: "deposit_investigation", accountId: bundle.account.accountId, currency: "USD", from: null, cutoff: NOW };
  const deposit = bundle.bankTransactions.find(t => t.sourceId === depositSourceId)!;
  const records = buildDepositRecordSet({ state, documents: bundle.documents, obligations: bundle.obligations, deposit, caseId: depositCaseId(bundle.account.accountId), system: bundle.account.raw.system === "demo" ? "demo" : "erp", datasetVersion: bundle.account.raw.datasetVersion, scope });
  return {
    schemaVersion: FINANCE_INPUT_VERSION, instructionVersion: FINANCE_INSTRUCTION_VERSION, caseId: depositCaseId(bundle.account.accountId), taskId: "t", runId: "r", scope, contextAsOf: NOW,
    records, evidenceRefs: [], deterministicChecks: { ...runDeterministicChecks(records, scope), threeWay: threeWayCheck(state, NOW) }, approvedPolicies: [], humanClarifications: [],
  };
}

describe("deposit investigation context", () => {
  it("scopes ERP TX-002 to its deposit, candidate owner, linked and agreement documents", () => {
    const bundle = normalizeErpState(createSeed(42) as ErpState);
    const input = inputFor(bundle, "bank:txn:TX-002");
    expect(input.records.transactions.map(t => t.sourceId)).toEqual(["bank:txn:TX-002"]);
    expect(input.records.owners.map(o => o.name)).toEqual(["Client B — Brookstone Trust"]);
    expect(input.records.documents.map(d => d.sourceId)).toEqual(["erp:document:DOC-OWN-002:v1", "erp:document:DOC-AGREE-001:v1"]);
    expect(input.records.agreements.map(a => a.sourceId)).toEqual(["erp:document:DOC-AGREE-001:v1"]);
    expect(input.records.allocationHistoryComplete).toBe(true);
    expect(input.records.ownerLedgerBalances?.[0]).toMatchObject({ ownerId: "erp:owner:CMP-002", postedCents: 5_500_000 });
    expect(input.records.sourceAdapter).toEqual({ system: "erp", datasetVersion: "demo-erp-seed-42", accountId: "erp:account:trust-pool" });
    expect(JSON.stringify(input).length).toBeLessThan(60_000);
  });

  it("excludes pending deposits from v1 transactions and says why", () => {
    const bundle = demoMoneyBundle();
    const input = inputFor(bundle, demoIds.depositD);
    expect(input.records.transactions).toEqual([]);
    expect(input.records.missingEvidence.join()).toContain("has not cleared");
  });
});

describe("mock provider on adapter input (scenario A and B)", () => {
  it("A: proposes ERP TX-001 to Client A from its payment confirmation and passes the unchanged validator", () => {
    const input = inputFor(normalizeErpState(createSeed(42) as ErpState), "bank:txn:TX-001");
    const output = validateFinanceAgentOutput(mockInvestigation(input), input);
    expect(output.outcome).toBe("proposal_ready");
    expect(output.proposedAllocations).toEqual([{ proposalId: "mock-allocation:bank:txn:TX-001", transactionId: "bank:txn:TX-001", ownerId: "erp:owner:CMP-001", amountCents: 325_000, currency: "USD", evidenceSourceIds: ["bank:txn:TX-001", "erp:document:DOC-PAY-001:v1"] }]);
    expect(output.findings.map(f => f.summary).join()).toContain("possible partial payment");
  });

  it("A (demo): proposes demo deposit A-001 to DEMO Alpha", () => {
    const input = inputFor(demoMoneyBundle(), demoIds.depositA);
    expect(validateFinanceAgentOutput(mockInvestigation(input), input).proposedAllocations[0]).toMatchObject({ ownerId: demoIds.alpha, amountCents: 150_000 });
  });

  it("B: asks a question for the vague demo deposit instead of allocating", () => {
    const input = inputFor(demoMoneyBundle(), demoIds.depositB);
    const output = validateFinanceAgentOutput(mockInvestigation(input), input);
    expect(output.outcome).toBe("needs_information");
    expect(output.proposedAllocations).toEqual([]);
    expect(output.questions[0].question).toContain("$980.00");
  });

  it("does not re-propose after a reviewer rejection is supplied as clarification", () => {
    const input = inputFor(normalizeErpState(createSeed(42) as ErpState), "bank:txn:TX-001");
    input.humanClarifications = [{ clarificationId: "c", sourceId: "clarification:c", questionId: "p:rejection", question: "Why was the allocation rejected?", answer: "Payer is not Client A", caseId: input.caseId, taskId: "t", runId: "r", timestamp: NOW, respondent: { identity: "dev", authenticated: false }, evidenceRefs: [] }];
    expect(validateFinanceAgentOutput(mockInvestigation(input), input).outcome).toBe("needs_information");
  });

  it("the validator still rejects an allocation that cites an invented source", () => {
    const input = inputFor(normalizeErpState(createSeed(42) as ErpState), "bank:txn:TX-001");
    const output = mockInvestigation(input);
    output.proposedAllocations[0].evidenceSourceIds = ["erp:document:FAKE:v1"];
    expect(() => validateFinanceAgentOutput(output, input)).toThrow("Citation does not exist");
  });
});
