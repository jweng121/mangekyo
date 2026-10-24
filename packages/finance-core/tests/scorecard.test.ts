import { describe, expect, it } from "vitest";
import { BATCH_EXPECT, batchBundle, batchKindOf, PLANTS, scorePlant, summarizeBatch, summarizePlants, type BatchRow } from "../src/scorecard";
import { mockInvestigation } from "../src/agent/mock";
import { validateFinanceAgentOutput } from "../src/agent/validation";
import { codeCheckClaims } from "../src/checker";
import { runDeterministicChecks } from "../src/checks";
import { buildDepositRecordSet, depositCaseId } from "../src/intake/context";
import { FINANCE_INPUT_VERSION, FINANCE_INSTRUCTION_VERSION } from "@mangekyo/contracts";
import { NOW, stateFrom } from "./money";

const id = (suffix: string) => `demo:${suffix}`;

describe("planted-mistake scorecard", () => {
  it("has six planted mistakes, each with a known right answer and who should catch it", () => {
    expect(PLANTS.map(p => p.key)).toEqual(["wrong-client", "duplicate", "uncleared-payout", "overdraw", "unsupported-claim", "bounced-check"]);
    expect(PLANTS.every(p => p.rightAnswer.length > 20 && p.mistake.length > 20)).toBe(true);
  });

  it("scores catches, misses and unfinished work", () => {
    const [wrongClient, duplicate, uncleared, , , bounced] = PLANTS;
    expect(scorePlant(wrongClient, { state: "rejected" }, id)).toMatchObject({ status: "caught", askedPerson: false });
    expect(scorePlant(wrongClient, { state: "ready_for_approval", allocationReachedApproval: true }, id).status).toBe("wrong");
    expect(scorePlant(duplicate, { state: "needs_person" }, id)).toMatchObject({ status: "caught", askedPerson: true });
    expect(scorePlant(duplicate, { state: "investigating" }, id).status).toBe("pending");
    expect(scorePlant(uncleared, { state: null, payment: { status: "blocked", rules: ["L1", "L2"] } }, id).status).toBe("caught");
    expect(scorePlant(uncleared, { state: null, payment: { status: "pending_approval", rules: [] } }, id).status).toBe("wrong");
    expect(scorePlant(bounced, { state: "needs_person", correction: { ownerId: id("owner:daniel-okafor"), amountCents: -250_000, status: "proposed" } }, id)).toMatchObject({ status: "caught", askedPerson: true });
    expect(scorePlant(bounced, { state: "needs_person", correction: { ownerId: id("owner:raymond-cho"), amountCents: -250_000, status: "proposed" } }, id).status).toBe("wrong");
    expect(summarizePlants([{ key: "duplicate", status: "caught", askedPerson: true, detail: "" }, { key: "overdraw", status: "caught", askedPerson: false, detail: "" }]).line).toBe("Caught 2 of 2 · wrong 0 · asked a person 1");
  });
});

describe("batch mode", () => {
  it("generates the same 200 deposits every time, with a mix of known right answers", () => {
    const a = batchBundle("demo:account:pool-001", 200, NOW);
    expect(a.bankTransactions).toHaveLength(200);
    expect(batchBundle("demo:account:pool-001", 200, NOW)).toEqual(a);
    const kinds = new Set(a.bankTransactions.map(t => batchKindOf(t.raw.rawId)));
    expect([...kinds].sort()).toEqual(["clear", "duplicate", "invoice", "partial", "pending", "planted", "vague"]);
    expect(a.statementBalances[0].amountCents).toBe(a.openingBalances.reduce((s, o) => s + o.amountCents, 0));
  });

  it("the mock investigator reaches each kind's right answer before the checker (planted ones are stopped by code)", () => {
    const bundle = batchBundle("demo:account:pool-001", 80, NOW);
    const state = stateFrom(bundle);
    for (const deposit of bundle.bankTransactions) {
      const kind = batchKindOf(deposit.raw.rawId)!;
      const scope = { kind: "deposit_investigation" as const, accountId: bundle.account.accountId, currency: "USD", from: null, cutoff: NOW };
      const records = buildDepositRecordSet({ state, documents: bundle.documents, obligations: bundle.obligations, deposit, caseId: depositCaseId(bundle.account.accountId), system: "demo", datasetVersion: "synthetic-batch-v1", scope });
      const input = { schemaVersion: FINANCE_INPUT_VERSION, instructionVersion: FINANCE_INSTRUCTION_VERSION, caseId: "c", taskId: "t", runId: "r", scope, records, evidenceRefs: [], deterministicChecks: runDeterministicChecks(records, scope), approvedPolicies: [], humanClarifications: [] };
      const output = validateFinanceAgentOutput(mockInvestigation(input), input);
      const rejected = codeCheckClaims(output, input).some(c => c.verdict === "not_supported");
      const expected = BATCH_EXPECT[kind];
      if (expected === "rejected") expect(rejected).toBe(true);
      else expect(rejected, `${kind} ${deposit.sourceId}`).toBe(false);
      if (expected === "ready_for_approval") expect(output.outcome, deposit.sourceId).toBe("proposal_ready");
      if (expected === "needs_person") expect(output.outcome, deposit.sourceId).toBe("needs_information");
      if (expected === "waiting_to_clear") expect(output.outcome).toBe("findings");
    }
  });

  it("reports time taken, % handled without a person and % flagged", () => {
    const rows: BatchRow[] = [
      { kind: "clear", state: "ready_for_approval", attempts: 1, settledAt: 4_000 },
      { kind: "invoice", state: "ready_for_approval", attempts: 1, settledAt: 2_000 },
      { kind: "vague", state: "needs_person", attempts: 1, settledAt: 3_000 },
      { kind: "planted", state: "rejected", attempts: 1, settledAt: 1_500 },
    ];
    expect(summarizeBatch(rows, 1_000)).toMatchObject({ settled: 4, durationMs: 3_000, handledWithoutPerson: 2, flagged: 2, pctHandled: 50, pctFlagged: 50, matchedRightAnswer: 4,
      line: "4 deposits in 3.0 s · 50% handled without a person · 50% flagged · 4 of 4 matched the right answer" });
    expect(summarizeBatch([{ ...rows[0], state: "investigating" }], 0)).toMatchObject({ durationMs: null, line: "0 of 1 deposits settled so far" });
  });
});
