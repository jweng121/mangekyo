import type { FinanceRecordSet, InvestigationScope, LedgerEntry, LockResult, MoneyEvent, MoneyProposal, MoneySnapshot, ProposalStatus, ThreeWayCheckResult } from "@mangekyo/contracts";
import { ConvexError } from "convex/values";
import { buildPostingEntries, canTransition, evaluateAllocation, evaluatePayment, type GatewayContext } from "@mangekyo/finance-core/gateway";
import { buildDepositRecordSet, depositCaseId } from "@mangekyo/finance-core/intake";
import { threeWayCheck, type AccountLedgerState } from "@mangekyo/finance-core/ledger";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { recordOnly } from "./investigationRecords";

const MAX_ROWS = 2000;
export const LATEST = Number.MAX_SAFE_INTEGER;

/** Convex rejects undefined field values; posting builders may leave optional fields undefined. */
export function compact<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}

async function bounded<T>(rows: Promise<T[]>, what: string): Promise<T[]> {
  const list = await rows;
  if (list.length > MAX_ROWS) throw new Error(`${what} exceeds the ${MAX_ROWS}-row development limit for one account`);
  return list;
}

export async function requireAccount(ctx: QueryCtx | MutationCtx, accountId: string) {
  const account = await ctx.db.query("financeAccounts").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).unique();
  if (!account) throw new ConvexError(`Unknown account ${accountId}; import it first.`);
  return account;
}

export interface LoadedAccount {
  account: Doc<"financeAccounts">;
  state: AccountLedgerState;
  documents: Array<ReturnType<typeof recordOnly<Doc<"financeSourceDocuments">>>>;
  obligations: Array<ReturnType<typeof recordOnly<Doc<"financeObligations">>>>;
  proposals: MoneyProposal[];
  statements: Array<ReturnType<typeof recordOnly<Doc<"financeBankStatements">>>>;
}

export async function loadAccount(ctx: QueryCtx | MutationCtx, accountId: string): Promise<LoadedAccount> {
  const account = await requireAccount(ctx, accountId);
  const take = MAX_ROWS + 1;
  const [bank, owners, obligations, documents, statements, reconciling, proposals, entries] = await Promise.all([
    bounded(ctx.db.query("financeBankTransactions").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(take), "bank transactions"),
    bounded(ctx.db.query("financeAccountOwners").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(take), "owners"),
    bounded(ctx.db.query("financeObligations").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(take), "obligations"),
    bounded(ctx.db.query("financeSourceDocuments").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(take), "documents"),
    bounded(ctx.db.query("financeBankStatements").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(take), "statements"),
    bounded(ctx.db.query("financeReconcilingItems").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(take), "reconciling items"),
    bounded(ctx.db.query("financeProposals").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(take), "proposals"),
    bounded(ctx.db.query("financeLedgerEntries").withIndex("by_accountId_and_effectiveAt", (q) => q.eq("accountId", accountId)).take(take), "ledger entries"),
  ]);
  const proposalList = proposals.map(recordOnly) as MoneyProposal[];
  const { system, datasetVersion, importedAt, issues, ...moneyAccount } = recordOnly(account);
  return {
    account,
    state: {
      account: moneyAccount, owners: owners.map(recordOnly), bankTransactions: bank.map(recordOnly),
      statementBalances: statements.map(recordOnly), reconcilingItems: reconciling.map(recordOnly),
      entries: entries.map(recordOnly) as LedgerEntry[],
      holds: proposalList.filter(p => p.kind === "payment" && (p.status === "pending_approval" || p.status === "approved") && p.ownerId)
        .map(p => ({ proposalId: p.proposalId, ownerId: p.ownerId!, amountCents: p.amountCents })),
    },
    documents: documents.map(recordOnly), obligations: obligations.map(recordOnly), proposals: proposalList, statements: statements.map(recordOnly),
  };
}

export async function knownSourceIds(ctx: QueryCtx | MutationCtx, loaded: LoadedAccount): Promise<Set<string>> {
  const tasks = await ctx.db.query("financeTasks").withIndex("by_accountId", (q) => q.eq("accountId", loaded.state.account.accountId)).take(200);
  const clarifications = (await Promise.all(tasks.map(task => ctx.db.query("financeClarifications").withIndex("by_taskId_and_timestamp", (q) => q.eq("taskId", task.taskId)).take(100)))).flat();
  return new Set([
    ...loaded.state.bankTransactions.map(r => r.sourceId), ...loaded.state.owners.map(r => r.sourceId), ...loaded.documents.map(r => r.sourceId),
    ...loaded.obligations.map(r => r.sourceId), ...loaded.state.statementBalances.map(r => r.sourceId), ...loaded.state.reconcilingItems.map(r => r.sourceId),
    ...clarifications.map(r => r.sourceId),
  ]);
}

export interface Actor { identity: string; authenticated: boolean; role: "requester" | "approver" | "system" }

/** Real auth identity when present; otherwise a dev-only, explicitly unverified label from the role switcher. */
export async function resolveActor(ctx: MutationCtx, dev: { role: "requester" | "approver"; name: string }): Promise<Actor> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) return { identity: identity.tokenIdentifier, authenticated: true, role: dev.role };
  const name = dev.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40);
  if (!name) throw new ConvexError("Enter a dev identity name.");
  // The role is not part of the identity: one person switching roles is still the same identity for L4.
  return { identity: `dev-unverified:${name}`, authenticated: false, role: dev.role };
}

export const SYSTEM: Actor = { identity: "system:finance-money", authenticated: false, role: "system" };

export function streamId(accountId: string) { return `money:${accountId}`; }

export async function appendMoneyEvent(ctx: MutationCtx, args: {
  accountId: string; type: MoneyEvent["type"]; actor: Actor; operationId: string; message: string;
  proposal?: MoneyProposal | null; lock?: LockResult | null; threeWay?: ThreeWayCheckResult | null; entryIds?: string[]; sourceIds?: string[]; stage: string;
}) {
  const taskId = streamId(args.accountId);
  const last = await ctx.db.query("financeEvents").withIndex("by_taskId_and_sequence", (q) => q.eq("taskId", taskId)).order("desc").first();
  const sequence = (last?.sequence ?? 0) + 1;
  const timestamp = Date.now();
  const eventId = `${taskId}:event:${sequence}`;
  const base = { synthetic: true as const, caseId: depositCaseId(args.accountId), taskId, runId: args.operationId, sequence, timestamp, eventId };
  const event: MoneyEvent = {
    ...base, type: args.type, evidenceRefs: [],
    actor: args.actor.role === "system" ? { type: "system", component: "finance-money" } : { type: "human", component: "finance-dev", identity: args.actor.identity, authenticated: args.actor.authenticated },
    payload: {
      accountId: args.accountId, message: args.message, proposalId: args.proposal?.proposalId ?? null, allowed: args.lock ? args.lock.allowed : null,
      reasonCodes: args.lock?.failures.map(f => f.code) ?? [], sourceIds: [...new Set([...(args.sourceIds ?? []), ...(args.lock?.failures.flatMap(f => f.sourceIds) ?? [])])], entryIds: args.entryIds ?? [],
    },
  };
  const snapshot: MoneySnapshot = {
    ...base, kind: "money", snapshotId: `${taskId}:snapshot:${sequence}`,
    inputs: { accountId: args.accountId, proposalId: args.proposal?.proposalId ?? null, stage: args.stage },
    output: { proposal: args.proposal ? compact(args.proposal) : null, lock: args.lock ?? null, threeWay: args.threeWay ?? null, entryIds: args.entryIds ?? [] },
  };
  await ctx.db.insert("financeEvents", event);
  await ctx.db.insert("financeSnapshots", snapshot);
}

export async function gatewayContext(ctx: MutationCtx, loaded: LoadedAccount, cutoff: number): Promise<GatewayContext> {
  return { state: loaded.state, threeWay: threeWayCheck(loaded.state, cutoff), knownSourceIds: await knownSourceIds(ctx, loaded), proposals: loaded.proposals, cutoff };
}

export function evaluate(gateway: GatewayContext, proposal: MoneyProposal, stage: LockResult["stage"], actor: string, to: ProposalStatus): LockResult {
  const args = { stage, actor, transition: { from: proposal.status, to } };
  return proposal.kind === "payment"
    ? evaluatePayment(gateway, { proposalId: proposal.proposalId, ownerId: proposal.ownerId ?? "", amountCents: proposal.amountCents, currency: proposal.currency, evidenceSourceIds: proposal.evidenceSourceIds, fundingSourceId: proposal.fundingSourceId, requestedBy: proposal.requestedBy }, args)
    : evaluateAllocation(gateway, { proposalId: proposal.proposalId, bankSourceId: proposal.bankSourceId ?? "", shares: proposal.shares ?? [], currency: proposal.currency, evidenceSourceIds: proposal.evidenceSourceIds, requestedBy: proposal.requestedBy }, args);
}

async function findProposalRow(ctx: MutationCtx, proposalId: string) {
  return await ctx.db.query("financeProposals").withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId)).unique();
}

/** Records a state change (or a refused one) with its lock result; the proposal row only changes status fields. */
export async function transition(ctx: MutationCtx, proposal: MoneyProposal, to: ProposalStatus, actor: Actor, reason: string | null, lock: LockResult | null, threeWay: ThreeWayCheckResult | null, patch: Partial<MoneyProposal> = {}): Promise<MoneyProposal> {
  const row = await findProposalRow(ctx, proposal.proposalId);
  const at = Date.now();
  const count = (await ctx.db.query("financeProposalTransitions").withIndex("by_proposalId", (q) => q.eq("proposalId", proposal.proposalId)).take(100)).length;
  const transitionId = `${proposal.proposalId}:transition:${count + 1}`;
  const next: MoneyProposal = compact({ ...proposal, ...patch, status: to, updatedAt: at });
  if (!row) await ctx.db.insert("financeProposals", next);
  else await ctx.db.patch("financeProposals", row._id, compact({ ...patch, status: to, updatedAt: at }));
  await ctx.db.insert("financeProposalTransitions", { transitionId, proposalId: proposal.proposalId, accountId: proposal.accountId, from: row ? proposal.status : null, to, actor: actor.identity, reason, lock, at });
  await appendMoneyEvent(ctx, { accountId: proposal.accountId, type: "finance.money.proposal_transitioned", actor, operationId: proposal.proposalId, message: `${proposal.kind} ${proposal.proposalId}: ${row ? proposal.status : "new"} → ${to}${reason ? ` (${reason})` : ""}`, proposal: next, lock, threeWay, stage: to, sourceIds: proposal.evidenceSourceIds });
  return next;
}

/** Creates a proposal, runs every lock rule, and moves it to pending_approval or blocked. Never throws on a lock failure. */
export async function submitProposal(ctx: MutationCtx, draft: MoneyProposal, actor: Actor): Promise<{ proposal: MoneyProposal; lock: LockResult }> {
  if (await findProposalRow(ctx, draft.proposalId)) throw new ConvexError(`Proposal ${draft.proposalId} already exists.`);
  const loaded = await loadAccount(ctx, draft.accountId);
  const gateway = await gatewayContext(ctx, loaded, Date.now());
  const proposed = await transition(ctx, draft, "proposed", actor, null, null, gateway.threeWay);
  const lock = evaluate(gateway, proposed, "request", actor.identity, "pending_approval");
  await appendMoneyEvent(ctx, { accountId: draft.accountId, type: "finance.money.lock_checked", actor, operationId: draft.proposalId, message: lock.allowed ? "All lock rules passed at request." : lock.failures.map(f => `${f.rule} ${f.code}: ${f.message}`).join(" | "), proposal: proposed, lock, threeWay: gateway.threeWay, stage: "request" });
  const proposal = lock.allowed
    ? await transition(ctx, proposed, "pending_approval", actor, null, lock, gateway.threeWay)
    : await transition(ctx, proposed, "blocked", actor, lock.failures.map(f => f.code).join(", "), lock, gateway.threeWay, { blockedReasons: lock.failures });
  return { proposal, lock };
}

export async function getProposal(ctx: MutationCtx, proposalId: string): Promise<MoneyProposal> {
  const row = await findProposalRow(ctx, proposalId);
  if (!row) throw new ConvexError(`Unknown proposal ${proposalId}`);
  return recordOnly(row) as MoneyProposal;
}

/** Re-runs every rule at approval or posting time. A failure is recorded and blocks the proposal when the state machine allows it. */
export async function gatedStep(ctx: MutationCtx, proposal: MoneyProposal, stage: "approve" | "post", actor: Actor): Promise<{ proposal: MoneyProposal; lock: LockResult; entryIds: string[] }> {
  const to = stage === "approve" ? "approved" : "posted";
  const loaded = await loadAccount(ctx, proposal.accountId);
  const gateway = await gatewayContext(ctx, loaded, Date.now());
  const lock = evaluate(gateway, proposal, stage, actor.identity, to);
  if (stage === "post" && proposal.approvedBy && proposal.approvedBy === proposal.requestedBy) {
    lock.failures.push({ rule: "L4", code: "SELF_APPROVAL", message: "The approval on record was made by the requester.", sourceIds: [proposal.proposalId] });
  }
  if (stage === "post" && !proposal.approvalId && !lock.failures.some(f => f.rule === "L7")) {
    lock.failures.push({ rule: "L7", code: "STATE", message: "No recorded approval; only approved proposals can post.", sourceIds: [proposal.proposalId] });
  }
  lock.allowed = lock.failures.length === 0;
  await appendMoneyEvent(ctx, { accountId: proposal.accountId, type: "finance.money.lock_checked", actor, operationId: proposal.proposalId, message: lock.allowed ? `All lock rules passed at ${stage}.` : lock.failures.map(f => `${f.rule} ${f.code}: ${f.message}`).join(" | "), proposal, lock, threeWay: gateway.threeWay, stage });
  if (!lock.allowed) {
    // A refusal of who is acting (L4) or of the action itself (L7) is logged above but must not let
    // that actor end someone else's request; only failures about the money block the proposal.
    const refusedActorOrAction = lock.failures.some(f => f.rule === "L4" || f.rule === "L7");
    const next = !refusedActorOrAction && canTransition(proposal.status, "blocked")
      ? await transition(ctx, proposal, "blocked", actor, lock.failures.map(f => f.code).join(", "), lock, gateway.threeWay, { blockedReasons: lock.failures })
      : proposal;
    return { proposal: next, lock, entryIds: [] };
  }
  if (stage === "approve") {
    const count = (await ctx.db.query("financeProposalTransitions").withIndex("by_proposalId", (q) => q.eq("proposalId", proposal.proposalId)).take(100)).length;
    const approvalId = `${proposal.proposalId}:transition:${count + 1}`;
    return { proposal: await transition(ctx, proposal, "approved", actor, null, lock, gateway.threeWay, { approvedBy: actor.identity, approvalId }), lock, entryIds: [] };
  }
  const now = Date.now();
  const entries = buildPostingEntries(proposal, now, actor.identity, proposal.approvalId!);
  for (const entry of entries) {
    const existing = await ctx.db.query("financeLedgerEntries").withIndex("by_entryId", (q) => q.eq("entryId", entry.entryId)).unique();
    if (existing) throw new Error(`Ledger entry ${entry.entryId} already exists; refusing to post twice.`);
    await ctx.db.insert("financeLedgerEntries", compact(entry));
  }
  const entryIds = entries.map(e => e.entryId);
  const after = threeWayCheck({ ...loaded.state, entries: [...loaded.state.entries, ...entries], holds: loaded.state.holds.filter(h => h.proposalId !== proposal.proposalId) }, now);
  await appendMoneyEvent(ctx, { accountId: proposal.accountId, type: "finance.money.ledger_posted", actor, operationId: proposal.proposalId, message: `Posted ${entries.length} ledger entr${entries.length === 1 ? "y" : "ies"}; three-way check is ${after.status}.`, proposal, lock, threeWay: after, entryIds, stage: "post" });
  return { proposal: await transition(ctx, proposal, "posted", actor, null, lock, after, { postedEntryIds: entryIds }), lock, entryIds };
}

export async function nextProposalId(ctx: MutationCtx, accountId: string, kind: "allocation" | "payment") {
  const rows = await ctx.db.query("financeProposals").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(MAX_ROWS + 1);
  return `${accountId}:${kind === "payment" ? "pay" : "alloc"}:${String(rows.length + 1).padStart(4, "0")}`;
}

/** Scoped records for an intake deposit task, plus the account's three-way check at the scope cutoff. */
export async function readIntakeRecords(ctx: QueryCtx | MutationCtx, task: Doc<"financeTasks">, scope: InvestigationScope): Promise<{ records: FinanceRecordSet; threeWay: ThreeWayCheckResult }> {
  if (!task.accountId || !task.bankSourceId) throw new Error("Task is not an intake deposit task");
  const loaded = await loadAccount(ctx, task.accountId);
  if (scope.accountId !== task.accountId || scope.currency !== loaded.state.account.currency) throw new Error(`This task covers ${task.accountId} in ${loaded.state.account.currency} only`);
  if (scope.kind !== "deposit_investigation") throw new Error("Intake deposit tasks support deposit_investigation scope only");
  if (!Number.isSafeInteger(scope.cutoff) || scope.cutoff < 0 || (scope.from !== null && (!Number.isSafeInteger(scope.from) || scope.from < 0 || scope.from > scope.cutoff))) {
    throw new Error("Scope requires integer millisecond dates with from <= cutoff");
  }
  const deposit = loaded.state.bankTransactions.find(t => t.sourceId === task.bankSourceId);
  if (!deposit) throw new Error("The task's deposit is missing from the imported bank feed");
  const records = buildDepositRecordSet({ state: loaded.state, documents: loaded.documents, obligations: loaded.obligations, deposit, caseId: task.caseId, system: loaded.account.system, datasetVersion: loaded.account.datasetVersion, scope });
  return { records, threeWay: threeWayCheck(loaded.state, scope.cutoff) };
}
