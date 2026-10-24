import type {
  AllocationShare, LedgerEntry, LockFailure, LockResult, MoneyProposal, NormalizedDocument, NormalizedObligation, PayoutKind, ProposalStatus, ThreeWayCheckResult,
} from "@mangekyo/contracts";
import { formatCents, isPositiveCents } from "../intake/cents";
import { activeAllocations, affectedOwners, firmOwnerIds, openDisputedCents, ownerBalances, type AccountLedgerState } from "../ledger";

export type LockStage = LockResult["stage"];

export const TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  proposed: ["pending_approval", "blocked"],
  pending_approval: ["approved", "rejected", "blocked", "on_hold"],
  approved: ["posted", "blocked", "on_hold"],
  on_hold: ["approved", "posted", "blocked", "cancelled"],
  posted: [],
  rejected: [],
  blocked: [],
  cancelled: [],
};

/** L10 joins L2 and L5: disputed money is held, not blocked, until a person records the resolution. */
const TEMPORARY = new Set<LockFailure["rule"]>(["L2", "L5", "L10"]);

/**
 * refused: who is acting (L4) or the action itself (L7) is wrong; nothing about the proposal changes.
 * temporary: only L2/L5/L10, which can resolve as deposits clear, the books reconcile or a dispute is resolved; hold for a person.
 * permanent: anything else (L1, L3, L6, L8, L9, L11), which waiting cannot fix.
 */
export function classifyFailures(failures: LockFailure[]): "pass" | "refused" | "temporary" | "permanent" {
  if (failures.length === 0) return "pass";
  if (failures.some(f => f.rule === "L4" || f.rule === "L7")) return "refused";
  return failures.every(f => TEMPORARY.has(f.rule)) ? "temporary" : "permanent";
}

/** Plain-English hold reason for the "Needs a person" list. */
export function holdReason(failures: LockFailure[], state: AccountLedgerState, threeWay: ThreeWayCheckResult): string {
  const parts: string[] = [];
  const money = (cents: number) => formatCents(cents, state.account.currency);
  for (const failure of failures) {
    if (failure.rule === "L2") {
      const pending = [...new Set(failure.sourceIds)].map(id => state.bankTransactions.find(t => t.sourceId === id)).filter(t => t && t.clearing !== "cleared");
      parts.push(...(pending.length ? pending.map(t => `${money(t!.amountCents)} from ${t!.counterparty} hasn't cleared yet`) : ["the owner doesn't have enough cleared money yet"]));
    } else if (failure.rule === "L5") {
      const cause = threeWay.causes.find(c => c.severity === "mismatch" && c.sourceIds.some(id => failure.sourceIds.includes(id)));
      parts.push(`the bank and the books don't agree yet${cause ? ` (${cause.message.replace(/\.$/, "")})` : ""}`);
    } else if (failure.rule === "L10") {
      parts.push(`${failure.message.replace(/\.$/, "")}; it stays in trust until a person records how the dispute was resolved`);
    } else {
      parts.push(failure.message.replace(/\.$/, ""));
    }
  }
  return `On hold: ${[...new Set(parts)].join("; ")}.`;
}

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
  /** Source documents and obligations of the account, for the trust rules (L9 signed statements and invoices, L11 settlement lines). */
  documents?: NormalizedDocument[];
  obligations?: NormalizedObligation[];
}

export interface PaymentRequest {
  proposalId: string;
  ownerId: string;
  amountCents: number;
  currency: string;
  evidenceSourceIds: string[];
  fundingSourceId?: string;
  requestedBy: string;
  /** Trust rules: what the payout is for; absent means "other". */
  payoutKind?: PayoutKind;
  matterId?: string;
  settlementSourceId?: string;
  payeeOwnerId?: string;
}

const SETTLEMENT_KINDS = new Set<PayoutKind>(["client_share", "attorney_fee", "costs", "lien"]);

/** Documents about one client (and matter, when both sides name one). A document with no matter applies to every matter of the client. */
function documentsFor(ctx: GatewayContext, ownerSourceId: string, matterId: string | undefined): NormalizedDocument[] {
  return (ctx.documents ?? []).filter(d => d.namedOwnerSourceIds.includes(ownerSourceId) || (matterId !== undefined && d.matterId === matterId))
    .filter(d => matterId === undefined || d.matterId === undefined || d.matterId === matterId);
}

const isSettlementStatement = (d: NormalizedDocument) => d.signed === true && Array.isArray(d.lines) && d.lines.length > 0;
const isFeeAgreement = (d: NormalizedDocument) => d.signed === true && Number.isSafeInteger(d.feeBasisPoints) && (d.feeBasisPoints ?? 0) > 0;
const lineTotal = (d: NormalizedDocument) => (d.lines ?? []).reduce((total, line) => total + line.amountCents, 0);

/** Contingency fee in integer cents: floor(total × basis points / 10 000). Never a float. */
export function contingencyFeeCents(totalCents: number, feeBasisPoints: number): number {
  return Math.floor((totalCents * feeBasisPoints) / 10_000);
}

/**
 * Trust rules for one payment. Each returns its failures (empty when it passes); the caller records which rules ran.
 * L8 commingling · L9 fee not earned · L10 disputed funds (temporary) · L11 settlement mismatch.
 */
export function evaluateTrustRules(ctx: GatewayContext, request: PaymentRequest, balance: { postedCents: number; holdsCents: number; availableCents: number } | null): Record<"L8" | "L9" | "L10" | "L11", LockFailure[]> {
  const { state } = ctx;
  const money = (cents: number) => formatCents(cents, state.account.currency);
  const owner = state.owners.find(row => row.ownerId === request.ownerId);
  const kind: PayoutKind = request.payoutKind ?? "other";
  const firm = firmOwnerIds(state);
  const out: Record<"L8" | "L9" | "L10" | "L11", LockFailure[]> = { L8: [], L9: [], L10: [], L11: [] };
  if (!owner) return out;

  // L8 COMMINGLING: firm money never funds a client payment.
  if (firm.has(owner.ownerId) && (kind === "client_share" || kind === "lien" || kind === "refund")) {
    out.L8.push({ rule: "L8", code: "COMMINGLING", message: `${owner.name} is the firm's own money in trust; it cannot fund a client payment (${kind.replace(/_/g, " ")}). Move the firm's money out of trust instead.`, sourceIds: [owner.sourceId] });
  }
  if (request.fundingSourceId && !firm.has(owner.ownerId)) {
    const firmFunded = activeAllocations(state.entries, request.fundingSourceId).filter(e => firm.has(e.ownerId!));
    if (firmFunded.length) out.L8.push({ rule: "L8", code: "COMMINGLING", message: `Deposit ${request.fundingSourceId} is allocated to the firm's own money (${money(firmFunded.reduce((t, e) => t + e.amountCents, 0))}); firm money cannot fund ${owner.name}'s payment.`, sourceIds: [request.fundingSourceId, ...firmFunded.map(e => e.entryId)] });
  }

  const docs = documentsFor(ctx, owner.sourceId, request.matterId);
  const statements = docs.filter(isSettlementStatement).filter(d => !request.settlementSourceId || d.sourceId === request.settlementSourceId);
  const agreements = docs.filter(isFeeAgreement);

  // L9 FEE_NOT_EARNED: a trust-to-firm fee needs an approved invoice, or a signed settlement fee line that matches the signed fee agreement.
  if (kind === "attorney_fee") {
    const invoices = (ctx.obligations ?? []).filter(o => o.kind === "invoice" && o.status === "approved" && o.ownerSourceId === owner.sourceId && (request.matterId === undefined || o.matterId === undefined || o.matterId === request.matterId));
    const invoiceCents = invoices.reduce((total, o) => total + (o.amountCents ?? 0), 0);
    const byInvoice = invoices.length > 0 && request.amountCents <= invoiceCents;
    const feeLines = statements.flatMap(s => (s.lines ?? []).filter(l => l.kind === "attorney_fee" && l.amountCents === request.amountCents).map(l => ({ statement: s, line: l })));
    const byContingency = feeLines.find(({ statement, line }) => agreements.some(a => contingencyFeeCents(lineTotal(statement), a.feeBasisPoints!) === line.amountCents));
    if (!byInvoice && !byContingency) {
      const why = invoices.length ? `approved invoices for ${owner.name} total ${money(invoiceCents)}, less than the ${money(request.amountCents)} requested`
        : feeLines.length && agreements.length === 0 ? "the signed settlement statement has a fee line but there is no signed fee agreement to check it against"
        : feeLines.length ? `the ${money(request.amountCents)} fee line does not equal the signed fee agreement's percentage of the settlement`
        : statements.length ? `the signed settlement statement has no ${money(request.amountCents)} attorney-fee line`
        : `there is no approved invoice for ${owner.name}${request.matterId ? ` on matter ${request.matterId}` : ""} and no signed settlement statement with a matching fee line`;
      out.L9.push({ rule: "L9", code: "FEE_NOT_EARNED", message: `Fee of ${money(request.amountCents)} is not shown as earned: ${why}. A fee leaves trust only once it is earned and documented.`, sourceIds: [owner.sourceId, ...invoices.map(o => o.sourceId), ...statements.map(s => s.sourceId), ...agreements.map(a => a.sourceId)] });
    }
    if (balance && request.amountCents > balance.postedCents) {
      out.L9.push({ rule: "L9", code: "FEE_NOT_EARNED", message: `A fee can never exceed the client's balance: ${owner.name} has ${money(balance.postedCents)} posted; requested ${money(request.amountCents)}.`, sourceIds: [owner.sourceId] });
    }
  }

  // L10 DISPUTED_FUNDS: disputed money stays in trust until a person records the resolution. Held, not blocked.
  const disputed = openDisputedCents(state, owner.ownerId, ctx.cutoff);
  if (balance && disputed.cents > 0 && request.amountCents > Math.max(0, balance.availableCents - disputed.cents)) {
    out.L10.push({ rule: "L10", code: "DISPUTED_FUNDS", message: `${money(disputed.cents)} of ${owner.name}'s balance is disputed (${disputed.disputes.map(d => d.reason).join("; ")}). Only ${money(Math.max(0, balance.availableCents - disputed.cents))} can leave trust until a person records the resolution; requested ${money(request.amountCents)}.`, sourceIds: disputed.disputes.map(d => d.disputeId) });
  }

  // L11 SETTLEMENT_MISMATCH: a settlement payout must match the signed settlement statement exactly.
  if (SETTLEMENT_KINDS.has(kind) && (statements.length > 0 || request.settlementSourceId)) {
    if (statements.length === 0) {
      out.L11.push({ rule: "L11", code: "SETTLEMENT_MISMATCH", message: `Settlement statement ${request.settlementSourceId} is not a signed statement for ${owner.name} in our records.`, sourceIds: request.settlementSourceId ? [request.settlementSourceId] : [] });
    } else {
      const matching = statements.filter(s => (s.lines ?? []).some(l => l.kind === kind && l.amountCents === request.amountCents && (l.payeeOwnerSourceId === null || request.payeeOwnerId === undefined || state.owners.find(o => o.sourceId === l.payeeOwnerSourceId)?.ownerId === request.payeeOwnerId)));
      if (matching.length === 0) {
        const lines = statements.flatMap(s => (s.lines ?? []).map(l => `${l.label} ${money(l.amountCents)}`)).join(", ");
        out.L11.push({ rule: "L11", code: "SETTLEMENT_MISMATCH", message: `${kind.replace(/_/g, " ")} of ${money(request.amountCents)} does not match any line of the signed settlement statement (${lines}). Settlement payouts must match it exactly.`, sourceIds: statements.map(s => s.sourceId) });
      }
      for (const s of statements) {
        const deposit = state.bankTransactions.find(t => t.documentSourceIds.includes(s.sourceId) && t.direction === "inflow");
        if (deposit && lineTotal(s) !== deposit.amountCents) out.L11.push({ rule: "L11", code: "SETTLEMENT_MISMATCH", message: `The signed settlement statement's lines total ${money(lineTotal(s))} but the settlement deposit is ${money(deposit.amountCents)}; the statement does not add up.`, sourceIds: [s.sourceId, deposit.sourceId] });
      }
    }
  }
  return out;
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
  const touchesSource = (c: ThreeWayCheckResult["causes"][number]) => !!request.fundingSourceId && c.sourceIds.includes(request.fundingSourceId);
  if (threeWay.status !== "matched" && (affected === "all" || affected.has(request.ownerId) || threeWay.causes.some(c => c.severity === "mismatch" && touchesSource(c)))) {
    const relevant = threeWay.causes.filter(c => c.severity === "mismatch" && (affected === "all" || c.ownerIds.includes(request.ownerId) || touchesSource(c)));
    failures.push({ rule: "L5", code: "RECONCILIATION_MISMATCH", message: `Three-way check is ${threeWay.status}${affected === "all" ? " with causes not attributable to one owner" : ` for this owner or its funding source`}: ${relevant.map(c => c.code).join(", ") || "no opening balance"}. Outgoing payments are blocked until it is fixed.`, sourceIds: [...new Set(relevant.flatMap(c => c.sourceIds))] });
  }
  // Trust rules, evaluated at every stage like the others.
  const trust = evaluateTrustRules(ctx, request, balance ?? null);
  for (const rule of ["L8", "L9", "L10", "L11"] as const) { evaluated.push(rule); failures.push(...trust[rule]); }
  facts.payoutKind = request.payoutKind ?? "other";
  facts.disputedCents = balance ? openDisputedCents(state, request.ownerId, ctx.cutoff).cents : null;
  return result(args.stage, evaluated, failures, facts);
}

function allocatedElsewhere(entries: LedgerEntry[], bankSourceId: string): number {
  return activeAllocations(entries, bankSourceId).reduce((total, row) => total + row.amountCents, 0);
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
