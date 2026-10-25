import type { NormalizedBankTransaction, NormalizedObligation, TrustDispute } from "@mangekyo/contracts";
import { describe, expect, it } from "vitest";
import { DELGADO_FEE_AGREEMENT, DELGADO_MATTER, DELGADO_STATEMENT, FIRM_OWNER, lawFirmBundle } from "../fixtures/lawFirm";
import { classifyFailures, contingencyFeeCents, evaluatePayment, holdReason, type GatewayContext, type PaymentRequest } from "../src/gateway";
import { threeWayCheck, type AccountLedgerState } from "../src/ledger";
import { entry, NOW, stateFrom } from "./money";

const DEPOSIT = "demo:bank:txn:harborline-delgado";
const DELGADO = "demo:owner:maria-delgado";
const CHEN = "demo:owner:chen-park";

/** The law firm after Harborline's $85,000 check cleared and was allocated to Maria Delgado. */
function settled(extra: { disputes?: TrustDispute[]; obligations?: NormalizedObligation[]; firmCents?: number; statementLines?: "ok" | "short" } = {}) {
  const bundle = lawFirmBundle();
  if (extra.statementLines === "short") bundle.documents = bundle.documents.map(d => d.sourceId === DELGADO_STATEMENT ? { ...d, lines: d.lines!.map(l => l.kind === "costs" ? { ...l, amountCents: 50_000 } : l) } : d);
  const deposit: NormalizedBankTransaction = { sourceId: DEPOSIT, accountId: bundle.account.accountId, subAccount: "IOLTA", direction: "inflow", amountCents: 8_500_000, currency: "USD", bookedAt: NOW - 5000, clearing: "cleared", reference: "Claim HL-44812", counterparty: "Harborline Insurance", ownerHintSourceId: null, documentSourceIds: ["demo:document:delgado-settlement:v1", DELGADO_STATEMENT], duplicateOfSourceId: null, raw: { system: "demo", recordType: "bank-transaction", rawId: "harborline-delgado", datasetVersion: "law-firm-demo-v1" } };
  bundle.bankTransactions = [deposit];
  const state: AccountLedgerState = stateFrom(bundle);
  state.entries.push(
    entry({ entryId: "alloc:1", ownerId: null, amountCents: -8_500_000, kind: "allocation", fundsSourceId: DEPOSIT, sourceRefs: [DEPOSIT] }),
    entry({ entryId: "alloc:2", ownerId: DELGADO, amountCents: 8_500_000, kind: "allocation", fundsSourceId: DEPOSIT, sourceRefs: [DEPOSIT] }),
  );
  if (extra.firmCents) {
    // The firm's money arrived before cutover: it is in the opening statement and in the firm's opening balance.
    state.entries.push(entry({ entryId: "firm:in", ownerId: FIRM_OWNER.ownerId, amountCents: extra.firmCents, kind: "adjustment", clearedCents: extra.firmCents, sourceRefs: [FIRM_OWNER.sourceId], effectiveAt: bundle.account.openingAsOf }));
    state.statementBalances = state.statementBalances.map(s => ({ ...s, amountCents: s.amountCents + extra.firmCents! }));
  }
  state.disputes = extra.disputes ?? [];
  const known = new Set([...bundle.bankTransactions.map(t => t.sourceId), ...bundle.owners.map(o => o.sourceId), ...bundle.documents.map(d => d.sourceId), ...(extra.obligations ?? []).map(o => o.sourceId)]);
  const ctx: GatewayContext = { state, threeWay: threeWayCheck(state, NOW), knownSourceIds: known, proposals: [], cutoff: NOW, documents: bundle.documents, obligations: extra.obligations ?? [] };
  return ctx;
}
const request = { stage: "request" as const, actor: "dev-unverified:riley" };
const pay = (fields: Partial<PaymentRequest> & Pick<PaymentRequest, "ownerId" | "amountCents">): PaymentRequest => ({ proposalId: "pay-1", currency: "USD", evidenceSourceIds: [DELGADO_STATEMENT], requestedBy: "dev-unverified:riley", fundingSourceId: DEPOSIT, ...fields });
const rules = (result: ReturnType<typeof evaluatePayment>) => result.failures.map(f => f.rule);

describe("L9 FEE_NOT_EARNED", () => {
  it("passes a contingency fee that matches the signed settlement statement and the signed 33% fee agreement, in integer cents", () => {
    expect(contingencyFeeCents(8_500_000, 3300)).toBe(2_805_000);
    const result = evaluatePayment(settled(), pay({ ownerId: DELGADO, amountCents: 2_805_000, payoutKind: "attorney_fee", matterId: DELGADO_MATTER, settlementSourceId: DELGADO_STATEMENT, payeeOwnerId: FIRM_OWNER.ownerId, evidenceSourceIds: [DELGADO_STATEMENT, DELGADO_FEE_AGREEMENT] }), request);
    expect(result.allowed).toBe(true);
    expect(result.evaluated).toEqual(["L6", "L3", "L2", "L1", "L5", "L8", "L9", "L10", "L11"]);
    expect(result.facts.payoutKind).toBe("attorney_fee");
  });

  it("blocks a fee with no approved invoice and no settlement fee line, and says so", () => {
    const result = evaluatePayment(settled(), pay({ ownerId: CHEN, amountCents: 300_000, payoutKind: "attorney_fee", fundingSourceId: undefined, evidenceSourceIds: ["demo:owner-record:chen-park"] }), request);
    expect(rules(result)).toEqual(["L9"]);
    expect(result.failures[0]).toMatchObject({ code: "FEE_NOT_EARNED", sourceIds: expect.arrayContaining(["demo:owner-record:chen-park"]) });
    expect(result.failures[0].message).toContain("no approved invoice for Chen & Park Holdings");
    expect(classifyFailures(result.failures)).toBe("permanent");
  });

  it("passes a fee covered by an approved invoice for that client, but not an open one or a bigger fee", () => {
    const invoice: NormalizedObligation = { sourceId: "demo:obligation:INV-CP-7", accountId: "demo:account:pool-001", kind: "invoice", ownerSourceId: "demo:owner-record:chen-park", amountCents: 300_000, currency: "USD", reference: "INV-CP-7", status: "approved", excerpt: "Invoice INV-CP-7 for Chen & Park Holdings: $3,000.00, approved.", raw: { system: "demo", recordType: "invoice", rawId: "INV-CP-7", datasetVersion: "law-firm-demo-v1" } };
    const fee = pay({ ownerId: CHEN, amountCents: 300_000, payoutKind: "attorney_fee", fundingSourceId: undefined, evidenceSourceIds: [invoice.sourceId] });
    expect(evaluatePayment(settled({ obligations: [invoice] }), fee, request).allowed).toBe(true);
    expect(rules(evaluatePayment(settled({ obligations: [{ ...invoice, status: "open" }] }), fee, request))).toEqual(["L9"]);
    expect(evaluatePayment(settled({ obligations: [invoice] }), { ...fee, amountCents: 400_000 }, request).failures[0].message).toContain("total $3,000.00, less than the $4,000.00 requested");
  });

  it("never lets a fee exceed the client's balance, and refuses a fee line that doesn't match the agreement", () => {
    const over = evaluatePayment(settled(), pay({ ownerId: CHEN, amountCents: 13_000_000, payoutKind: "attorney_fee", fundingSourceId: undefined, evidenceSourceIds: ["demo:owner-record:chen-park"] }), request);
    expect(over.failures.filter(f => f.rule === "L9").map(f => f.message)).toEqual([expect.stringContaining("no approved invoice"), expect.stringContaining("never exceed the client's balance")]);
    const wrongFee = evaluatePayment(settled(), pay({ ownerId: DELGADO, amountCents: 2_800_000, payoutKind: "attorney_fee", matterId: DELGADO_MATTER }), request);
    expect(rules(wrongFee)).toEqual(["L9", "L11"]);
  });
});

describe("L11 SETTLEMENT_MISMATCH", () => {
  it("passes each line of the signed statement exactly and blocks anything else", () => {
    expect(evaluatePayment(settled(), pay({ ownerId: DELGADO, amountCents: 5_600_000, payoutKind: "client_share", matterId: DELGADO_MATTER }), request).allowed).toBe(true);
    expect(evaluatePayment(settled(), pay({ ownerId: DELGADO, amountCents: 95_000, payoutKind: "costs", matterId: DELGADO_MATTER, payeeOwnerId: FIRM_OWNER.ownerId }), request).allowed).toBe(true);
    const off = evaluatePayment(settled(), pay({ ownerId: DELGADO, amountCents: 5_000_000, payoutKind: "client_share", matterId: DELGADO_MATTER }), request);
    expect(rules(off)).toEqual(["L11"]);
    expect(off.failures[0].message).toContain("does not match any line of the signed settlement statement");
  });

  it("blocks every settlement payout when the statement's lines don't add up to the deposit", () => {
    const result = evaluatePayment(settled({ statementLines: "short" }), pay({ ownerId: DELGADO, amountCents: 5_600_000, payoutKind: "client_share", matterId: DELGADO_MATTER }), request);
    expect(result.failures.map(f => f.message)).toEqual([expect.stringContaining("lines total $84,550.00 but the settlement deposit is $85,000.00")]);
  });

  it("leaves payouts that aren't settlement lines (payoutKind other) to the ordinary rules", () => {
    expect(evaluatePayment(settled(), pay({ ownerId: CHEN, amountCents: 100_000, fundingSourceId: undefined, evidenceSourceIds: ["demo:owner-record:chen-park"] }), request).allowed).toBe(true);
  });
});

describe("L10 DISPUTED_FUNDS", () => {
  const dispute: TrustDispute = { disputeId: "demo:account:pool-001:dispute:001", accountId: "demo:account:pool-001", ownerId: DELGADO, amountCents: 3_000_000, reason: "Lienholder claims part of the recovery", status: "open", recordedBy: "dev-unverified:riley", recordedAt: NOW - 1000, sourceIds: [] };

  it("holds (not blocks) a payout that would dip into the disputed amount, until a person records the resolution", () => {
    const held = evaluatePayment(settled({ disputes: [dispute] }), pay({ ownerId: DELGADO, amountCents: 5_600_000, payoutKind: "client_share", matterId: DELGADO_MATTER }), request);
    expect(rules(held)).toEqual(["L10"]);
    expect(held.failures[0]).toMatchObject({ code: "DISPUTED_FUNDS", sourceIds: [dispute.disputeId] });
    expect(held.failures[0].message).toContain("$30,000.00 of Maria Delgado's balance is disputed");
    expect(held.facts.disputedCents).toBe(3_000_000);
    expect(classifyFailures(held.failures)).toBe("temporary");
    expect(holdReason(held.failures, settled().state, settled().threeWay)).toContain("until a person records how the dispute was resolved");
    expect(evaluatePayment(settled({ disputes: [dispute] }), pay({ ownerId: DELGADO, amountCents: 95_000, payoutKind: "costs", matterId: DELGADO_MATTER, payeeOwnerId: FIRM_OWNER.ownerId }), request).allowed).toBe(true);
  });

  it("releases the money once the dispute is resolved", () => {
    const resolved = { ...dispute, status: "resolved" as const, resolvedBy: "dev-unverified:sam", resolvedAt: NOW - 10, resolution: "Lien paid from the fee." };
    expect(evaluatePayment(settled({ disputes: [resolved] }), pay({ ownerId: DELGADO, amountCents: 5_600_000, payoutKind: "client_share", matterId: DELGADO_MATTER }), request).allowed).toBe(true);
  });
});

describe("L8 COMMINGLING", () => {
  it("flags the firm's own money in trust as a warning and never lets it fund a client payment", () => {
    const ctx = settled({ firmCents: 100_000 });
    expect(ctx.threeWay.status).toBe("matched");
    expect(ctx.threeWay.causes).toContainEqual(expect.objectContaining({ code: "COMMINGLING", severity: "warning", ownerIds: [FIRM_OWNER.ownerId], amountCents: 100_000 }));
    const result = evaluatePayment(ctx, pay({ ownerId: FIRM_OWNER.ownerId, amountCents: 50_000, payoutKind: "client_share", fundingSourceId: undefined, evidenceSourceIds: [FIRM_OWNER.sourceId] }), request);
    expect(rules(result)).toEqual(["L8"]);
    expect(result.failures[0]).toMatchObject({ code: "COMMINGLING", sourceIds: [FIRM_OWNER.sourceId] });
  });

  it("blocks a client payment funded by a deposit that was allocated to the firm", () => {
    const ctx = settled();
    ctx.state.entries = ctx.state.entries.map(e => e.entryId === "alloc:2" ? { ...e, ownerId: FIRM_OWNER.ownerId } : e);
    const result = evaluatePayment(ctx, pay({ ownerId: DELGADO, amountCents: 100, payoutKind: "other", evidenceSourceIds: ["demo:document:delgado-settlement:v1"] }), request);
    expect(rules(result)).toContain("L8");
    expect(result.failures.find(f => f.rule === "L8")?.message).toContain("firm money cannot fund Maria Delgado's payment");
  });
});
