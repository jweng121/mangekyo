/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);

describe("synthetic finance persistence", () => {
  it("returns an empty case and empty task streams before seeding", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.finance.getSyntheticCase, {})).toBeNull();
    expect(await t.query(api.finance.listTaskEvents, { taskId: "unknown" })).toEqual([]);
    expect(await t.query(api.finance.listTaskSnapshots, { taskId: "unknown" })).toEqual([]);
  });

  it("persists exactly one complete case and leaves all records unchanged on repeat", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.finance.seedSyntheticCase, {});
    const before = await t.query(api.finance.getSyntheticCase, {});
    const events = await t.query(api.finance.listTaskEvents, { taskId: first.taskId });
    const snapshots = await t.query(api.finance.listTaskSnapshots, { taskId: first.taskId });
    const second = await t.mutation(api.finance.seedSyntheticCase, {});
    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(await t.query(api.finance.getSyntheticCase, {})).toEqual(before);
    expect(await t.query(api.finance.listTaskEvents, { taskId: first.taskId })).toEqual(events);
    expect(await t.query(api.finance.listTaskSnapshots, { taskId: first.taskId })).toEqual(snapshots);
    await t.run(async (ctx) => {
      for (const table of ["financeCases", "financeOwners", "financeTransactions", "financeDocuments", "financeTasks", "financeEvents", "financeSnapshots"] as const) {
        const rows = await ctx.db.query(table).collect();
        expect(rows).toHaveLength(1);
        expect(rows[0].synthetic).toBe(true);
        expect(rows[0].caseId).toBe(first.caseId);
      }
    });
  });

  it("correlates saved evidence and state without approving or allocating the deposit", async () => {
    const t = convexTest(schema, modules);
    const { taskId, runId, caseId } = await t.mutation(api.finance.seedSyntheticCase, {});
    const data = (await t.query(api.finance.getSyntheticCase, {}))!;
    const [event] = await t.query(api.finance.listTaskEvents, { taskId });
    const [snapshot] = await t.query(api.finance.listTaskSnapshots, { taskId });
    expect(data.transaction.bankStatus).toBe("cleared");
    expect(data.transaction.allocationStatus).toBe("unallocated");
    expect(Number.isSafeInteger(data.transaction.amountCents)).toBe(true);
    expect(data.task.status).toBe("awaiting_investigation");
    expect(snapshot.output).toEqual({
      allocationStatus: "unallocated", allocatedAmountCents: 0,
      approved: false, investigationStatus: "not_started",
    });
    expect(snapshot.taskState).toEqual(data.task);
    expect(snapshot.inputs.evidenceRefs).toEqual(event.evidenceRefs);
    expect(event.evidenceRefs[0]).toEqual({
      sourceId: data.document.sourceId, documentId: data.document.documentId, excerpt: data.document.excerpt,
    });
    expect(data.document.text).toContain(data.document.excerpt);
    expect(snapshot.eventId).toBe(event.eventId);
    expect(event).toMatchObject({ caseId, taskId, runId, sequence: 1, type: "finance.task.created" });
    expect(snapshot).toMatchObject({ caseId, taskId, runId, sequence: 1, timestamp: event.timestamp });
  });

  it("orders each task stream by sequence even when timestamps differ and excludes other tasks", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await t.mutation(api.finance.seedSyntheticCase, {});
    const [event] = await t.query(api.finance.listTaskEvents, { taskId });
    const [snapshot] = await t.query(api.finance.listTaskSnapshots, { taskId });
    await t.run(async (ctx) => {
      for (const sequence of [3, 2]) {
        await ctx.db.insert("financeEvents", { ...event, eventId: `fixture-event-${sequence}`, sequence, timestamp: 100 - sequence });
        await ctx.db.insert("financeSnapshots", { ...snapshot, snapshotId: `fixture-snapshot-${sequence}`, sequence, timestamp: 100 - sequence });
      }
      await ctx.db.insert("financeEvents", { ...event, eventId: "other-event", taskId: "other" });
      await ctx.db.insert("financeSnapshots", { ...snapshot, snapshotId: "other-snapshot", taskId: "other" });
    });
    expect((await t.query(api.finance.listTaskEvents, { taskId })).map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect((await t.query(api.finance.listTaskSnapshots, { taskId })).map((row) => row.sequence)).toEqual([1, 2, 3]);
  });
});
