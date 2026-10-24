import { ConvexError, v } from "convex/values";
import type { NormalizedAccountBundle, NormalizedBankTransaction } from "@mangekyo/contracts";
import { candidateOwnerSourceIds, depositCaseId, normalizeErpState, type ErpState } from "@mangekyo/finance-core/intake";
import { importLedgerEntries, ownerBalances, threeWayCheck } from "@mangekyo/finance-core/ledger";
import { DEMO_ACCOUNT_ID, demoMoneyBundle, demoSettlement, demoUnrecordedOutflow } from "@mangekyo/finance-core/fixtures/demo-money";
// Read-only use of the teammate's deterministic generator; his runtime state file is never touched.
import { createSeed } from "../apps/demo-erp/data/seed";
import { mutation, query, type MutationCtx } from "./_generated/server";
import * as money from "./lib/moneyValidators";
import { appendMoneyEvent, compact, LATEST, loadAccount, SYSTEM, getProposal, requireAccount } from "./lib/money";
import { recordOnly } from "./lib/investigationRecords";

type SourceTable = "financeBankTransactions" | "financeAccountOwners" | "financeObligations" | "financeSourceDocuments" | "financeBankStatements" | "financeReconcilingItems";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Upsert keyed by sourceId: unchanged rows are not rewritten, so repeated imports create nothing. */
async function upsert(ctx: MutationCtx, table: SourceTable, row: { sourceId: string } & Record<string, unknown>): Promise<"inserted" | "updated" | "unchanged"> {
  const existing = await ctx.db.query(table).withIndex("by_sourceId", (q) => q.eq("sourceId", row.sourceId)).unique();
  if (!existing) { await ctx.db.insert(table, row as never); return "inserted"; }
  if (stable(recordOnly(existing)) === stable(row)) return "unchanged";
  await ctx.db.replace(table, existing._id, row as never);
  return "updated";
}

const importResult = v.object({ accountId: v.string(), inserted: v.number(), updated: v.number(), unchanged: v.number(), entriesInserted: v.number(), issues: v.array(money.issue) });

async function importBundle(ctx: MutationCtx, bundle: NormalizedAccountBundle, system: "erp" | "demo") {
  const now = Date.now();
  const accountId = bundle.account.accountId;
  const counts = { inserted: 0, updated: 0, unchanged: 0 };
  const groups: Array<[SourceTable, Array<{ sourceId: string } & object>]> = [
    ["financeAccountOwners", bundle.owners], ["financeBankTransactions", bundle.bankTransactions], ["financeObligations", bundle.obligations],
    ["financeSourceDocuments", bundle.documents], ["financeBankStatements", bundle.statementBalances], ["financeReconcilingItems", bundle.reconcilingItems],
  ];
  for (const [table, rows] of groups) for (const row of rows) counts[await upsert(ctx, table, row as { sourceId: string })]++;
  const issues = [...bundle.issues];
  let entriesInserted = 0;
  for (const entry of importLedgerEntries(bundle, now, `import:${system}-adapter`)) {
    const existing = await ctx.db.query("financeLedgerEntries").withIndex("by_entryId", (q) => q.eq("entryId", entry.entryId)).unique();
    if (!existing) { await ctx.db.insert("financeLedgerEntries", compact(entry)); entriesInserted++; continue; }
    // Ledger rows are never rewritten. A changed source value is reported, and the three-way check will show it.
    if (existing.amountCents !== entry.amountCents || existing.ownerId !== entry.ownerId) issues.push({ rawId: entry.entryId, reason: "Source value changed since the first import; the existing ledger entry was kept." });
  }
  const account = await ctx.db.query("financeAccounts").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).unique();
  const stored = { ...bundle.account, system, datasetVersion: bundle.account.raw.datasetVersion, importedAt: account?.importedAt ?? now, issues };
  if (!account) await ctx.db.insert("financeAccounts", stored);
  else if (stable({ ...recordOnly(account), importedAt: 0 }) !== stable({ ...stored, importedAt: 0 })) await ctx.db.replace("financeAccounts", account._id, stored);
  const loaded = await loadAccount(ctx, accountId);
  await appendMoneyEvent(ctx, { accountId, type: "finance.money.import_completed", actor: SYSTEM, operationId: `import:${accountId}:${now}`, stage: "import",
    message: `${system} import: ${counts.inserted} inserted, ${counts.updated} updated, ${counts.unchanged} unchanged source records; ${entriesInserted} new ledger entries; ${issues.length} issue(s).`,
    threeWay: threeWayCheck(loaded.state, now), sourceIds: issues.map(row => row.rawId) });
  return { accountId, ...counts, entriesInserted, issues };
}

export const importErpSandbox = mutation({
  args: {}, returns: importResult,
  handler: async (ctx) => await importBundle(ctx, normalizeErpState(createSeed(42) as ErpState), "erp"),
});

export const loadDemoFixture = mutation({
  args: {}, returns: importResult,
  handler: async (ctx) => await importBundle(ctx, demoMoneyBundle(), "demo"),
});

async function insertDemoBankItem(ctx: MutationCtx, txn: NormalizedBankTransaction, message: string) {
  const existing = await ctx.db.query("financeBankTransactions").withIndex("by_sourceId", (q) => q.eq("sourceId", txn.sourceId)).unique();
  if (existing) return { sourceId: txn.sourceId, created: false };
  await ctx.db.insert("financeBankTransactions", txn);
  const loaded = await loadAccount(ctx, txn.accountId);
  await appendMoneyEvent(ctx, { accountId: txn.accountId, type: "finance.money.bank_item_recorded", actor: SYSTEM, operationId: txn.sourceId, stage: "bank_feed", message, threeWay: threeWayCheck(loaded.state, Date.now()), sourceIds: [txn.sourceId] });
  return { sourceId: txn.sourceId, created: true };
}

const simulated = v.object({ sourceId: v.string(), created: v.boolean() });

/** DEV ONLY, DEMO account only: a bank-feed outflow nobody recorded (scenario E). */
export const simulateUnrecordedOutflow = mutation({
  args: {}, returns: simulated,
  handler: async (ctx) => {
    await requireAccount(ctx, DEMO_ACCOUNT_ID);
    return await insertDemoBankItem(ctx, demoUnrecordedOutflow(Date.now()), "DEMO bank feed: unrecorded outflow arrived (simulated).");
  },
});

/** DEV ONLY, DEMO account only: the bank feed confirms a posted payment. */
export const simulateSettlement = mutation({
  args: { proposalId: v.string() }, returns: simulated,
  handler: async (ctx, { proposalId }) => {
    const proposal = await getProposal(ctx, proposalId);
    if (proposal.accountId !== DEMO_ACCOUNT_ID) throw new ConvexError("Bank settlement can only be simulated on the DEMO account; the ERP bank feed is the teammate's data.");
    if (proposal.kind !== "payment" || proposal.status !== "posted") throw new ConvexError("Only posted payments settle at the bank.");
    const loaded = await loadAccount(ctx, proposal.accountId);
    const ownerSourceId = loaded.state.owners.find(o => o.ownerId === proposal.ownerId)?.sourceId ?? null;
    return await insertDemoBankItem(ctx, demoSettlement(proposalId, proposal.amountCents, Date.now(), ownerSourceId), `DEMO bank feed: settlement of ${proposalId} arrived (simulated).`);
  },
});

/** Creates (once) the investigation task for a cleared, recorded, unallocated deposit. */
export const ensureDepositTask = mutation({
  args: { accountId: v.string(), bankSourceId: v.string() }, returns: v.object({ taskId: v.string(), created: v.boolean() }),
  handler: async (ctx, { accountId, bankSourceId }) => {
    const taskId = `${depositCaseId(accountId)}:deposit:${bankSourceId}`;
    const existing = await ctx.db.query("financeTasks").withIndex("by_taskId", (q) => q.eq("taskId", taskId)).unique();
    if (existing) return { taskId, created: false };
    const loaded = await loadAccount(ctx, accountId);
    const deposit = loaded.state.bankTransactions.find(t => t.sourceId === bankSourceId);
    if (!deposit || deposit.direction !== "inflow") throw new ConvexError("Only bank deposits can be investigated.");
    if (deposit.clearing !== "cleared") throw new ConvexError("This deposit has not cleared; investigation input v1 only carries cleared deposits.");
    if (!loaded.state.entries.some(e => e.kind === "deposit_received" && e.fundsSourceId === bankSourceId)) throw new ConvexError("This deposit is not recorded in the ledger (it predates the cutover and is reflected in opening balances).");
    if (loaded.state.entries.some(e => e.kind === "allocation" && e.fundsSourceId === bankSourceId)) throw new ConvexError("This deposit is already allocated.");
    const candidates = candidateOwnerSourceIds({ deposit, documents: loaded.documents, obligations: loaded.obligations, state: loaded.state });
    const candidate = loaded.state.owners.find(o => o.sourceId === candidates[0]);
    const linked = loaded.documents.filter(d => deposit.documentSourceIds.includes(d.sourceId));
    await ctx.db.insert("financeTasks", {
      synthetic: true, caseId: depositCaseId(accountId), taskId, runId: `${taskId}:run:001`, transactionId: deposit.sourceId,
      candidateOwnerId: candidate?.ownerId ?? "unidentified", evidenceRefs: linked.map(d => ({ sourceId: d.sourceId, documentId: d.raw.rawId, excerpt: d.excerpt })),
      status: "awaiting_investigation", createdAt: Date.now(), accountId, bankSourceId,
    });
    return { taskId, created: true };
  },
});

const depositRow = v.object({
  transaction: money.bankTransaction, status: v.union(v.literal("historical"), v.literal("awaiting_clearance"), v.literal("unallocated"), v.literal("proposed"), v.literal("posted")),
  taskId: v.union(v.string(), v.null()), allocatedTo: v.array(v.string()),
});

export const listAccounts = query({
  args: {}, returns: v.array(money.storedAccount),
  handler: async (ctx) => (await ctx.db.query("financeAccounts").take(20)).map(recordOnly),
});

/** Everything the money panel shows for one account. Omit cutoff for the latest recorded state. */
export const getAccountOverview = query({
  args: { accountId: v.string(), cutoff: v.optional(v.number()) },
  returns: v.object({
    account: money.storedAccount, threeWay: money.threeWay, balances: v.array(money.ownerBalance), deposits: v.array(depositRow),
    owners: v.array(money.owner), documents: v.array(v.object({ sourceId: v.string(), title: v.string(), documentType: v.string(), excerpt: v.string() })),
    obligations: v.array(money.obligation), entries: v.array(money.ledgerEntry), proposals: v.array(money.proposal),
  }),
  handler: async (ctx, { accountId, cutoff }) => {
    const loaded = await loadAccount(ctx, accountId);
    const at = cutoff ?? LATEST;
    const tasks = await ctx.db.query("financeTasks").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(200);
    const deposits = loaded.state.bankTransactions.filter(t => t.direction === "inflow").sort((a, b) => a.bookedAt - b.bookedAt).map(transaction => {
      const recorded = loaded.state.entries.some(e => e.kind === "deposit_received" && e.fundsSourceId === transaction.sourceId);
      const allocatedTo = loaded.state.entries.filter(e => e.kind === "allocation" && e.ownerId !== null && e.fundsSourceId === transaction.sourceId).map(e => e.ownerId!);
      const proposed = loaded.proposals.some(p => p.kind === "allocation" && p.bankSourceId === transaction.sourceId && (p.status === "pending_approval" || p.status === "approved"));
      const status = allocatedTo.length ? "posted" as const : !recorded ? "historical" as const : transaction.clearing !== "cleared" ? "awaiting_clearance" as const : proposed ? "proposed" as const : "unallocated" as const;
      return { transaction, status, taskId: tasks.find(t => t.bankSourceId === transaction.sourceId)?.taskId ?? null, allocatedTo };
    });
    const { _id, _creationTime, ...account } = loaded.account;
    return {
      account, threeWay: threeWayCheck(loaded.state, at), balances: ownerBalances(loaded.state, at), deposits,
      owners: loaded.state.owners, documents: loaded.documents.map(d => ({ sourceId: d.sourceId, title: d.title, documentType: d.documentType, excerpt: d.excerpt })),
      obligations: loaded.obligations,
      entries: [...loaded.state.entries].sort((a, b) => b.effectiveAt - a.effectiveAt || b.entryId.localeCompare(a.entryId)).slice(0, 200),
      proposals: [...loaded.proposals].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100),
    };
  },
});
