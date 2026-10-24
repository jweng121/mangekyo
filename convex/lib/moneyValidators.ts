import { v } from "convex/values";

export const rawPointer = v.object({ system: v.union(v.literal("erp"), v.literal("bank"), v.literal("demo")), recordType: v.string(), rawId: v.string(), datasetVersion: v.string() });
export const issue = v.object({ rawId: v.string(), reason: v.string() });

export const account = v.object({
  accountId: v.string(), sourceId: v.string(), name: v.string(), currency: v.string(), openingAsOf: v.number(), synthetic: v.literal(true), raw: rawPointer,
});
export const storedAccount = account.extend({ system: v.union(v.literal("erp"), v.literal("demo")), datasetVersion: v.string(), importedAt: v.number(), issues: v.array(issue) });

export const bankTransaction = v.object({
  sourceId: v.string(), accountId: v.string(), subAccount: v.string(), direction: v.union(v.literal("inflow"), v.literal("outflow")),
  amountCents: v.number(), currency: v.string(), bookedAt: v.number(), clearing: v.union(v.literal("cleared"), v.literal("pending")),
  reference: v.string(), counterparty: v.string(), ownerHintSourceId: v.union(v.string(), v.null()), documentSourceIds: v.array(v.string()),
  duplicateOfSourceId: v.union(v.string(), v.null()), raw: rawPointer,
});
export const owner = v.object({ sourceId: v.string(), ownerId: v.string(), accountId: v.string(), subAccount: v.string(), name: v.string(), raw: rawPointer });
export const obligation = v.object({
  sourceId: v.string(), accountId: v.string(), kind: v.union(v.literal("invoice"), v.literal("agreement"), v.literal("expected_payment")),
  ownerSourceId: v.union(v.string(), v.null()), amountCents: v.union(v.number(), v.null()), currency: v.union(v.string(), v.null()),
  reference: v.string(), status: v.string(), excerpt: v.string(), raw: rawPointer,
});
export const sourceDocument = v.object({
  sourceId: v.string(), accountId: v.string(), documentType: v.string(), title: v.string(), version: v.string(), text: v.string(), excerpt: v.string(),
  namedOwnerSourceIds: v.array(v.string()), raw: rawPointer,
});
export const statementBalance = v.object({ sourceId: v.string(), accountId: v.string(), amountCents: v.number(), asOf: v.number(), raw: rawPointer });
export const reconcilingItem = v.object({ sourceId: v.string(), accountId: v.string(), appliesTo: v.literal("bank"), amountCents: v.number(), description: v.string(), detailed: v.boolean(), raw: rawPointer });

export const entryKind = v.union(v.literal("deposit_received"), v.literal("allocation"), v.literal("disbursement"), v.literal("reversal"), v.literal("fee"), v.literal("adjustment"));
export const ledgerEntry = v.object({
  entryId: v.string(), accountId: v.string(), ownerId: v.union(v.string(), v.null()), amountCents: v.number(), currency: v.string(), kind: entryKind,
  status: v.literal("posted"), sourceRefs: v.array(v.string()), proposalId: v.optional(v.string()), approvalId: v.optional(v.string()),
  reversesEntryId: v.optional(v.string()), fundsSourceId: v.optional(v.string()), clearedCents: v.optional(v.number()), bankReference: v.optional(v.string()),
  memo: v.string(), effectiveAt: v.number(), createdAt: v.number(), createdBy: v.string(),
});

export const ownerBalance = v.object({
  ownerId: v.union(v.string(), v.null()), name: v.string(), postedCents: v.number(), clearedCents: v.number(), unclearedCents: v.number(), holdsCents: v.number(), availableCents: v.number(),
});
export const causeCode = v.union(...(["BANK_TXN_WITHOUT_LEDGER_ENTRY", "LEDGER_ENTRY_WITHOUT_BANK_TXN", "AMOUNT_MISMATCH", "DUPLICATE_POSTING", "UNCLEARED_DEPOSIT_ALLOCATED", "UNKNOWN_OWNER_ENTRY", "CURRENCY_MISMATCH", "RECONCILING_ITEM_WITHOUT_DETAIL", "NO_OPENING_BALANCE", "OUTSTANDING_ITEM_AGED"] as const).map(code => v.literal(code)));
export const threeWay = v.object({
  accountId: v.string(), currency: v.string(), cutoff: v.number(), status: v.union(v.literal("matched"), v.literal("mismatched"), v.literal("insufficient_data")),
  bank: v.object({ statementCents: v.union(v.number(), v.null()), postAnchorCents: v.number(), reconcilingCents: v.number(), outstandingCents: v.optional(v.number()), adjustedCents: v.union(v.number(), v.null()), clearedCents: v.union(v.number(), v.null()), pendingCents: v.number() }),
  bookCents: v.number(), ownersTotalCents: v.number(), unallocatedCents: v.number(),
  differences: v.object({ bankMinusBook: v.union(v.number(), v.null()), bookMinusOwners: v.number() }),
  causes: v.array(v.object({ code: causeCode, severity: v.union(v.literal("mismatch"), v.literal("warning")), message: v.string(), amountCents: v.union(v.number(), v.null()), sourceIds: v.array(v.string()), ownerIds: v.array(v.string()), unattributed: v.boolean() })),
  outstanding: v.optional(v.array(v.object({ kind: v.union(v.literal("outstanding_payment"), v.literal("deposit_in_transit")), entryId: v.string(), sourceIds: v.array(v.string()), ownerId: v.union(v.string(), v.null()), amountCents: v.number(), bankReference: v.union(v.string(), v.null()), effectiveAt: v.number(), ageDays: v.number() }))),
  outstandingMaxDays: v.optional(v.number()),
});

export const lockRule = v.union(...(["L1", "L2", "L3", "L4", "L5", "L6", "L7"] as const).map(rule => v.literal(rule)));
export const lockFailure = v.object({
  rule: lockRule, code: v.union(...(["OWNER_INSUFFICIENT_FUNDS", "FUNDS_NOT_CLEARED", "MISSING_EVIDENCE", "SELF_APPROVAL", "RECONCILIATION_MISMATCH", "AMOUNT_INTEGRITY", "STATE"] as const).map(code => v.literal(code))),
  message: v.string(), sourceIds: v.array(v.string()),
});
export const lockResult = v.object({
  allowed: v.boolean(), stage: v.union(v.literal("request"), v.literal("approve"), v.literal("post")), failures: v.array(lockFailure), evaluated: v.array(lockRule),
  facts: v.record(v.string(), v.union(v.number(), v.string(), v.null())),
});

export const proposalStatus = v.union(v.literal("proposed"), v.literal("pending_approval"), v.literal("approved"), v.literal("posted"), v.literal("rejected"), v.literal("blocked"), v.literal("on_hold"), v.literal("cancelled"));
export const proposalHold = v.object({ stage: v.union(v.literal("approve"), v.literal("post")), reasonCodes: v.array(v.string()), message: v.string(), since: v.number(), ready: v.boolean(), lastCheckedAt: v.number(), lastCheckedBy: v.string(), lastDecision: v.union(v.literal("placed"), v.literal("recheck"), v.literal("auto_recheck"), v.literal("keep_waiting")) });
export const proposal = v.object({
  proposalId: v.string(), accountId: v.string(), kind: v.union(v.literal("allocation"), v.literal("payment")), status: proposalStatus, currency: v.string(), requestedBy: v.string(),
  origin: v.union(v.object({ type: v.literal("agent"), taskId: v.string(), runId: v.string(), agentProposalIds: v.array(v.string()) }), v.object({ type: v.literal("person") })),
  evidenceSourceIds: v.array(v.string()), bankSourceId: v.optional(v.string()), shares: v.optional(v.array(v.object({ ownerId: v.string(), amountCents: v.number() }))),
  ownerId: v.optional(v.string()), amountCents: v.number(), purpose: v.string(), fundingSourceId: v.optional(v.string()),
  approvedBy: v.optional(v.string()), approvalId: v.optional(v.string()), rejectionReason: v.optional(v.string()), hold: v.optional(proposalHold), cancellationReason: v.optional(v.string()), blockedReasons: v.optional(v.array(lockFailure)),
  postedEntryIds: v.optional(v.array(v.string())), createdAt: v.number(), updatedAt: v.number(),
});
export const transition = v.object({
  transitionId: v.string(), proposalId: v.string(), accountId: v.string(), from: v.union(proposalStatus, v.null()), to: proposalStatus,
  actor: v.string(), reason: v.union(v.string(), v.null()), lock: v.union(lockResult, v.null()), at: v.number(),
});

export const devIdentity = v.object({ role: v.union(v.literal("requester"), v.literal("approver")), name: v.string() });
