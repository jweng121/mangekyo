import type {
  AllocationShare, LedgerEntry, LockFailure, LockResult, MoneyProposal, ProposalStatus, ThreeWayCheckResult,
} from "@mangekyo/contracts";
import { formatCents, isPositiveCents } from "../intake/cents";
import { affectedOwners, ownerBalances, type AccountLedgerState } from "../ledger";

export type LockStage = LockResult["stage"];

export const TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  proposed: ["pending_approval", "blocked"],
  pending_approval: ["approved", "rejected", "blocked"],
  approved: ["posted", "blocked"],
  posted: [],
  rejected: [],
  blocked: [],
};

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** L7: only listed transitions; posted, rejected and blocked are terminal. */
export function checkState(from: ProposalStatus, to: ProposalStatus, proposalId: string): LockFailure | null {
  return canTransition(from, to) ? null : { rule: "L7", code: "STATE", message: `Proposal ${proposalId} cannot move from ${from} to ${to}.`, sourceIds: [proposalId] };
}

/** L4: the requester never approves or posts their own request. */
export function checkSelfApproval(requestedBy: string, actor: string, proposalId: string): LockFailure | null {
  return requestedBy.trim().toLowerCase() === actor.trim().toLowerCase()
    ? { rule: "L4", code: "SELF_APPROVAL", message: `${actor} requested ${proposalId} and cannot also approve or post it.`, sourceIds: [proposalId] } : null;
}

/** L3: at least one cited sourceId, and every cited sourceId exists in our records. */
export function checkEvidence(evidenceSourceIds: string[], known: ReadonlySet<string>): LockFailure | null {
  const unknown = evidenceSourceIds.filter(id => !known.has(id));
  if (evidenceSourceIds.length === 0) return { rule: "L3", code: "MISSING_EVIDENCE", message: "At least one supporting sourceId from our records is required.", sourceIds: [] };
  if (unknown.length) return { rule: "L3", code: "MISSING_EVIDENCE", message: `Cited evidence is not in our records: ${unknown.join(", ")}.`, sourceIds: unknown };
  return null;
}

export interface GatewayContext {
  state: AccountLedgerState;
  threeWay: ThreeWayCheckResult;
  knownSourceIds: ReadonlySet<string>;
  /** Other proposals on the account, for duplicate-allocation checks. */
  proposals: Pick<MoneyProposal, "proposalId" | "kind" | "status" | "bankSourceId">[];
  cutoff: number;
}

export interface PaymentRequest {
  proposalId: string;
  ownerId: string;
  amountCents: number;
  currency: string;
  evidenceSourceIds: string[];
  fundingSourceId?: string;
  requestedBy: string;
}

export interface AllocationRequest {
  proposalId: string;
  bankSourceId: string;
  shares: AllocationShare[];
  currency: string;
  evidenceSourceIds: string[];
  requestedBy: string;
}

interface StageArgs { stage: LockStage; actor: string; transition?: { from: ProposalStatus; to: ProposalStatus } }

function result(stage: LockStage, evaluated: LockFailure["rule"][], failures: Array<LockFailure | null>, facts: LockResult["facts"]): LockResult {
  const list = failures.filter((row): row is LockFailure => row !== null);
  return { allowed: list.length === 0, stage, failures: list, evaluated, facts };
}

function common(args: StageArgs, proposalId: string, requestedBy: string) {
  const failures: Array<LockFailure | null> = [];
  const evaluated: LockFailure["rule"][] = [];
  if (args.transition) { evaluated.push("L7"); failures.push(checkState(args.transition.from, args.transition.to, proposalId)); }
  if (args.stage !== "request") { evaluated.push("L4"); failures.push(checkSelfApproval(requestedBy, args.actor, proposalId)); }
  return { failures, evaluated };
}

/** Every rule for an owner disbursement. Pool cash never substitutes for the owner's own available balance. */
export function evaluatePayment(ctx: GatewayContext, request: PaymentRequest, args: StageArgs): LockResult {
  const { failures, evaluated } = common(args, request.proposalId, request.requestedBy);
  const { state, threeWay } = ctx;
  const owner = state.owners.find(row => row.ownerId === request.ownerId);
  evaluated.push("L6");
  if (!isPositiveCents(request.amountCents)) failures.push({ rule: "L6", code: "AMOUNT_INTEGRITY", message: "Payment amount must be positive integer cents.", sourceIds: [] });
  if (request.currency !== state.account.currency) failures.push({ rule: "L6", code: "AMOUNT_INTEGRITY", message: `Payment currency ${request.currency} does not match account currency ${state.account.currency}.`, sourceIds: [] });
  evaluated.push("L3");
  failures.push(checkEvidence(request.evidenceSourceIds, ctx.knownSourceIds));
  if (!owner) failures.push({ rule: "L3", code: "MISSING_EVIDENCE", message: `Owner ${request.ownerId} is not in our records for this account.`, sourceIds: [request.ownerId] });

  const balance = ownerBalances(state, ctx.cutoff, request.proposalId).find(row => row.ownerId === request.ownerId);
  const facts: LockResult["facts"] = {
    requestedCents: request.amountCents, poolBankCents: threeWay.bank.adjustedCents, poolClearedCents: threeWay.bank.clearedCents,
    poolBookCents: threeWay.bookCents, ownerPostedCents: balance?.postedCents ?? null, ownerClearedCents: balance?.clearedCents ?? null,
    ownerHoldsCents: balance?.holdsCents ?? null, ownerAvailableCents: balance?.availableCents ?? null, threeWayStatus: threeWay.status,
  };
  evaluated.push("L2", "L1");
  if (balance && isPositiveCents(request.amountCents)) {
    const funding = request.fundingSourceId ? state.bankTransactions.find(row => row.sourceId === request.fundingSourceId) : undefined;
    const pool = threeWay.bank.clearedCents === null ? "unknown" : formatCents(threeWay.bank.clearedCents, state.account.currency);
    const money = (cents: number) => formatCents(cents, state.account.currency);
    if (request.fundingSourceId && (!funding || funding.clearing !== "cleared" || funding.bookedAt > ctx.cutoff)) {
      failures.push({ rule: "L2", code: "FUNDS_NOT_CLEARED", message: `Funding deposit ${request.fundingSourceId} has not cleared; its money cannot be spent yet.`, sourceIds: [request.fundingSourceId] });
    }
    const spendable = balance.postedCents - balance.holdsCents;
    if (request.amountCents > balance.availableCents && request.amountCents <= spendable) {
      const pendingSources = state.entries.filter(e => e.ownerId === request.ownerId && e.fundsSourceId && state.bankTransactions.find(t => t.sourceId === e.fundsSourceId)?.clearing === "pending").map(e => e.fundsSourceId!);
      failures.push({ rule: "L2", code: "FUNDS_NOT_CLEARED", message: `${owner!.name} has ${money(balance.postedCents)} posted but only ${money(balance.availableCents)} available; ${money(balance.unclearedCents)} has not cleared. Requested ${money(request.amountCents)}.`, sourceIds: [...new Set(pendingSources)] });
    }
    if (request.amountCents > spendable) {
      failures.push({ rule: "L1", code: "OWNER_INSUFFICIENT_FUNDS", message: `${owner!.name} has ${money(balance.availableCents)} available (posted ${money(balance.postedCents)}, holds ${money(balance.holdsCents)}). Requested ${money(request.amountCents)}. The pooled account holds ${pool} cleared, but other owners' money cannot fund this payment.`, sourceIds: [owner!.sourceId] });
    }
  }
  evaluated.push("L5");
  const affected = affectedOwners(threeWay);
  if (threeWay.status !== "matched" && (affected === "all" || affected.has(request.ownerId))) {
    const relevant = threeWay.causes.filter(c => c.severity === "mismatch" && (affected === "all" || c.ownerIds.includes(request.ownerId)));
    failures.push({ rule: "L5", code: "RECONCILIATION_MISMATCH", message: `Three-way check is ${threeWay.status}${affected === "all" ? " with causes not attributable to one owner" : ` for this owner`}: ${relevant.map(c => c.code).join(", ") || "no opening balance"}. Outgoing payments are blocked until it is fixed.`, sourceIds: [...new Set(relevant.flatMap(c => c.sourceIds))] });
  }
  return result(args.stage, evaluated, failures, facts);
}

function allocatedElsewhere(entries: LedgerEntry[], bankSourceId: string): number {
  const reversed = new Set(entries.flatMap(row => row.reversesEntryId ? [row.reversesEntryId] : []));
  return entries.filter(row => row.kind === "allocation" && row.ownerId !== null && row.fundsSourceId === bankSourceId && !reversed.has(row.entryId))
    .reduce((total, row) => total + row.amountCents, 0);
}

/** Every rule for dividing one deposit among owners. Allocations move money between buckets, not out of the pool. */
export function evaluateAllocation(ctx: GatewayContext, request: AllocationRequest, args: StageArgs): LockResult {
  const { failures, evaluated } = common(args, request.proposalId, request.requestedBy);
  const { state } = ctx;
  const deposit = state.bankTransactions.find(row => row.sourceId === request.bankSourceId);
  const fail = (message: string, sourceIds: string[] = [request.bankSourceId]) => failures.push({ rule: "L6", code: "AMOUNT_INTEGRITY", message, sourceIds });
  evaluated.push("L6");
  if (!deposit || deposit.direction !== "inflow") fail(`Deposit ${request.bankSourceId} is not an inflow in our bank records.`);
  if (request.currency !== state.account.currency || (deposit && deposit.currency !== request.currency)) fail(`Allocation currency ${request.currency} must match the deposit and account.`);
  if (request.shares.length === 0) fail("An allocation needs at least one owner share.");
  const owners = new Set<string>();
  let total = 0;
  for (const share of request.shares) {
    if (!isPositiveCents(share.amountCents)) fail(`Share for ${share.ownerId} must be positive integer cents.`);
    if (!state.owners.some(row => row.ownerId === share.ownerId)) fail(`Owner ${share.ownerId} is not in our records for this account.`, [share.ownerId]);
    if (owners.has(share.ownerId)) fail(`Owner ${share.ownerId} appears twice; combine the shares.`, [share.ownerId]);
    owners.add(share.ownerId);
    total += isPositiveCents(share.amountCents) ? share.amountCents : 0;
  }
  if (deposit && Number.isSafeInteger(total) && total !== deposit.amountCents) fail(`Shares total ${formatCents(total)} but the deposit is ${formatCents(deposit.amountCents)}; they must match exactly.`);
  if (deposit && !state.entries.some(row => row.kind === "deposit_received" && row.ownerId === null && row.fundsSourceId === deposit.sourceId)) fail(`Deposit ${deposit.sourceId} has not been recorded in the ledger as received.`);
  const already = allocatedElsewhere(state.entries, request.bankSourceId);
  if (already > 0) fail(`Deposit ${request.bankSourceId} already has ${formatCents(already)} allocated in the ledger.`);
  const competing = ctx.proposals.filter(p => p.kind === "allocation" && p.bankSourceId === request.bankSourceId && p.proposalId !== request.proposalId && (p.status === "pending_approval" || p.status === "approved"));
  if (competing.length) fail(`Deposit ${request.bankSourceId} already has an open allocation proposal: ${competing.map(p => p.proposalId).join(", ")}.`, [request.bankSourceId, ...competing.map(p => p.proposalId)]);
  evaluated.push("L3");
  failures.push(checkEvidence(request.evidenceSourceIds, ctx.knownSourceIds));
  return result(args.stage, evaluated, failures, { depositCents: deposit?.amountCents ?? null, sharesTotalCents: total, alreadyAllocatedCents: already, depositClearing: deposit?.clearing ?? null });
}

/** Deterministic posting entries; entry IDs derive from the proposal so a retry cannot double-post. */
export function buildPostingEntries(proposal: MoneyProposal, now: number, actor: string, approvalId: string): LedgerEntry[] {
  const base = { accountId: proposal.accountId, currency: proposal.currency, status: "posted" as const, proposalId: proposal.proposalId, approvalId, effectiveAt: now, createdAt: now, createdBy: actor };
  if (proposal.kind === "payment") {
    return [{ ...base, entryId: `${proposal.proposalId}:entry:1`, ownerId: proposal.ownerId!, amountCents: -proposal.amountCents, kind: "disbursement", sourceRefs: proposal.evidenceSourceIds, bankReference: `PAY:${proposal.proposalId}`, memo: proposal.purpose }];
  }
  return proposal.shares!.flatMap((share, index) => [
    { ...base, entryId: `${proposal.proposalId}:entry:${index * 2 + 1}`, ownerId: null, amountCents: -share.amountCents, kind: "allocation" as const, sourceRefs: [proposal.bankSourceId!, ...proposal.evidenceSourceIds], fundsSourceId: proposal.bankSourceId!, memo: `Allocate to ${share.ownerId}` },
    { ...base, entryId: `${proposal.proposalId}:entry:${index * 2 + 2}`, ownerId: share.ownerId, amountCents: share.amountCents, kind: "allocation" as const, sourceRefs: [proposal.bankSourceId!, ...proposal.evidenceSourceIds], fundsSourceId: proposal.bankSourceId!, memo: proposal.purpose },
  ]);
}
