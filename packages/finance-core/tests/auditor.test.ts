import type { LedgerEntry, MoneyProposal, ProposalTransition } from "@mangekyo/contracts";
import { describe, expect, it } from "vitest";
import { buildAuditInput, codeAudit, combineAuditFindings, DRILL_PLANTS, mockAudit, scoreAudit, validateAuditOutput, auditReport } from "../src/auditor";
import { FIRM_OWNER, lawFirmBundle } from "../fixtures/lawFirm";
import { NOW } from "./money";

const A = "demo:account:pool-001";
const WESTBROOK = "demo:owner:westbrook"; const DELGADO = "demo:owner:maria-delgado"; const CHEN = "demo:owner:chen-park"; const JAMES = "demo:owner:james-nguyen";
const t0 = NOW - 3 * 86_400_000;

/** The four drill mistakes, built by hand the way runAuditorDrill plants them. */
function drillInput() {
  const bundle = lawFirmBundle();
  const base = { accountId: A, currency: "USD", status: "posted" as const };
  const deposit = "demo:bank:txn:drill-harborline";
  const entries: LedgerEntry[] = [
    ...bundle.openingBalances.map(o => ({ ...base, entryId: `import:${o.sourceId}`, ownerId: o.ownerId, amountCents: o.amountCents, kind: "adjustment" as const, sourceRefs: [o.sourceId], clearedCents: o.clearedCents, memo: "opening", effectiveAt: o.asOf, createdAt: o.asOf, createdBy: "import" })),
    { ...base, entryId: "drill:self-approved:entry:1", ownerId: WESTBROOK, amountCents: -150_000, kind: "disbursement", sourceRefs: ["demo:document:westbrook-settlement:v1"], proposalId: "p1", approvalId: "p1:transition:2", memo: "filing fees", effectiveAt: t0, createdAt: t0, createdBy: "riley" },
    { ...base, entryId: `import:${deposit}`, ownerId: null, amountCents: 8_500_000, kind: "deposit_received", sourceRefs: [deposit], fundsSourceId: deposit, memo: "deposit", effectiveAt: t0 + 1000, createdAt: t0 + 1000, createdBy: "import" },
    { ...base, entryId: "drill:alloc:entry:1", ownerId: null, amountCents: -8_500_000, kind: "allocation", sourceRefs: [deposit], fundsSourceId: deposit, proposalId: "p2a", approvalId: "p2a:transition:2", memo: "alloc", effectiveAt: t0 + 2000, createdAt: t0 + 2000, createdBy: "sam" },
    { ...base, entryId: "drill:alloc:entry:2", ownerId: DELGADO, amountCents: 8_500_000, kind: "allocation", sourceRefs: [deposit], fundsSourceId: deposit, proposalId: "p2a", approvalId: "p2a:transition:2", memo: "alloc", effectiveAt: t0 + 2000, createdAt: t0 + 2000, createdBy: "sam" },
    { ...base, entryId: "drill:uncleared:entry:1", ownerId: DELGADO, amountCents: -5_600_000, kind: "disbursement", sourceRefs: ["demo:document:delgado-settlement:v1"], proposalId: "p2", approvalId: "p2:transition:2", memo: "client share", effectiveAt: t0 + 3000, createdAt: t0 + 3000, createdBy: "sam" },
    { ...base, entryId: "drill:fee:entry:1", ownerId: CHEN, amountCents: -300_000, kind: "fee", sourceRefs: ["demo:owner-record:chen-park"], proposalId: "p3", approvalId: "p3:transition:2", memo: "Attorney fee", effectiveAt: t0 + 4000, createdAt: t0 + 4000, createdBy: "sam" },
    { ...base, entryId: "drill:reversal:entry:1", ownerId: JAMES, amountCents: 120_000, kind: "reversal", reversesEntryId: "drill:ghost", sourceRefs: ["demo:owner-record:james-nguyen"], approvalId: "x", memo: "Reversal", effectiveAt: t0 + 5000, createdAt: t0 + 5000, createdBy: "sam" },
  ];
  const proposal = (proposalId: string, requestedBy: string, approvedBy: string, extra: Partial<MoneyProposal>): MoneyProposal => ({ proposalId, accountId: A, kind: "payment", status: "posted", currency: "USD", requestedBy, origin: { type: "person" }, evidenceSourceIds: [], amountCents: 1, purpose: "", approvedBy, approvalId: `${proposalId}:transition:2`, createdAt: t0, updatedAt: t0, ...extra });
  const proposals = [proposal("p1", "riley", "riley", { ownerId: WESTBROOK, amountCents: 150_000 }), proposal("p2a", "riley", "sam", { kind: "allocation", bankSourceId: deposit, amountCents: 8_500_000 }), proposal("p2", "riley", "sam", { ownerId: DELGADO, amountCents: 5_600_000, payoutKind: "client_share", fundingSourceId: deposit }), proposal("p3", "riley", "sam", { ownerId: CHEN, amountCents: 300_000, payoutKind: "attorney_fee" })];
  const transitions: ProposalTransition[] = proposals.map(p => ({ transitionId: `${p.proposalId}:transition:2`, proposalId: p.proposalId, accountId: A, from: "pending_approval", to: "approved", actor: p.approvedBy!, reason: null, lock: null, at: t0 }));
  return buildAuditInput({
    runId: "a1", accountId: A, currency: "USD", period: { from: t0 - 1000, to: NOW }, owners: [...bundle.owners],
    entries, bankTransactions: [{ sourceId: deposit, accountId: A, subAccount: "IOLTA", direction: "inflow", amountCents: 8_500_000, currency: "USD", bookedAt: t0 + 1000, clearing: "pending", reference: "Claim HL-44812", counterparty: "Harborline Insurance", ownerHintSourceId: null, documentSourceIds: [], duplicateOfSourceId: null, raw: { system: "demo", recordType: "bank-transaction", rawId: "x", datasetVersion: "law-firm-demo-v1" } }],
    proposals, transitions, documents: bundle.documents, invoices: [], disputes: [], signedMonths: [],
  });
}

describe("Trust Compliance Auditor", () => {
  it("code catches all four planted mistakes and raises no false alarms (the unsigned month is a warning, not an alarm)", () => {
    const input = drillInput();
    const byRule = Object.fromEntries(input.codeFindings.map(f => [f.ruleId, f.entryIds]));
    expect(byRule.A8_SECOND_APPROVER_AND_EVIDENCE).toBeDefined();
    expect(input.codeFindings.filter(f => f.ruleId === "A8_SECOND_APPROVER_AND_EVIDENCE").flatMap(f => f.entryIds).sort()).toEqual(["drill:reversal:entry:1", "drill:self-approved:entry:1"]);
    expect(byRule.A2_GOOD_FUNDS).toEqual(["drill:uncleared:entry:1"]);
    expect(byRule.A4_FEE_NOT_EARNED).toEqual(["drill:fee:entry:1"]);
    expect(input.codeFindings.find(f => f.ruleId === "A2_GOOD_FUNDS")?.message).toContain("$56,000.00 was paid out for Maria Delgado");
    expect(input.codeFindings.filter(f => f.severity === "warning").map(f => f.ruleId)).toEqual(["A7_MONTHLY_RECONCILIATION"]);
    const report = auditReport({ reportId: "r1", input, findings: combineAuditFindings(input.codeFindings, mockAudit(input)), summary: mockAudit(input).summary, mode: "mock", model: "mock", generatedAt: NOW, generatedBy: "sam" });
    expect(report.status).toBe("findings");
    expect(scoreAudit(A, report)).toMatchObject({ caught: 4, missed: 0, falseAlarms: 0, line: "Caught 4 of 4 · missed 0 · false alarms 0" });
    expect(scoreAudit(A, null).line).toBe("No audit report yet");
  });

  it("A1, A3 and A5 catch a negative client balance, firm money in trust and a payout of disputed money", () => {
    const base = drillInput();
    const extra = [...base.entries,
      { accountId: A, currency: "USD", status: "posted" as const, entryId: "neg:1", ownerId: "demo:owner:raymond-cho", amountCents: -500_000, kind: "disbursement" as const, sourceRefs: ["x"], approvalId: "a", memo: "too much", effectiveAt: t0 + 6000, createdAt: t0 + 6000, createdBy: "sam" },
      { accountId: A, currency: "USD", status: "posted" as const, entryId: "firm:1", ownerId: FIRM_OWNER.ownerId, amountCents: 100_000, kind: "adjustment" as const, sourceRefs: ["x"], memo: "firm", effectiveAt: t0 + 6000, createdAt: t0 + 6000, createdBy: "sam" },
    ];
    const findings = codeAudit({ ...base, entries: extra, disputes: [{ disputeId: "d1", accountId: A, ownerId: DELGADO, amountCents: 3_000_000, reason: "lien", status: "open", recordedBy: "riley", recordedAt: t0 + 2500, sourceIds: [] }] });
    expect(findings.map(f => f.ruleId)).toEqual(expect.arrayContaining(["A1_NEGATIVE_CLIENT_BALANCE", "A3_COMMINGLING", "A5_DISPUTED_FUNDS_PAID"]));
    expect(findings.find(f => f.ruleId === "A1_NEGATIVE_CLIENT_BALANCE")?.message).toContain("Raymond Cho's balance went to -$3,200.00");
  });

  it("validation keeps the agent honest: known rules, cited entries from the input, at most 3 questions; code findings are never removed", () => {
    const input = drillInput();
    const good = mockAudit(input);
    expect(() => validateAuditOutput({ ...good, extra: true }, input)).toThrow("Unsupported field");
    expect(() => validateAuditOutput({ ...good, findings: [{ ...good.findings[0], entryIds: ["not-an-entry"] }] }, input)).toThrow("entryIds must be ledger entries");
    expect(() => validateAuditOutput({ ...good, findings: [{ ...good.findings[0], ruleId: "A9_MADE_UP" }] }, input)).toThrow("Unknown rule ID");
    expect(() => validateAuditOutput({ ...good, questions: [1, 2, 3, 4].map(n => ({ key: `q${n}`, question: "?", sourceRefs: [] })) }, input)).toThrow("at most 3 questions");
    const agentDropsEverything = validateAuditOutput({ ...good, findings: [] }, input);
    expect(combineAuditFindings(input.codeFindings, agentDropsEverything)).toHaveLength(input.codeFindings.length);
    const agentAdds = validateAuditOutput({ ...good, findings: [...good.findings, { findingId: "agent-1", ruleId: "A8_SECOND_APPROVER_AND_EVIDENCE", severity: "warning", message: "Looks odd.", entryIds: ["drill:alloc:entry:2"], sourceIds: [], ownerId: DELGADO, amountCents: null }] }, input);
    expect(combineAuditFindings(input.codeFindings, agentAdds).filter(f => f.foundBy === "agent")).toHaveLength(1);
  });

  it("the drill definition names four fixed entries", () => {
    expect(DRILL_PLANTS.map(p => p.key)).toEqual(["self-approved", "payout-before-cleared", "fee-no-invoice", "unlinked-reversal"]);
  });
});
