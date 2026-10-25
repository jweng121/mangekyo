import type { NormalizedBankTransaction } from "@mangekyo/contracts";
import { describe, expect, it } from "vitest";
import { DELGADO_FEE_AGREEMENT, DELGADO_MATTER, DELGADO_STATEMENT, FIRM_OWNER, lawFirmBundle } from "../fixtures/lawFirm";
import { buildDisbursementInput, codeCheckPayoutLines, disbursementClaims, matterForDeposit, mockDisbursement, validateDisbursementOutput, type DisbursementInput } from "../src/disbursement";
import { entry, NOW, stateFrom } from "./money";

const DEPOSIT = "demo:bank:txn:harborline-delgado";
const DELGADO = "demo:owner:maria-delgado";

function input(mutate: (bundle: ReturnType<typeof lawFirmBundle>) => void = () => undefined): DisbursementInput {
  const bundle = lawFirmBundle();
  mutate(bundle);
  const deposit: NormalizedBankTransaction = { sourceId: DEPOSIT, accountId: bundle.account.accountId, subAccount: "IOLTA", direction: "inflow", amountCents: 8_500_000, currency: "USD", bookedAt: NOW - 5000, clearing: "cleared", reference: "Claim HL-44812", counterparty: "Harborline Insurance", ownerHintSourceId: null, documentSourceIds: ["demo:document:delgado-settlement:v1", DELGADO_STATEMENT], duplicateOfSourceId: null, raw: { system: "demo", recordType: "bank-transaction", rawId: "harborline-delgado", datasetVersion: "law-firm-demo-v1" } };
  bundle.bankTransactions = [deposit];
  const state = stateFrom(bundle);
  state.entries.push(entry({ entryId: "alloc:1", ownerId: null, amountCents: -8_500_000, kind: "allocation", fundsSourceId: DEPOSIT }), entry({ entryId: "alloc:2", ownerId: DELGADO, amountCents: 8_500_000, kind: "allocation", fundsSourceId: DEPOSIT }));
  const matter = matterForDeposit(deposit, bundle.documents);
  return buildDisbursementInput({ runId: "d1", state, documents: bundle.documents, obligations: [], matterId: matter?.matterId ?? DELGADO_MATTER, clientOwnerId: DELGADO, settlementDeposit: deposit, cutoff: NOW, approvedPolicies: [], humanClarifications: [] });
}

describe("Disbursement agent", () => {
  it("finds the matter from the deposit's signed settlement statement and gives the agent only that matter's records", () => {
    const i = input();
    expect(i.matterId).toBe(DELGADO_MATTER);
    expect(i.client.name).toBe("Maria Delgado");
    expect(i.firm?.ownerId).toBe(FIRM_OWNER.ownerId);
    expect(i.documents.map(d => d.sourceId).sort()).toEqual([DELGADO_FEE_AGREEMENT, "demo:document:delgado-settlement:v1", DELGADO_STATEMENT].sort());
    expect(i.clientBalance?.postedCents).toBe(8_500_000);
  });

  it("proposes exactly the signed statement's three lines, each backed by a signed document, and every claim checks out", () => {
    const i = input();
    const output = validateDisbursementOutput(JSON.parse(JSON.stringify(mockDisbursement(i))), i);
    expect(output.outcome).toBe("proposal_ready");
    expect(output.lines.map(l => [l.kind, l.amountCents, l.payeeOwnerId])).toEqual([["attorney_fee", 2_805_000, FIRM_OWNER.ownerId], ["costs", 95_000, FIRM_OWNER.ownerId], ["client_share", 5_600_000, null]]);
    expect(output.lines[0].sourceRefs).toEqual([DELGADO_STATEMENT, DELGADO_FEE_AGREEMENT]);
    expect(codeCheckPayoutLines(output, i).every(c => c.supported)).toBe(true);
    const claims = disbursementClaims(output, i);
    expect(claims.map(c => c.verdict)).toEqual(claims.map(() => "supported"));
    expect(claims.find(c => c.findingId === "payout:line-3")?.facts).toEqual(["$56,000.00", "Maria Delgado"]);
  });

  it("asks a person when the statement's lines don't add up to the deposit, and proposes nothing", () => {
    const i = input(b => { b.documents = b.documents.map(d => d.sourceId === DELGADO_STATEMENT ? { ...d, lines: d.lines!.map(l => l.kind === "client_share" ? { ...l, amountCents: 5_500_000 } : l) } : d); });
    const output = mockDisbursement(i);
    expect(output).toMatchObject({ outcome: "needs_information", lines: [] });
    expect(output.questions).toEqual([{ key: "statement-does-not-add-up", question: "The signed settlement statement's lines total $84,000.00 but the deposit is $85,000.00. Which line is wrong, or is there a missing line?", sourceRefs: [DELGADO_STATEMENT, DEPOSIT] }]);
  });

  it("asks when the fee agreement is unsigned, when the statement is unsigned, and when the fee doesn't match the agreement", () => {
    expect(mockDisbursement(input(b => { b.documents = b.documents.map(d => d.sourceId === DELGADO_FEE_AGREEMENT ? { ...d, signed: false } : d); })).questions[0].key).toBe("missing-fee-agreement");
    expect(mockDisbursement(input(b => { b.documents = b.documents.map(d => d.sourceId === DELGADO_STATEMENT ? { ...d, signed: false } : d); })).questions[0].key).toBe("unsigned-statement");
    const wrong = mockDisbursement(input(b => { b.documents = b.documents.map(d => d.sourceId === DELGADO_FEE_AGREEMENT ? { ...d, feeBasisPoints: 4000 } : d); }));
    expect(wrong.questions[0].question).toContain("40% of $85,000.00 is $34,000.00");
  });

  it("validation is strict: no extra fields, every line cites a signed document, at most 3 questions, nothing repaired", () => {
    const i = input();
    const good = mockDisbursement(i);
    expect(() => validateDisbursementOutput({ ...good, extra: 1 }, i)).toThrow("Unsupported field");
    expect(() => validateDisbursementOutput({ ...good, lines: good.lines.map(l => ({ ...l, sourceRefs: ["demo:document:okafor-engagement:v1"] })) }, i)).toThrow("Citation does not exist");
    const unsignedOnly = input(b => { b.documents = b.documents.map(d => d.sourceId === "demo:document:delgado-settlement:v1" ? { ...d, signed: false } : d); });
    expect(() => validateDisbursementOutput({ ...good, lines: good.lines.map(l => ({ ...l, sourceRefs: ["demo:document:delgado-settlement:v1"] })) }, unsignedOnly)).toThrow("must cite a signed document");
    expect(() => validateDisbursementOutput({ ...good, outcome: "needs_information", lines: [], questions: [1, 2, 3, 4].map(n => ({ key: `q${n}`, question: "?", sourceRefs: [] })) }, i)).toThrow("at most 3 questions");
    expect(() => validateDisbursementOutput({ ...good, lines: [{ ...good.lines[0], amountCents: 2805000.5 }] }, i)).toThrow("positive integer cents");
    // Code refuses a line the signed statement doesn't have, even when the agent cited the statement.
    const tampered = { ...good, lines: good.lines.map(l => l.kind === "costs" ? { ...l, amountCents: 100_000 } : l) };
    expect(codeCheckPayoutLines(validateDisbursementOutput(tampered, i), i).filter(c => !c.supported).map(c => c.lineId)).toEqual(["line-2", "all-lines"]);
  });
});
