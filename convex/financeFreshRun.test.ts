/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const requester = { role: "requester" as const, name: "riley" };

describe("Fix 3: fresh DEMO run", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); vi.stubEnv("AUTO_INVESTIGATE", "false"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("creates a new DEMO account with namespaced IDs and leaves earlier runs untouched", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, {});
    await t.mutation(api.financeProposals.requestPayment, { accountId: "demo:account:pool-001", ownerId: "demo:owner:alpha", amountCents: 100, purpose: "old run", evidenceSourceIds: ["demo:document:agreement-alpha:v1"], dev: requester });
    const snapshot = () => t.run(async (ctx) => {
      const tables = ["financeBankTransactions", "financeAccountOwners", "financeSourceDocuments", "financeLedgerEntries", "financeProposals", "financeEvents", "financeSnapshots"] as const;
      const out: Record<string, unknown[]> = {};
      for (const table of tables) out[table] = (await ctx.db.query(table).collect()).filter(r => JSON.stringify(r).includes("demo:account:pool-001")).map(({ _creationTime, ...r }) => r);
      return out;
    });
    const before = await snapshot();

    const fresh = await t.mutation(api.financeIntake.startFreshDemoRun, {});
    expect(fresh).toMatchObject({ accountId: "demo:account:pool-002", updated: 0, issues: [] });
    expect(await snapshot()).toEqual(before);

    const view = await t.query(api.financeIntake.getAccountOverview, { accountId: "demo:account:pool-002" });
    expect(view.account.name).toBe("DEMO pooled client account (run 002)");
    expect(view.threeWay.status).toBe("matched");
    expect(view.proposals).toEqual([]);
    expect(view.owners.map(o => o.ownerId)).toEqual(["demo:run-002:owner:alpha", "demo:run-002:owner:xavier", "demo:run-002:owner:delta", "demo:run-002:owner:yankee"]);
    expect(view.deposits.map(d => d.transaction.sourceId)).toEqual(["demo:run-002:bank:txn:D-001", "demo:run-002:bank:txn:A-001", "demo:run-002:bank:txn:B-001"]);
    expect((await t.query(api.financeIntake.getAccountOverview, { accountId: "demo:account:pool-001" })).threeWay.status).toBe("mismatched");
    expect((await t.mutation(api.financeIntake.startFreshDemoRun, {})).accountId).toBe("demo:account:pool-003");
  });

  it("runs the lock scenarios on the fresh run's own IDs", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    const { accountId } = await t.mutation(api.financeIntake.startFreshDemoRun, {});
    const x = await t.mutation(api.financeProposals.requestPayment, { accountId, ownerId: "demo:run-002:owner:xavier", amountCents: 500_000, purpose: "tax", evidenceSourceIds: ["demo:run-002:document:instruction-x-001:v1"], dev: requester });
    expect(x.lock?.failures.map(f => f.code)).toEqual(["OWNER_INSUFFICIENT_FUNDS"]);
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, { accountId });
    const view = await t.query(api.financeIntake.getAccountOverview, { accountId });
    expect(view.threeWay.causes).toContainEqual(expect.objectContaining({ code: "BANK_TXN_WITHOUT_LEDGER_ENTRY", sourceIds: ["demo:run-002:bank:txn:E-001"], ownerIds: ["demo:run-002:owner:yankee"] }));
    expect((await t.query(api.financeIntake.getAccountOverview, { accountId: "demo:account:pool-001" })).threeWay.status).toBe("matched");
  });
});
