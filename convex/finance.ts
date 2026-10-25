import { v } from "convex/values";
import type { FinanceCaseBundle, FinanceEvent, FinanceSnapshot, FinanceTask, MoneyEvent, MoneySnapshot } from "@mangekyo/contracts";
import { mutation, query } from "./_generated/server";
import * as validators from "./lib/validators";

const CASE_ID = "synthetic-finance-case-001";
const TASK_ID = `${CASE_ID}:task:001`;
const RUN_ID = `${TASK_ID}:run:001`;

function recordOnly<T extends { _id: unknown; _creationTime: number }>(row: T): T extends unknown ? Omit<T, "_id" | "_creationTime"> : never {
  const { _id, _creationTime, ...record } = row;
  return record as T extends unknown ? Omit<T, "_id" | "_creationTime"> : never;
}

/** The original idempotent source fixture. All seven records commit together. */
export const seedSyntheticCase = mutation({
  args: {},
  returns: v.object({ caseId: v.string(), taskId: v.string(), runId: v.string(), created: v.boolean() }),
  handler: async (ctx) => {
    // The indexed read participates in Convex's transaction conflict detection, including
    // concurrent first-time calls. A retry observes the existing case and inserts nothing.
    const existing = await ctx.db.query("financeCases")
      .withIndex("by_caseId", (q) => q.eq("caseId", CASE_ID)).unique();
    if (existing) {
      return { caseId: existing.caseId, taskId: existing.taskId, runId: existing.runId, created: false };
    }

    const now = Date.now();
    const base = { caseId: CASE_ID, synthetic: true as const };
    const ownerId = `${CASE_ID}:owner:001`;
    const transactionId = `${CASE_ID}:transaction:001`;
    const documentId = `${CASE_ID}:document:001`;
    const sourceId = "synthetic:remittance-note:001";
    const eventId = `${RUN_ID}:event:001`;
    const amountCents = 125000;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error("Invalid deposit cents");

    const excerpt = "SYNTHETIC: A $1,250.00 deposit may relate to Example Client A. Confirm the payer and agreement before allocating any funds.";
    const evidenceRefs = [{ sourceId, documentId, excerpt }];
    const task: FinanceTask = {
      ...base, taskId: TASK_ID, runId: RUN_ID, transactionId,
      candidateOwnerId: ownerId, evidenceRefs, status: "awaiting_investigation", createdAt: now,
    };
    const bundle: FinanceCaseBundle = {
      case: { ...base, taskId: TASK_ID, runId: RUN_ID, createdAt: now, label: "Synthetic deposit investigation" },
      owner: { ...base, ownerId, name: "SYNTHETIC — Example Client A" },
      transaction: {
        ...base, transactionId, sourceId: "synthetic:bank-feed:deposit:001", amountCents,
        currency: "USD", direction: "deposit", bankStatus: "cleared", allocationStatus: "unallocated",
        clearedAt: now, description: "SYNTHETIC — Cleared deposit awaiting ownership investigation",
      },
      document: {
        ...base, documentId, sourceId, title: "SYNTHETIC — Unverified remittance note", mimeType: "text/plain",
        text: `${excerpt}\nThis is fabricated development evidence. It is not an instruction to allocate or execute a payment.`, excerpt,
      },
      task,
    };
    const event: FinanceEvent = {
      ...base, eventId, taskId: TASK_ID, runId: RUN_ID, sequence: 1,
      type: "finance.task.created", timestamp: now,
      actor: { type: "system", component: "finance-dev.synthetic-seed" }, evidenceRefs,
      payload: { transactionId, candidateOwnerId: ownerId, amountCents, currency: "USD", allocationStatus: "unallocated" },
    };
    const snapshot: FinanceSnapshot = {
      ...base, snapshotId: `${RUN_ID}:snapshot:001`, eventId, taskId: TASK_ID,
      runId: RUN_ID, sequence: 1, timestamp: now, taskState: task,
      inputs: { transactionId, candidateOwnerId: ownerId, evidenceRefs },
      output: { allocationStatus: "unallocated", allocatedAmountCents: 0, approved: false, investigationStatus: "not_started" },
    };
    await ctx.db.insert("financeCases", bundle.case);
    await ctx.db.insert("financeOwners", bundle.owner);
    await ctx.db.insert("financeTransactions", bundle.transaction);
    await ctx.db.insert("financeDocuments", bundle.document);
    await ctx.db.insert("financeTasks", task);
    // Append-only: no endpoint patches or deletes events or snapshots.
    await ctx.db.insert("financeEvents", event);
    await ctx.db.insert("financeSnapshots", snapshot);
    return { caseId: CASE_ID, taskId: TASK_ID, runId: RUN_ID, created: true };
  },
});

export const getSyntheticCase = query({
  args: {},
  returns: v.union(v.null(), validators.caseBundle),
  handler: async (ctx): Promise<FinanceCaseBundle | null> => {
    const financeCase = await ctx.db.query("financeCases")
      .withIndex("by_caseId", (q) => q.eq("caseId", CASE_ID)).unique();
    if (!financeCase) return null;
    const owner = await ctx.db.query("financeOwners")
      .withIndex("by_caseId", (q) => q.eq("caseId", CASE_ID)).unique();
    const transaction = await ctx.db.query("financeTransactions")
      .withIndex("by_caseId", (q) => q.eq("caseId", CASE_ID)).unique();
    const document = await ctx.db.query("financeDocuments")
      .withIndex("by_caseId", (q) => q.eq("caseId", CASE_ID)).unique();
    const task = await ctx.db.query("financeTasks")
      .withIndex("by_taskId", (q) => q.eq("taskId", financeCase.taskId)).unique();
    if (!owner || !transaction || !document || !task) throw new Error("Synthetic case records are incomplete");
    return {
      case: recordOnly(financeCase), owner: recordOnly(owner), transaction: recordOnly(transaction),
      document: recordOnly(document), task: recordOnly(task),
    };
  },
});

/** Ascending task sequence; independent of client clocks and display timestamps. */
export const listTaskEvents = query({
  args: { taskId: v.string(), afterSequence: v.optional(v.number()) },
  returns: v.array(v.union(validators.taskCreatedEvent, validators.investigationEvent)),
  handler: async (ctx, { taskId, afterSequence }): Promise<FinanceEvent[]> => {
    const rows = await ctx.db.query("financeEvents")
      .withIndex("by_taskId_and_sequence", (q) => q.eq("taskId", taskId).gt("sequence", afterSequence ?? 0)).order("asc").take(100);
    return rows.map(recordOnly).filter((row): row is FinanceEvent => !row.type.startsWith("finance.money."));
  },
});

export const listTaskSnapshots = query({
  args: { taskId: v.string(), afterSequence: v.optional(v.number()) },
  returns: v.array(v.union(validators.initialSnapshot, validators.investigationSnapshot)),
  handler: async (ctx, { taskId, afterSequence }): Promise<FinanceSnapshot[]> => {
    const rows = await ctx.db.query("financeSnapshots")
      .withIndex("by_taskId_and_sequence", (q) => q.eq("taskId", taskId).gt("sequence", afterSequence ?? 0)).order("asc").take(100);
    return rows.map(recordOnly).filter((row): row is FinanceSnapshot => !("kind" in row));
  },
});

/** Account money stream (`money:<accountId>`): imports, lock checks, transitions and postings. */
export const listMoneyEvents = query({
  args: { accountId: v.string(), afterSequence: v.optional(v.number()) },
  returns: v.array(validators.moneyEvent),
  handler: async (ctx, { accountId, afterSequence }): Promise<MoneyEvent[]> => {
    const rows = await ctx.db.query("financeEvents")
      .withIndex("by_taskId_and_sequence", (q) => q.eq("taskId", `money:${accountId}`).gt("sequence", afterSequence ?? 0)).order("asc").take(100);
    return rows.map(recordOnly).filter((row): row is MoneyEvent => row.type.startsWith("finance.money."));
  },
});

export const listMoneySnapshots = query({
  args: { accountId: v.string(), afterSequence: v.optional(v.number()) },
  returns: v.array(validators.moneySnapshot),
  handler: async (ctx, { accountId, afterSequence }): Promise<MoneySnapshot[]> => {
    const rows = await ctx.db.query("financeSnapshots")
      .withIndex("by_taskId_and_sequence", (q) => q.eq("taskId", `money:${accountId}`).gt("sequence", afterSequence ?? 0)).order("asc").take(100);
    return rows.map(recordOnly).filter((row): row is MoneySnapshot => "kind" in row);
  },
});
