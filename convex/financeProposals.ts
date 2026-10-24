import { ConvexError, v } from "convex/values";
import type { MoneyProposal } from "@mangekyo/contracts";
import { checkSelfApproval, checkState } from "@mangekyo/finance-core/gateway";
import { buildReversalEntries, threeWayCheck } from "@mangekyo/finance-core/ledger";
import { mutation, query } from "./_generated/server";
import * as money from "./lib/moneyValidators";
import { appendMoneyEvent, compact, gatedStep, getProposal, loadAccount, nextProposalId, requireAccount, resolveActor, submitProposal, transition } from "./lib/money";
import { recordOnly } from "./lib/investigationRecords";
import { appendBoundary } from "./financeInvestigations";

const outcome = v.object({ proposal: money.proposal, lock: v.union(money.lockResult, v.null()), alreadyDone: v.boolean() });

function purposeText(value: string) {
  const text = value.trim();
  if (!text || text.length > 500) throw new ConvexError("Purpose must contain 1–500 characters.");
  return text;
}

/** A staff requester asks to pay an owner's money out. The lock decides immediately and the result is saved either way. */
export const requestPayment = mutation({
  args: { accountId: v.string(), ownerId: v.string(), amountCents: v.number(), purpose: v.string(), evidenceSourceIds: v.array(v.string()), fundingSourceId: v.optional(v.string()), dev: money.devIdentity },
  returns: outcome,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (actor.role !== "requester") throw new ConvexError("Switch to the requester role to request a payment.");
    const account = await requireAccount(ctx, args.accountId);
    const now = Date.now();
    const draft: MoneyProposal = {
      proposalId: await nextProposalId(ctx, args.accountId, "payment"), accountId: args.accountId, kind: "payment", status: "proposed", currency: account.currency,
      requestedBy: actor.identity, origin: { type: "person" }, evidenceSourceIds: args.evidenceSourceIds.slice(0, 20), ownerId: args.ownerId,
      amountCents: args.amountCents, purpose: purposeText(args.purpose), ...(args.fundingSourceId ? { fundingSourceId: args.fundingSourceId } : {}), createdAt: now, updatedAt: now,
    };
    return { ...(await submitProposal(ctx, draft, actor)), alreadyDone: false };
  },
});

/** A person proposes how a deposit divides among owners. Never posts by itself. */
export const proposeAllocation = mutation({
  args: { accountId: v.string(), bankSourceId: v.string(), shares: v.array(v.object({ ownerId: v.string(), amountCents: v.number() })), evidenceSourceIds: v.array(v.string()), purpose: v.string(), dev: money.devIdentity },
  returns: outcome,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    const account = await requireAccount(ctx, args.accountId);
    const now = Date.now();
    const draft: MoneyProposal = {
      proposalId: await nextProposalId(ctx, args.accountId, "allocation"), accountId: args.accountId, kind: "allocation", status: "proposed", currency: account.currency,
      requestedBy: actor.identity, origin: { type: "person" }, evidenceSourceIds: args.evidenceSourceIds.slice(0, 20), bankSourceId: args.bankSourceId,
      shares: args.shares.slice(0, 20), amountCents: args.shares.reduce((sum, s) => sum + (Number.isSafeInteger(s.amountCents) ? s.amountCents : 0), 0), purpose: purposeText(args.purpose), createdAt: now, updatedAt: now,
    };
    return { ...(await submitProposal(ctx, draft, actor)), alreadyDone: false };
  },
});

export const approveProposal = mutation({
  args: { proposalId: v.string(), dev: money.devIdentity }, returns: outcome,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (actor.role !== "approver") throw new ConvexError("Switch to the approver role to approve.");
    const { proposal, lock } = await gatedStep(ctx, await getProposal(ctx, args.proposalId), "approve", actor);
    return { proposal, lock, alreadyDone: false };
  },
});

/** Re-runs all lock rules, writes ledger entries and marks posted in one transaction. A second call changes nothing. */
export const postProposal = mutation({
  args: { proposalId: v.string(), dev: money.devIdentity }, returns: outcome,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (actor.role !== "approver") throw new ConvexError("Switch to the approver role to post.");
    const current = await getProposal(ctx, args.proposalId);
    if (current.status === "posted") return { proposal: current, lock: null, alreadyDone: true };
    const { proposal, lock } = await gatedStep(ctx, current, "post", actor);
    return { proposal, lock, alreadyDone: false };
  },
});

/** Rejection needs a reason. For agent proposals the reason becomes a task clarification the next attempt receives. */
export const rejectProposal = mutation({
  args: { proposalId: v.string(), reason: v.string(), dev: money.devIdentity }, returns: outcome,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (actor.role !== "approver") throw new ConvexError("Switch to the approver role to reject.");
    const reason = args.reason.trim();
    if (!reason || reason.length > 4000) throw new ConvexError("A rejection reason (1–4000 characters) is required.");
    const proposal = await getProposal(ctx, args.proposalId);
    const loaded = await loadAccount(ctx, proposal.accountId);
    const threeWay = threeWayCheck(loaded.state, Date.now());
    const failure = checkState(proposal.status, "rejected", proposal.proposalId);
    if (failure) {
      const lock = { allowed: false, stage: "approve" as const, failures: [failure], evaluated: ["L7" as const], facts: {} };
      await appendMoneyEvent(ctx, { accountId: proposal.accountId, type: "finance.money.lock_checked", actor, operationId: proposal.proposalId, message: `${failure.rule} ${failure.code}: ${failure.message}`, proposal, lock, threeWay, stage: "reject" });
      return { proposal, lock, alreadyDone: false };
    }
    const rejected = await transition(ctx, proposal, "rejected", actor, reason, null, threeWay, { rejectionReason: reason });
    if (proposal.origin.type === "agent") {
      const run = await ctx.db.query("financeInvestigationRuns").withIndex("by_runId", (q) => q.eq("runId", (proposal.origin as { runId: string }).runId)).unique();
      if (run) {
        const clarificationId = `${proposal.proposalId}:rejection`;
        const respondent = { identity: actor.identity, authenticated: actor.authenticated };
        await ctx.db.insert("financeClarifications", {
          clarificationId, sourceId: `clarification:${clarificationId}`, questionId: clarificationId,
          question: `A reviewer rejected proposed allocation ${proposal.proposalId} (${proposal.shares?.map(s => `${s.amountCents} cents to ${s.ownerId}`).join(", ")}). Why, and what should be investigated instead?`,
          answer: reason, caseId: run.caseId, taskId: run.taskId, runId: run.runId, timestamp: Date.now(), respondent, evidenceRefs: [],
        });
        const { executionClaimed, pollCount, deadline, _id, _creationTime, ...publicRun } = run;
        await appendBoundary(ctx, publicRun, "finance.clarification.saved", "Reviewer rejection saved as task clarification for the next investigation attempt; no allocation was posted.", { clarificationId }, { type: "human", component: "finance-dev", ...respondent });
      }
    }
    return { proposal: rejected, lock: null, alreadyDone: false };
  },
});

/** Correction without deletion: appends negating entries linked by reversesEntryId. The proposal stays posted. */
export const reversePosting = mutation({
  args: { proposalId: v.string(), reason: v.string(), dev: money.devIdentity },
  returns: v.object({ entryIds: v.array(v.string()), alreadyDone: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.dev);
    if (actor.role !== "approver") throw new ConvexError("Switch to the approver role to reverse a posting.");
    const reason = args.reason.trim();
    if (!reason || reason.length > 4000) throw new ConvexError("A reversal reason (1–4000 characters) is required.");
    const proposal = await getProposal(ctx, args.proposalId);
    if (proposal.status !== "posted" || !proposal.postedEntryIds?.length) throw new ConvexError("Only posted proposals can be reversed.");
    const self = checkSelfApproval(proposal.requestedBy, actor.identity, proposal.proposalId);
    if (self) throw new ConvexError(self.message);
    const originals = [];
    for (const entryId of proposal.postedEntryIds) {
      const row = await ctx.db.query("financeLedgerEntries").withIndex("by_entryId", (q) => q.eq("entryId", entryId)).unique();
      if (!row) throw new Error(`Posted entry ${entryId} is missing`);
      originals.push(recordOnly(row));
    }
    const reversals = buildReversalEntries(originals, reason, actor.identity, Date.now(), proposal.approvalId);
    const existing = await ctx.db.query("financeLedgerEntries").withIndex("by_entryId", (q) => q.eq("entryId", reversals[0].entryId)).unique();
    if (existing) return { entryIds: reversals.map(r => r.entryId), alreadyDone: true };
    for (const entry of reversals) await ctx.db.insert("financeLedgerEntries", compact(entry));
    const loaded = await loadAccount(ctx, proposal.accountId);
    await appendMoneyEvent(ctx, { accountId: proposal.accountId, type: "finance.money.ledger_posted", actor, operationId: proposal.proposalId, stage: "reversal",
      message: `Reversed ${reversals.length} entr${reversals.length === 1 ? "y" : "ies"} of ${proposal.proposalId}: ${reason}`, proposal, threeWay: threeWayCheck(loaded.state, Date.now()), entryIds: reversals.map(r => r.entryId) });
    return { entryIds: reversals.map(r => r.entryId), alreadyDone: false };
  },
});

export const listTransitions = query({
  args: { proposalId: v.string() }, returns: v.array(money.transition),
  handler: async (ctx, { proposalId }) => (await ctx.db.query("financeProposalTransitions").withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId)).take(100)).map(recordOnly),
});
