import type { NormalizedAccountBundle, NormalizedBankTransaction, NormalizedDocument, NormalizedObligation, NormalizedOwner, RawPointer } from "@mangekyo/contracts";
import { DEMO_ACCOUNT_ID, forDemoAccount } from "../../fixtures/demoMoney";
import { lawFirmBundle } from "../../fixtures/lawFirm";
import type { OrchestratorState } from "../orchestrator";

/**
 * Measuring the agents. A planted run seeds six known mistakes into a fresh DEMO law-firm account, each with
 * its right answer; a batch run seeds synthetic deposits whose right answers are known from how they were made.
 * Every record is fictional and lives on a DEMO account.
 */

const PLANT_RAW = "scorecard-plant";
const LAW = "law-firm-demo-v1";
const raw = (recordType: string, rawId: string, datasetVersion = LAW): RawPointer => ({ system: "demo", recordType, rawId, datasetVersion });

export const UNCLEARED_PAYOUT_PURPOSE = "Scorecard: Delgado client share before the check clears";
export const OVERDRAW_PURPOSE = "Scorecard: Raymond Cho expert witness, more than he has";

export type PlantKey = "wrong-client" | "duplicate" | "uncleared-payout" | "overdraw" | "unsupported-claim" | "bounced-check";
export interface Plant {
  key: PlantKey;
  label: string;
  mistake: string;
  rightAnswer: string;
  /** Who should catch it. */
  catcher: "checker" | "investigator" | "lock" | "mismatch agent";
  subject: { kind: "deposit"; bank: string; expect: "rejected" | "needs_person" } | { kind: "payment"; purpose: string; rule: "L1" | "L2" } | { kind: "reconciliation"; bank: string; owner: string; amountCents: number };
}

/** Bank sourceId suffixes; lawId-style: `demo:${suffix}` mapped into the account. */
export const PLANTS: Plant[] = [
  { key: "wrong-client", label: "Wrong client", catcher: "checker",
    mistake: "Harborline's $18,000.00 check for claim HL-50210 carries a bank hint for Chen & Park Holdings; the planted investigator believes the hint over the settlement letter.",
    rightAnswer: "Westbrook HOA (the letter). The checker stops the Chen & Park claim, and nothing reaches approval.",
    subject: { kind: "deposit", bank: "bank:txn:plant-wrong-client", expect: "rejected" } },
  { key: "duplicate", label: "Duplicate", catcher: "investigator",
    mistake: "Bayview Title wires $40,000.00 twice with escrow instruction ESC-2291.",
    rightAnswer: "Allocate the first wire only. The second is not allocated; a person is asked whether it is a duplicate.",
    subject: { kind: "deposit", bank: "bank:txn:plant-bayview-second", expect: "needs_person" } },
  { key: "uncleared-payout", label: "Uncleared payout", catcher: "lock",
    mistake: "Riley asks to pay Maria Delgado's $56,000.00 share from Harborline's $85,000.00 check before it clears.",
    rightAnswer: "Blocked by L2: the funds haven't cleared.",
    subject: { kind: "payment", purpose: UNCLEARED_PAYOUT_PURPOSE, rule: "L2" } },
  { key: "overdraw", label: "Overdraw", catcher: "lock",
    mistake: "Riley asks to pay $6,000.00 for Raymond Cho, who has $1,800.00.",
    rightAnswer: "Blocked by L1: the pool has the cash, but it belongs to other clients.",
    subject: { kind: "payment", purpose: OVERDRAW_PURPOSE, rule: "L1" } },
  { key: "unsupported-claim", label: "Unsupported claim", catcher: "checker",
    mistake: "The planted investigator says J NGUYEN's Zelle memo quotes invoice INV-7781 for James Nguyen. The memo says only \"case fees\".",
    rightAnswer: "The checker stops it and shows what the memo actually says.",
    subject: { kind: "deposit", bank: "bank:txn:plant-nguyen", expect: "rejected" } },
  { key: "bounced-check", label: "Bounced check", catcher: "mismatch agent",
    mistake: "Daniel Okafor's $2,500.00 check is allocated and posted, then the bank returns it.",
    rightAnswer: "The three-way check fails; the mismatch agent explains it and proposes recording the $2,500.00 return against Daniel Okafor, for a person to approve through the lock.",
    subject: { kind: "reconciliation", bank: "bank:txn:plant-okafor:returned", owner: "owner:daniel-okafor", amountCents: -250_000 } },
];

/** New source records for the planted run, added to a fresh law-firm account. */
export function scorecardBundle(accountId: string, now: number): NormalizedAccountBundle {
  const opening = lawFirmBundle();
  const okafor: NormalizedOwner = { sourceId: "demo:owner-record:daniel-okafor", ownerId: "demo:owner:daniel-okafor", accountId: DEMO_ACCOUNT_ID, subAccount: "IOLTA", name: "Daniel Okafor", raw: raw("owner", "daniel-okafor") };
  const txn = (id: string, amountCents: number, counterparty: string, reference: string, documents: string[], extra: Partial<NormalizedBankTransaction> = {}): NormalizedBankTransaction => ({
    sourceId: `demo:bank:txn:${id}`, accountId: DEMO_ACCOUNT_ID, subAccount: "IOLTA", direction: "inflow", amountCents, currency: "USD", bookedAt: now, clearing: "cleared",
    reference, counterparty, ownerHintSourceId: null, documentSourceIds: documents.map(d => `demo:document:${d}:v1`), duplicateOfSourceId: null, raw: raw("bank-transaction", id), ...extra,
  });
  const memo: NormalizedDocument = { sourceId: "demo:document:plant-nguyen-memo:v1", accountId: DEMO_ACCOUNT_ID, documentType: "Bank memo", title: "Zelle memo", text: "Payer: J NGUYEN. Memo: case fees. Amount: $1,200.00.", excerpt: "J NGUYEN: case fees", version: "v1", namedOwnerSourceIds: [], raw: raw("document", "plant-nguyen-memo") };
  const bundle: NormalizedAccountBundle = {
    ...opening, owners: [okafor], obligations: [], statementBalances: [], openingBalances: [], reconcilingItems: [],
    documents: [...opening.documents.filter(d => d.sourceId === "demo:document:okafor-engagement:v1").map(d => ({ ...d, namedOwnerSourceIds: [okafor.sourceId] })), memo],
    bankTransactions: [
      txn("plant-harborline-delgado", 8_500_000, "Harborline Insurance", "Claim HL-44812", ["delgado-settlement"], { clearing: "pending" }),
      txn("plant-bayview-first", 4_000_000, "Bayview Title", "ESC-2291", ["bayview-escrow"]),
      txn("plant-bayview-second", 4_000_000, "Bayview Title", "ESC-2291", ["bayview-escrow"], { duplicateOfSourceId: "demo:bank:txn:plant-bayview-first" }),
      txn("plant-wrong-client", 1_800_000, "Harborline Insurance", "Claim HL-50210", ["westbrook-settlement"], { ownerHintSourceId: "demo:owner-record:chen-park", raw: raw(PLANT_RAW, "wrong-client") }),
      txn("plant-nguyen", 120_000, "J NGUYEN", "case fees", ["plant-nguyen-memo"], { raw: raw(PLANT_RAW, "unsupported-claim") }),
      txn("plant-okafor", 250_000, "D OKAFOR", "Estate retainer", ["okafor-engagement"]),
    ],
  };
  return { ...forDemoAccount(bundle, accountId), account: lawFirmBundle(accountId).account };
}

/** What the system did with one planted mistake, read back from saved state. */
export interface PlantObservation {
  state: OrchestratorState | null;
  /** An allocation for this deposit reached approval (pending, approved or posted). */
  allocationReachedApproval?: boolean;
  payment?: { status: string; rules: string[] } | null;
  correction?: { ownerId: string | null; amountCents: number; status: string } | null;
}
export interface PlantScore { key: PlantKey; status: "caught" | "wrong" | "pending"; askedPerson: boolean; detail: string }

export function scorePlant(plant: Plant, seen: PlantObservation, ownerId: (suffix: string) => string): PlantScore {
  const base = { key: plant.key, askedPerson: false };
  const s = plant.subject;
  if (s.kind === "payment") {
    if (!seen.payment) return { ...base, status: "pending", detail: "The payment request hasn't been made yet." };
    if (seen.payment.status === "blocked" && seen.payment.rules.includes(s.rule)) return { ...base, status: "caught", detail: `Blocked by ${seen.payment.rules.join(", ")}.` };
    return { ...base, status: "wrong", detail: `Expected a ${s.rule} block; the request is ${seen.payment.status}.` };
  }
  if (s.kind === "deposit") {
    if (seen.allocationReachedApproval) return { ...base, status: "wrong", detail: "An allocation for this deposit reached approval." };
    if (seen.state === null || seen.state === "received" || seen.state === "investigating" || seen.state === "validating" || seen.state === "checking") return { ...base, status: "pending", detail: seen.state ? `Still ${seen.state}.` : "Not investigated yet." };
    if (seen.state === s.expect) return { ...base, status: "caught", askedPerson: seen.state === "needs_person", detail: seen.state === "rejected" ? "The checker stopped it; nothing reached approval." : "Not allocated; a person was asked." };
    return { ...base, status: "wrong", detail: `Expected ${s.expect}; ended ${seen.state}.` };
  }
  if (!seen.state || seen.state === "received" || seen.state === "investigating" || seen.state === "validating" || seen.state === "checking") return { ...base, status: "pending", detail: seen.state ? `Mismatch agent ${seen.state}.` : "No mismatch investigation yet." };
  const c = seen.correction;
  if (seen.state === "needs_person" && c && c.ownerId === ownerId(s.owner) && c.amountCents === s.amountCents) return { ...base, status: "caught", askedPerson: true, detail: `Proposed recording the return against the right client; ${c.status === "posted" ? "a person approved it" : "waiting for a person"}.` };
  return { ...base, status: "wrong", detail: c ? "The proposed correction doesn't match the right answer." : `Ended ${seen.state} without the right correction.` };
}

export function summarizePlants(scores: PlantScore[]) {
  const caught = scores.filter(s => s.status === "caught").length;
  const wrong = scores.filter(s => s.status === "wrong").length;
  const askedPerson = scores.filter(s => s.askedPerson).length;
  return { caught, wrong, askedPerson, pending: scores.length - caught - wrong, total: scores.length, line: `Caught ${caught} of ${scores.length} · wrong ${wrong} · asked a person ${askedPerson}` };
}

/* ---------- Batch: N synthetic deposits with known right answers ---------- */

export const BATCH_DATASET = "synthetic-batch-v1";
export type BatchKind = "clear" | "invoice" | "partial" | "duplicate" | "vague" | "pending" | "planted";
/** The state each kind should settle in. Only clear and invoice deposits are handled without a person. */
export const BATCH_EXPECT: Record<BatchKind, OrchestratorState> = { clear: "ready_for_approval", invoice: "ready_for_approval", partial: "needs_person", duplicate: "needs_person", vague: "needs_person", pending: "waiting_to_clear", planted: "rejected" };
const MIX: Array<[BatchKind, number]> = [["clear", 50], ["invoice", 15], ["partial", 10], ["duplicate", 8], ["vague", 10], ["pending", 5], ["planted", 2]];

/** Small deterministic PRNG so a batch is the same every time for the same seed. */
function prng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

export function batchKindOf(rawId: string): BatchKind | null {
  const kind = rawId.split(":")[0];
  return (Object.keys(BATCH_EXPECT) as BatchKind[]).includes(kind as BatchKind) ? kind as BatchKind : null;
}

/** A DEMO account with 20 fictional clients and `count` deposits booked in the minute before `now`. A duplicate adds its original, so it counts two. */
export function batchBundle(accountId: string, count: number, now: number, seed = 42): NormalizedAccountBundle {
  const r = (recordType: string, rawId: string) => raw(recordType, rawId, BATCH_DATASET);
  const rand = prng(seed);
  const owners: NormalizedOwner[] = Array.from({ length: 20 }, (_, i) => {
    const key = `batch-client-${String(i + 1).padStart(2, "0")}`;
    return { sourceId: `demo:owner-record:${key}`, ownerId: `demo:owner:${key}`, accountId: DEMO_ACCOUNT_ID, subAccount: "BATCH", name: `Batch Client ${String(i + 1).padStart(2, "0")}`, raw: r("owner", key) };
  });
  const documents: NormalizedDocument[] = [];
  const obligations: NormalizedObligation[] = [];
  const bank: NormalizedBankTransaction[] = [];
  const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  const doc = (key: string, title: string, text: string, named: NormalizedOwner[]) => { documents.push({ sourceId: `demo:document:${key}:v1`, accountId: DEMO_ACCOUNT_ID, documentType: "Remittance advice", title, text, excerpt: text, version: "v1", namedOwnerSourceIds: named.map(o => o.sourceId), raw: r("document", key) }); return `demo:document:${key}:v1`; };
  const deposit = (id: string, kind: BatchKind, amountCents: number, counterparty: string, reference: string, docs: string[], extra: Partial<NormalizedBankTransaction> = {}) =>
    bank.push({ sourceId: `demo:bank:txn:${id}`, accountId: DEMO_ACCOUNT_ID, subAccount: "BATCH", direction: "inflow", amountCents, currency: "USD", bookedAt: now - 60_000 + bank.length, clearing: "cleared", reference, counterparty, ownerHintSourceId: null, documentSourceIds: docs, duplicateOfSourceId: null, raw: r(kind === "planted" ? PLANT_RAW : "bank-transaction", `${kind}:${id}`), ...extra });
  const total = MIX.reduce((sum, [, w]) => sum + w, 0);
  for (let i = 0; bank.length < count; i++) {
    let pick = rand() * total;
    const kind = MIX.find(([, w]) => (pick -= w) < 0)?.[0] ?? "clear";
    if (kind === "duplicate" && bank.length > count - 2) continue;
    const owner = owners[Math.floor(rand() * owners.length)];
    const other = owners[(owners.indexOf(owner) + 1 + Math.floor(rand() * (owners.length - 1))) % owners.length];
    const amountCents = (50 + Math.floor(rand() * 4950)) * 100;
    const id = `batch-${String(i + 1).padStart(4, "0")}`;
    if (kind === "clear" || kind === "pending") deposit(id, kind, amountCents, `Payer ${id}`, `REMIT ${id}`, [doc(`${id}-remit`, `Remittance for ${owner.name}`, `Beneficiary: ${owner.name}. Amount: ${dollars(amountCents)}.`, [owner])], kind === "pending" ? { clearing: "pending" } : {});
    if (kind === "invoice" || kind === "partial") {
      const ref = `BATCH-INV-${String(i + 1).padStart(4, "0")}`;
      const invoiceCents = kind === "invoice" ? amountCents : amountCents + 10_000;
      obligations.push({ sourceId: `demo:obligation:${ref}`, accountId: DEMO_ACCOUNT_ID, kind: "invoice", ownerSourceId: owner.sourceId, reference: ref, amountCents: invoiceCents, currency: "USD", status: "open", excerpt: `Invoice ${ref} for ${owner.name}: ${dollars(invoiceCents)}, open.`, raw: r("invoice", ref) });
      deposit(id, kind, amountCents, `Payer ${id}`, `PAYMENT ${ref}`, []);
    }
    if (kind === "duplicate") {
      const docId = doc(`${id}-remit`, `Remittance for ${owner.name}`, `Beneficiary: ${owner.name}. Amount: ${dollars(amountCents)}.`, [owner]);
      deposit(`${id}-a`, "clear", amountCents, `Payer ${id}`, `WIRE ${id}`, [docId]);
      deposit(`${id}-b`, "duplicate", amountCents, `Payer ${id}`, `WIRE ${id}`, [docId], { duplicateOfSourceId: `demo:bank:txn:${id}-a` });
    }
    if (kind === "vague") deposit(id, kind, amountCents, `TRANSFER ${id}`, `TRANSFER ${id}`, [doc(`${id}-memo`, "Bank memo", `Memo: see email. Amount: ${dollars(amountCents)}.`, [])]);
    if (kind === "planted") deposit(id, kind, amountCents, `Payer ${id}`, `REMIT ${id}`, [doc(`${id}-remit`, `Remittance for ${owner.name}`, `Beneficiary: ${owner.name}. Amount: ${dollars(amountCents)}.`, [owner])], { ownerHintSourceId: other.sourceId });
  }
  const openingCents = 1_000_000;
  const bundle: NormalizedAccountBundle = {
    account: { accountId: DEMO_ACCOUNT_ID, sourceId: DEMO_ACCOUNT_ID, name: "Batch measurement trust account (synthetic)", currency: "USD", openingAsOf: now - 86_400_000, synthetic: true, raw: r("account", "batch") },
    owners, documents, obligations, bankTransactions: bank, reconcilingItems: [], issues: [],
    statementBalances: [{ sourceId: "demo:bank-statement:batch", accountId: DEMO_ACCOUNT_ID, amountCents: openingCents * owners.length, asOf: now - 86_400_000, raw: r("bank-statement", "opening") }],
    openingBalances: owners.map(o => ({ sourceId: `demo:opening:${o.ownerId.split(":").at(-1)}`, accountId: DEMO_ACCOUNT_ID, ownerId: o.ownerId, amountCents: openingCents, clearedCents: openingCents, asOf: now - 86_400_000, bankSourceId: null, raw: r("opening", o.ownerId) })),
  };
  return forDemoAccount(bundle, accountId);
}

/** attempts > 1 means something came back to it (a person's answer, a correction, or the deposit clearing). */
export interface BatchRow { kind: BatchKind; state: OrchestratorState | null; attempts: number; settledAt: number | null }
export interface BatchSummary { count: number; settled: number; durationMs: number | null; handledWithoutPerson: number; flagged: number; waiting: number; matchedRightAnswer: number; pctHandled: number; pctFlagged: number; line: string }

const SETTLED: ReadonlySet<OrchestratorState> = new Set(["needs_person", "ready_for_approval", "rejected", "waiting_to_clear", "failed"]);

/** Handled without a person: ready for sign-off on its first attempt, nobody asked. Flagged: needs_person, rejected or failed. */
export function summarizeBatch(rows: BatchRow[], startedAt: number): BatchSummary {
  const settled = rows.filter(r => r.state && SETTLED.has(r.state));
  const handled = settled.filter(r => r.state === "ready_for_approval" && r.attempts === 1).length;
  const flagged = settled.filter(r => r.state === "needs_person" || r.state === "rejected" || r.state === "failed").length;
  const waiting = settled.filter(r => r.state === "waiting_to_clear").length;
  const matched = settled.filter(r => r.state === BATCH_EXPECT[r.kind]).length;
  const done = settled.length === rows.length && rows.length > 0;
  const durationMs = done ? Math.max(...settled.map(r => r.settledAt ?? startedAt)) - startedAt : null;
  const pct = (n: number) => rows.length ? Math.round((n / rows.length) * 1000) / 10 : 0;
  return { count: rows.length, settled: settled.length, durationMs, handledWithoutPerson: handled, flagged, waiting, matchedRightAnswer: matched, pctHandled: pct(handled), pctFlagged: pct(flagged),
    line: done ? `${rows.length} deposits in ${(durationMs! / 1000).toFixed(1)} s · ${pct(handled)}% handled without a person · ${pct(flagged)}% flagged · ${matched} of ${rows.length} matched the right answer`
      : `${settled.length} of ${rows.length} deposits settled so far` };
}
