import type { NormalizedAccountBundle } from "@mangekyo/contracts";
import { describe, expect, it } from "vitest";
import { lawFirmBundle } from "../fixtures/lawFirm";
import { INSURANCE_POLICY } from "../fixtures/lawFirmFeed";
import { backtestPolicy, INVOICE_POLICY } from "../src/policy";
import { entry, NOW, stateFrom } from "./money";

const claim = (id: string, reference: string, document: string) => ({ sourceId: `demo:bank:txn:${id}`, accountId: "demo:account:pool-001", subAccount: "IOLTA", direction: "inflow" as const, amountCents: 1_000_000, currency: "USD", bookedAt: NOW - 10_000,
  clearing: "cleared" as const, reference, counterparty: "Harborline Insurance", ownerHintSourceId: null, documentSourceIds: [`demo:document:${document}:v1`], duplicateOfSourceId: null, raw: { system: "demo" as const, recordType: "bank-transaction", rawId: id, datasetVersion: "test" } });
const allocated = (id: string, ownerKey: string) => entry({ entryId: `alloc:${id}`, ownerId: `demo:owner:${ownerKey}`, amountCents: 1_000_000, kind: "allocation", fundsSourceId: `demo:bank:txn:${id}` });

function history(decisions: Array<[string, string, string, string]>) {
  const bundle: NormalizedAccountBundle = lawFirmBundle();
  bundle.bankTransactions = decisions.map(([id, reference, document]) => claim(id, reference, document));
  const state = stateFrom(bundle);
  state.entries.push(...decisions.map(([id, , , owner]) => allocated(id, owner)));
  return { state, documents: bundle.documents, obligations: bundle.obligations };
}

describe("policy backtest", () => {
  it("replays the insurance rule over past decided deposits and agrees when people decided the same", () => {
    const h = history([["delgado", "Claim HL-44812", "delgado-settlement", "maria-delgado"], ["westbrook", "Claim HL-50210", "westbrook-settlement", "westbrook"]]);
    const result = backtestPolicy(INSURANCE_POLICY, h.state, h);
    expect(result).toMatchObject({ testable: true, handled: 2, agree: 2, disagree: 0, reasonRequired: false });
    expect(result.summary).toBe("Would have handled 2 past deposits: 2 agree with what people decided, 0 disagree.");
  });

  it("counts a disagreement when a person allocated a claim check to someone else, and then requires a reason", () => {
    const h = history([["delgado", "Claim HL-44812", "delgado-settlement", "maria-delgado"], ["westbrook", "Claim HL-50210", "westbrook-settlement", "chen-park"]]);
    const result = backtestPolicy(INSURANCE_POLICY, h.state, h);
    expect(result).toMatchObject({ handled: 2, agree: 1, disagree: 1, reasonRequired: true });
    expect(result.cases.find(c => !c.agrees)).toMatchObject({ predictedOwnerId: "demo:owner:westbrook", decidedOwnerIds: ["demo:owner:chen-park"] });
  });

  it("ignores deposits nobody decided and deposits the rule doesn't cover", () => {
    const h = history([["okafor", "Estate retainer", "okafor-engagement", "maria-delgado"]]);
    expect(backtestPolicy(INSURANCE_POLICY, h.state, h)).toMatchObject({ handled: 0, agree: 0, disagree: 0, reasonRequired: false });
    expect(backtestPolicy(INVOICE_POLICY, h.state, h).testable).toBe(true);
  });

  it("a rule with no executable form can't be backtested, so approving it needs a written reason", () => {
    const h = history([]);
    expect(backtestPolicy("For human review: be careful with deposits.", h.state, h)).toMatchObject({ testable: false, reasonRequired: true, statement: "be careful with deposits." });
  });
});
