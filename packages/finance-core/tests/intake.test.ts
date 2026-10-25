import { describe, expect, it } from "vitest";
import { createSeed } from "../../../apps/demo-erp/data/seed";
import { dollarsToCents, formatCents, IntakeError, utcDate } from "../src/intake/cents";
import { ERP_ACCOUNT_ID, normalizeErpState, type ErpState } from "../src/intake/erp";
import { importLedgerEntries } from "../src/ledger";
import { demoMoneyBundle } from "../fixtures/demoMoney";

describe("cents conversion", () => {
  it("converts exact decimal dollars without float multiplication", () => {
    expect(dollarsToCents(3250, "x")).toBe(325_000);
    expect(dollarsToCents(-900, "x")).toBe(-90_000);
    expect(dollarsToCents(0.29, "x")).toBe(29);
    expect(dollarsToCents("1234.5", "x")).toBe(123_450);
    expect(dollarsToCents(1.1, "x")).toBe(110);
  });

  it("rejects anything that is not exactly representable", () => {
    for (const bad of [0.001, 1e21, NaN, Infinity, "12.345", "1,000", "", null, undefined, "1e3"]) {
      expect(() => dollarsToCents(bad, "raw-1")).toThrow(IntakeError);
    }
    expect(() => dollarsToCents(Number.MAX_SAFE_INTEGER, "raw-1")).toThrow("safe integer");
  });

  it("formats cents and parses calendar dates in UTC", () => {
    expect(formatCents(325_000)).toBe("$3,250.00");
    expect(formatCents(-5)).toBe("-$0.05");
    expect(utcDate("2026-10-02", "x")).toBe(Date.UTC(2026, 9, 2));
    expect(() => utcDate("2026-02-30", "x")).toThrow("Invalid calendar date");
  });
});

describe("ERP source adapter", () => {
  const state = createSeed(42) as ErpState;

  it("is deterministic: same input gives identical records and sourceIds", () => {
    expect(normalizeErpState(createSeed(42) as ErpState)).toEqual(normalizeErpState(createSeed(42) as ErpState));
  });

  it("derives stable, unique sourceIds from the original IDs", () => {
    const bundle = normalizeErpState(state);
    expect(bundle.issues).toEqual([]);
    expect(bundle.bankTransactions.map(row => row.sourceId)).toEqual(state.transactions.map(row => `bank:txn:${row.id}`));
    expect(bundle.owners[0]).toMatchObject({ sourceId: "erp:company:CMP-001", ownerId: "erp:owner:CMP-001", name: "Client A — Alder Trust", subAccount: "TRUST-01" });
    expect(bundle.obligations[0].sourceId).toBe("erp:invoice:INV-001");
    expect(bundle.documents.find(row => row.raw.rawId === "DOC-MULTI-001")?.sourceId).toBe("erp:document:DOC-MULTI-001:v2");
    const ids = [...bundle.bankTransactions, ...bundle.owners, ...bundle.obligations, ...bundle.documents].map(row => row.sourceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a pointer to every raw record and converts amounts to positive cents with direction", () => {
    const bundle = normalizeErpState(state);
    const outflow = bundle.bankTransactions.find(row => row.raw.rawId === "TX-009")!;
    expect(outflow).toMatchObject({ direction: "outflow", amountCents: 90_000, currency: "USD", raw: { system: "bank", recordType: "transaction", rawId: "TX-009", datasetVersion: "demo-erp-seed-42" } });
    expect(bundle.bankTransactions.find(row => row.raw.rawId === "TX-013")?.duplicateOfSourceId).toBe("bank:txn:TX-012");
    expect(bundle.bankTransactions.find(row => row.raw.rawId === "TX-014")?.clearing).toBe("pending");
    expect(bundle.bankTransactions.find(row => row.raw.rawId === "TX-002")).toMatchObject({ ownerHintSourceId: "erp:company:CMP-002", documentSourceIds: ["erp:document:DOC-OWN-002:v1"] });
    expect(bundle.documents.find(row => row.raw.rawId === "DOC-AGREE-001")?.namedOwnerSourceIds).toEqual(["erp:company:CMP-001", "erp:company:CMP-002"]);
    expect(bundle.bankTransactions.every(row => Number.isSafeInteger(row.amountCents) && row.amountCents > 0)).toBe(true);
  });

  it("imports the cutover snapshot: opening owner balances plus named suspense deposits", () => {
    const bundle = normalizeErpState(state);
    expect(bundle.account).toMatchObject({ accountId: ERP_ACCOUNT_ID, currency: "USD", openingAsOf: Date.parse("2026-10-23T09:00:00.000Z") });
    expect(bundle.statementBalances[0].amountCents).toBe(30_150_000);
    expect(bundle.reconcilingItems[0]).toMatchObject({ amountCents: -150_000, detailed: false });
    const owners = bundle.openingBalances.filter(row => row.ownerId !== null);
    expect(owners.reduce((sum, row) => sum + row.amountCents, 0)).toBe(29_175_000);
    expect(owners.find(row => row.ownerId === "erp:owner:CMP-001")).toMatchObject({ amountCents: 4_000_000, clearedCents: 3_950_000 });
    expect(bundle.openingBalances.filter(row => row.ownerId === null).map(row => [row.bankSourceId, row.amountCents])).toEqual([["bank:txn:TX-001", 325_000], ["bank:txn:TX-002", 500_000]]);
  });

  it("reports unrepresentable records as issues instead of dropping or rounding them", () => {
    const broken = createSeed(42) as ErpState;
    broken.transactions[0] = { ...broken.transactions[0], amount: 32.505 };
    broken.suspenseBalance = 1;
    const bundle = normalizeErpState(broken);
    expect(bundle.bankTransactions.some(row => row.raw.rawId === "TX-001")).toBe(false);
    expect(bundle.issues.map(row => row.rawId)).toEqual(expect.arrayContaining(["TX-001", "suspenseBalance"]));
    expect(bundle.openingBalances.some(row => row.ownerId === null)).toBe(false);
  });

  it("produces the same ledger entry IDs on every import, so upserts are idempotent", () => {
    const first = importLedgerEntries(normalizeErpState(state), 1, "import:test");
    const second = importLedgerEntries(normalizeErpState(createSeed(42) as ErpState), 2, "import:test");
    expect(second.map(row => row.entryId)).toEqual(first.map(row => row.entryId));
    expect(new Set(first.map(row => row.entryId)).size).toBe(first.length);
    expect(first.reduce((sum, row) => sum + row.amountCents, 0)).toBe(30_000_000);
  });
});

describe("demo fixture", () => {
  it("is clearly labelled and records post-cutover inflows as unallocated deposits", () => {
    const bundle = demoMoneyBundle();
    const ids = [bundle.account.accountId, ...bundle.owners.map(o => o.ownerId), ...bundle.bankTransactions.map(t => t.sourceId), ...bundle.documents.map(d => d.sourceId), ...bundle.openingBalances.map(o => o.sourceId)];
    expect(ids.every(id => id.startsWith("demo:"))).toBe(true);
    expect([...bundle.owners.map(o => o.name), ...bundle.documents.map(d => d.title)].every(name => name.startsWith("DEMO"))).toBe(true);
    const entries = importLedgerEntries(bundle, 1, "import:test");
    expect(entries.filter(row => row.kind === "deposit_received").map(row => row.fundsSourceId)).toEqual(["demo:bank:txn:A-001", "demo:bank:txn:B-001"]);
  });
});
