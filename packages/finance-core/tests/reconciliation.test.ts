import type { NormalizedAccountBundle } from "@mangekyo/contracts";
import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNT_ID } from "../fixtures/demoMoney";
import { lawFirmBundle } from "../fixtures/lawFirm";
import { threeWayCheck, type AccountLedgerState } from "../src/ledger";
import { buildReconciliationInput, causeKey, checkReconciliationFindings, correctionEntries, evaluateCorrection, mockReconciliation, reconcilableCauses, validateReconciliationOutput } from "../src/reconciliation";
import { scorecardBundle } from "../src/scorecard";
import { entry, NOW, stateFrom } from "./money";

const DEPOSIT = "demo:bank:txn:plant-okafor";
const OKAFOR = "demo:owner:daniel-okafor";

/** Okafor's $2,500 check is allocated and posted to him, then the bank returns it. */
function bounced(): { state: AccountLedgerState; documents: NormalizedAccountBundle["documents"] } {
  const base = lawFirmBundle();
  const plant = scorecardBundle(DEMO_ACCOUNT_ID, NOW - 5000);
  const bundle: NormalizedAccountBundle = { ...base, owners: [...base.owners, ...plant.owners], documents: [...base.documents.filter(d => !plant.documents.some(p => p.sourceId === d.sourceId)), ...plant.documents], bankTransactions: plant.bankTransactions.filter(t => t.sourceId === DEPOSIT) };
  const state = stateFrom(bundle);
  state.entries.push(
    entry({ entryId: "alloc:okafor:unallocated", ownerId: null, amountCents: -250_000, kind: "allocation", fundsSourceId: DEPOSIT, sourceRefs: [DEPOSIT] }),
    entry({ entryId: "alloc:okafor:owner", ownerId: OKAFOR, amountCents: 250_000, kind: "allocation", fundsSourceId: DEPOSIT, sourceRefs: [DEPOSIT] }),
  );
  const original = state.bankTransactions[0];
  state.bankTransactions.push({ ...original, sourceId: `${DEPOSIT}:returned`, direction: "outflow", bookedAt: NOW - 1000, reference: `RETURN ${original.reference}`, ownerHintSourceId: "demo:owner-record:daniel-okafor", raw: { ...original.raw, recordType: "client-check-return", rawId: `${DEPOSIT}:returned` } });
  return { state, documents: bundle.documents };
}
const recheck = (state: AccountLedgerState) => threeWayCheck(state, NOW, { outstandingMaxDays: 30, now: NOW });

describe("mismatch agent (reconciliation mode)", () => {
  it("starts from the code-found cause and only the records it involves", () => {
    const { state, documents } = bounced();
    const threeWay = recheck(state);
    expect(threeWay.status).toBe("mismatched");
    const [cause] = reconcilableCauses(threeWay);
    expect(causeKey(cause)).toBe(`BANK_TXN_WITHOUT_LEDGER_ENTRY:${DEPOSIT}:returned`);
    const input = buildReconciliationInput({ runId: "r1", state, threeWay, cause, documents });
    expect(input.records.bankTransactions.map(t => t.sourceId).sort()).toEqual([DEPOSIT, `${DEPOSIT}:returned`]);
    expect(input.records.ledgerEntries.map(e => e.entryId)).toEqual(expect.arrayContaining(["alloc:okafor:owner", `import:${DEPOSIT}`]));
    expect(input.records.owners.map(o => o.name)).toEqual(["Daniel Okafor"]);
    expect(input.records.documents.map(d => d.sourceId)).toEqual(["demo:document:okafor-engagement:v1"]);
  });

  it("explains a bounced check and proposes recording the return against the right client", () => {
    const { state, documents } = bounced();
    const threeWay = recheck(state);
    const input = buildReconciliationInput({ runId: "r1", state, threeWay, cause: reconcilableCauses(threeWay)[0], documents });
    const output = validateReconciliationOutput(JSON.parse(JSON.stringify(mockReconciliation(input))), input);
    expect(output.explanation).toContain("bank returned D OKAFOR's $2,500.00 check");
    expect(output.proposedEntry).toMatchObject({ kind: "record_bank_item", bankSourceId: `${DEPOSIT}:returned`, ownerId: OKAFOR, amountCents: -250_000 });
    expect(checkReconciliationFindings(output, input).every(f => f.supported)).toBe(true);
  });

  it("validation is strict: citations must be records from the input, and nothing is repaired", () => {
    const { state, documents } = bounced();
    const threeWay = recheck(state);
    const input = buildReconciliationInput({ runId: "r1", state, threeWay, cause: reconcilableCauses(threeWay)[0], documents });
    const good = mockReconciliation(input);
    expect(() => validateReconciliationOutput({ ...good, extra: 1 }, input)).toThrow("Unsupported field");
    expect(() => validateReconciliationOutput({ ...good, proposedEntry: { ...good.proposedEntry!, evidenceSourceIds: ["demo:invented"] } }, input)).toThrow("Citation does not exist");
    expect(() => validateReconciliationOutput({ ...good, proposedEntry: { ...good.proposedEntry!, amountCents: -2500.5 } }, input)).toThrow("integer cents");
    expect(() => validateReconciliationOutput({ ...good, outcome: "needs_information" }, input)).toThrow("must not propose");
  });
});

describe("correction lock", () => {
  const known = (state: AccountLedgerState) => new Set([...state.bankTransactions.map(t => t.sourceId), ...state.entries.map(e => e.entryId)]);
  function setup() {
    const { state, documents } = bounced();
    const threeWay = recheck(state);
    const cause = reconcilableCauses(threeWay)[0];
    const entryToPost = mockReconciliation(buildReconciliationInput({ runId: "r1", state, threeWay, cause, documents })).proposedEntry!;
    return { state, entry: entryToPost, causeKey: causeKey(cause) };
  }

  it("passes when the entry is exact, evidenced and clears the code-found cause", () => {
    const s = setup();
    const lock = evaluateCorrection({ ...s, known: known(s.state), status: "proposed", recheck, requestedBy: "agent:reconciler", approver: "dev-unverified:sam", recordedBy: "dev-unverified:riley", now: NOW });
    expect(lock).toMatchObject({ allowed: true, resolves: true, failures: [] });
    const posted = correctionEntries(s.entry, s.state, "c1", "dev-unverified:sam", NOW, "c1:approval");
    expect(posted).toEqual([expect.objectContaining({ entryId: "correction:c1", kind: "disbursement", ownerId: OKAFOR, amountCents: -250_000 })]);
    expect(recheck({ ...s.state, entries: [...s.state.entries, ...posted] }).status).toBe("matched");
  });

  it("refuses the person who recorded the return (L4), a wrong amount (L6), an unknown source (L3) and a second recording (L7)", () => {
    const s = setup();
    const base = { ...s, known: known(s.state), status: "proposed", recheck, requestedBy: "agent:reconciler", now: NOW };
    expect(evaluateCorrection({ ...base, approver: "dev-unverified:riley", recordedBy: "dev-unverified:riley" }).failures.map(f => f.rule)).toEqual(["L4"]);
    expect(evaluateCorrection({ ...base, entry: { ...s.entry, amountCents: -200_000 } }).failures.map(f => f.rule)).toContain("L6");
    expect(evaluateCorrection({ ...base, entry: { ...s.entry, evidenceSourceIds: ["demo:nowhere"] } }).failures.map(f => f.rule)).toContain("L3");
    const recorded = { ...s.state, entries: [...s.state.entries, ...correctionEntries(s.entry, s.state, "c1", "x", NOW, "a")] };
    expect(evaluateCorrection({ ...base, state: recorded, known: known(recorded) }).failures.map(f => f.code)).toContain("STATE");
    expect(evaluateCorrection({ ...base, status: "posted" }).failures[0]).toMatchObject({ rule: "L7" });
  });

  it("refuses re-recording a deposit that is already in the books", () => {
    const s = setup();
    // Recording the same deposit twice would "fix" nothing and double-count it.
    const inflow = { kind: "record_bank_item" as const, bankSourceId: DEPOSIT, reversesEntryId: null, ownerId: null, amountCents: 250_000, memo: "re-record", evidenceSourceIds: [DEPOSIT] };
    const lock = evaluateCorrection({ ...s, entry: inflow, known: known(s.state), status: "proposed", recheck, requestedBy: "agent:reconciler", now: NOW });
    expect(lock.allowed).toBe(false);
    expect(lock.failures.map(f => f.code)).toContain("STATE");
  });

  it("refuses an entry that doesn't remove the mismatch (R1)", () => {
    const s = setup();
    const wrong = { kind: "reverse_entry" as const, bankSourceId: null, reversesEntryId: "alloc:okafor:owner", ownerId: OKAFOR, amountCents: -250_000, memo: "wrong fix", evidenceSourceIds: ["alloc:okafor:owner"] };
    const lock = evaluateCorrection({ ...s, entry: wrong, known: known(s.state), status: "proposed", recheck, requestedBy: "agent:reconciler", now: NOW });
    expect(lock).toMatchObject({ allowed: false, resolves: false });
    expect(lock.failures.map(f => f.rule)).toEqual(["R1"]);
  });
});
