/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const ERP = "erp:account:trust-pool";
const DEMO = "demo:account:pool-001";

type T = ReturnType<typeof convexTest>;
const autoEvents = async (t: T, accountId: string) => (await t.query(api.finance.listMoneyEvents, { accountId }))
  .filter(e => e.type === "finance.money.auto_investigation")
  .map(e => ({ deposit: e.payload.sourceIds[0], allowed: e.payload.allowed, message: e.payload.message }));
/** Run only what is due now, a few rounds deep, so 10-minute expiry timers do not fire first. */
async function drain(t: T) {
  for (let round = 0; round < 5; round++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); }
}
const runsFor = (t: T, accountId: string, bankSourceId: string) =>
  t.query(api.financeInvestigations.getTaskInvestigation, { taskId: `intake:${accountId}:deposit:${bankSourceId}` }).then(view => view.runs);

describe("auto-investigation of newly recorded deposits", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("mock mode, default setting: each new cleared deposit gets exactly one investigation, and proposals wait for approval", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "mock");
    const t = convexTest(schema, modules);
    expect(await t.query(api.financeInvestigations.getAutoInvestigationSetting, {})).toMatchObject({ enabled: true, code: "AUTO_ENABLED" });
    await t.mutation(api.financeIntake.importErpSandbox, {});
    await drain(t);

    const events = await autoEvents(t, ERP);
    expect(events.map(e => [e.deposit, e.allowed])).toEqual([["bank:txn:TX-001", true], ["bank:txn:TX-002", true]]);
    expect(events[0].message).toContain("still need a person to approve");
    for (const deposit of ["bank:txn:TX-001", "bank:txn:TX-002"]) {
      const runs = await runsFor(t, ERP, deposit);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ mode: "mock", simulated: true, status: "review_required", attempt: 1 });
    }
    const overview = await t.query(api.financeIntake.getAccountOverview, { accountId: ERP });
    expect(overview.proposals.map(p => [p.bankSourceId, p.status])).toEqual(expect.arrayContaining([["bank:txn:TX-001", "pending_approval"], ["bank:txn:TX-002", "pending_approval"]]));
    expect(overview.entries.some(e => e.kind === "allocation")).toBe(false);
    expect(overview.threeWay.status).toBe("matched");
  });

  it("is idempotent: re-importing schedules nothing, and a repeated trigger is skipped with a reason", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "mock");
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    await drain(t);
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    await drain(t);
    expect((await autoEvents(t, DEMO)).map(e => e.deposit)).toEqual(["demo:bank:txn:A-001", "demo:bank:txn:B-001"]);

    await t.mutation(internal.financeIntake.autoInvestigateDeposit, { accountId: DEMO, bankSourceId: "demo:bank:txn:B-001" });
    const last = (await autoEvents(t, DEMO)).at(-1)!;
    expect(last).toMatchObject({ deposit: "demo:bank:txn:B-001", allowed: false });
    expect(last.message).toContain("already has investigation");
    expect(await runsFor(t, DEMO, "demo:bank:txn:B-001")).toHaveLength(1);
    expect((await runsFor(t, DEMO, "demo:bank:txn:B-001"))[0].status).toBe("needs_information");
  });

  it("does not start a second run when a person already started one", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "mock");
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    const { taskId } = await t.mutation(api.financeIntake.ensureDepositTask, { accountId: DEMO, bankSourceId: "demo:bank:txn:A-001" });
    await t.mutation(api.financeInvestigations.startInvestigation, { taskId, scope: { kind: "deposit_investigation", accountId: DEMO, currency: "USD", from: null } });
    await drain(t);
    expect(await runsFor(t, DEMO, "demo:bank:txn:A-001")).toHaveLength(1);
    const forA = (await autoEvents(t, DEMO)).filter(e => e.deposit === "demo:bank:txn:A-001");
    expect(forA).toEqual([expect.objectContaining({ allowed: false })]);
  });

  it("creao mode defaults OFF: no run, no task, no network call, and the skip is recorded", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "creao");
    vi.stubEnv("CREAO_APP_ID", "test-app");
    vi.stubEnv("CREAO_API_KEY", "capi_test");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const t = convexTest(schema, modules);
    expect(await t.query(api.financeInvestigations.getAutoInvestigationSetting, {})).toMatchObject({ enabled: false, code: "AUTO_OFF_IN_CREAO" });
    await t.mutation(api.financeIntake.importErpSandbox, {});
    await drain(t);
    const events = await autoEvents(t, ERP);
    expect(events.map(e => [e.deposit, e.allowed])).toEqual([["bank:txn:TX-001", false], ["bank:txn:TX-002", false]]);
    expect(events[0].message).toContain("no paid run starts without a person");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("financeTasks").collect()).toEqual([]);
      expect(await ctx.db.query("financeInvestigationRuns").collect()).toEqual([]);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creao mode starts only on an explicit AUTO_INVESTIGATE=true opt-in", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "creao");
    vi.stubEnv("CREAO_APP_ID", "test-app");
    vi.stubEnv("CREAO_API_KEY", "capi_test");
    vi.stubEnv("AUTO_INVESTIGATE", "true");
    const t = convexTest(schema, modules);
    expect(await t.query(api.financeInvestigations.getAutoInvestigationSetting, {})).toMatchObject({ enabled: true });
  });

  it("respects AUTO_INVESTIGATE=false, an invalid value, and an unset provider mode", async () => {
    for (const [mode, setting, code] of [["mock", "false", "AUTO_DISABLED_SETTING"], ["mock", "yes", "AUTO_SETTING_INVALID"], [undefined, undefined, "MODE_NOT_CONFIGURED"]] as const) {
      vi.unstubAllEnvs();
      if (mode) vi.stubEnv("FINANCE_AGENT_MODE", mode);
      if (setting) vi.stubEnv("AUTO_INVESTIGATE", setting);
      const t = convexTest(schema, modules);
      expect(await t.query(api.financeInvestigations.getAutoInvestigationSetting, {})).toMatchObject({ enabled: false, code });
      await t.mutation(api.financeIntake.loadDemoFixture, {});
      await drain(t);
      expect((await autoEvents(t, DEMO)).every(e => e.allowed === false)).toBe(true);
      await t.run(async (ctx) => { expect(await ctx.db.query("financeInvestigationRuns").collect()).toEqual([]); });
    }
  });

  it("starts when a recorded deposit changes from pending to cleared on re-import", async () => {
    vi.stubEnv("FINANCE_AGENT_MODE", "mock");
    vi.stubEnv("AUTO_INVESTIGATE", "false");
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("financeBankTransactions").withIndex("by_sourceId", (q) => q.eq("sourceId", "demo:bank:txn:B-001")).unique())!;
      await ctx.db.patch("financeBankTransactions", row._id, { clearing: "pending" });
    });
    vi.stubEnv("AUTO_INVESTIGATE", "");
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    await drain(t);
    expect((await autoEvents(t, DEMO)).filter(e => e.allowed).map(e => e.deposit)).toEqual(["demo:bank:txn:B-001"]);
    expect(await runsFor(t, DEMO, "demo:bank:txn:B-001")).toHaveLength(1);
  });
});
