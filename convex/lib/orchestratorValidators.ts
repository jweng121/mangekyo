import { v } from "convex/values";
import { ORCHESTRATOR_STATES } from "@mangekyo/finance-core/orchestrator";
import * as money from "./moneyValidators";
import { investigationError } from "./validators";

export const state = v.union(...ORCHESTRATOR_STATES.map(s => v.literal(s)));
export const kind = v.union(v.literal("deposit"), v.literal("reconciliation"));
export const actor = v.object({ type: v.union(v.literal("system"), v.literal("agent"), v.literal("code"), v.literal("person")), identity: v.string() });
export const reason = v.object({ code: v.string(), message: v.string() });
export const budget = v.object({
  allowed: v.boolean(), code: v.string(), message: v.string(), needed: v.number(), usedToday: v.number(), usedForDeposit: v.number(),
  limits: v.object({ perDay: v.number(), perDeposit: v.number() }),
});

/** One per deposit task (kind deposit) or per code-found mismatch (kind reconciliation). */
export const orchestration = v.object({
  orchestrationId: v.string(), kind, taskId: v.string(), accountId: v.union(v.string(), v.null()), subjectSourceId: v.union(v.string(), v.null()),
  state, activeRunId: v.union(v.string(), v.null()), lastRunId: v.union(v.string(), v.null()), sequence: v.number(), retries: v.number(),
  reason: v.union(reason, v.null()), createdAt: v.number(), updatedAt: v.number(),
});

/** Append-only. Every state change, retry and budget check, with who or what caused it. */
export const event = v.object({
  eventId: v.string(), orchestrationId: v.string(), taskId: v.string(), accountId: v.union(v.string(), v.null()), runId: v.union(v.string(), v.null()), sequence: v.number(),
  kind: v.union(v.literal("transition"), v.literal("retry"), v.literal("budget_check")), from: v.union(state, v.null()), to: state,
  trigger: v.string(), actor, reason, timestamp: v.number(), budget: v.optional(budget), error: v.optional(investigationError),
});

const checkerSummary = v.object({ status: v.union(v.literal("passed"), v.literal("rejected")), agentMode: v.string(), supported: v.number(), notSupported: v.number(), notCheckable: v.number() });
export const runSummary = v.object({ runId: v.string(), attempt: v.number(), status: v.string(), mode: v.string(), outcome: v.union(v.string(), v.null()), checker: v.union(checkerSummary, v.null()) });

/** Append-only. The orchestration exactly as it was after the event. */
export const snapshot = v.object({
  snapshotId: v.string(), eventId: v.string(), orchestrationId: v.string(), sequence: v.number(), timestamp: v.number(),
  orchestration, run: v.union(runSummary, v.null()),
});

/** One row per real (paid) provider run: the investigator and/or the checker of an attempt. Mock runs are never recorded. */
export const realRun = v.object({ runId: v.string(), taskId: v.string(), accountId: v.union(v.string(), v.null()), provider: v.union(v.literal("investigator"), v.literal("checker")), day: v.string(), at: v.number() });

export const correctingEntry = v.object({
  kind: v.union(v.literal("record_bank_item"), v.literal("reverse_entry")), bankSourceId: v.union(v.string(), v.null()), reversesEntryId: v.union(v.string(), v.null()),
  ownerId: v.union(v.string(), v.null()), amountCents: v.number(), memo: v.string(), evidenceSourceIds: v.array(v.string()),
});
const cause = v.object({ code: money.causeCode, severity: v.union(v.literal("mismatch"), v.literal("warning")), message: v.string(), amountCents: v.union(v.number(), v.null()), sourceIds: v.array(v.string()), ownerIds: v.array(v.string()), unattributed: v.boolean() });
export const reconciliationInput = v.object({
  schemaVersion: v.literal("finance-reconciliation-input/v1"), instructionVersion: v.literal("finance-reconciler/v1"), runId: v.string(), accountId: v.string(), currency: v.string(), causeKey: v.string(), cause,
  threeWay: v.object({ status: v.union(v.literal("matched"), v.literal("mismatched"), v.literal("insufficient_data")), bankMinusBook: v.union(v.number(), v.null()), bookMinusOwners: v.number() }),
  records: v.object({
    bankTransactions: v.array(money.bankTransaction), ledgerEntries: v.array(money.ledgerEntry),
    owners: v.array(v.object({ ownerId: v.string(), sourceId: v.string(), name: v.string() })), documents: v.array(v.object({ sourceId: v.string(), title: v.string(), text: v.string() })),
  }),
});
export const reconciliationOutput = v.object({
  schemaVersion: v.literal("finance-reconciliation-output/v1"), outcome: v.union(v.literal("correction_proposed"), v.literal("needs_information")), explanation: v.string(),
  findings: v.array(v.object({ findingId: v.string(), summary: v.string(), sourceRefs: v.array(v.string()) })), questions: v.array(v.object({ key: v.string(), question: v.string() })),
  proposedEntry: v.union(correctingEntry, v.null()),
});
const correctionFailure = v.object({ rule: v.union(v.literal("L3"), v.literal("L4"), v.literal("L6"), v.literal("L7"), v.literal("R1")), code: v.string(), message: v.string(), sourceIds: v.array(v.string()) });
export const correctionLock = v.object({ allowed: v.boolean(), failures: v.array(correctionFailure), evaluated: v.array(v.string()), resolves: v.boolean() });
export const findingCheck = v.object({ findingId: v.string(), supported: v.boolean(), missing: v.array(v.string()), sourceSays: v.union(v.string(), v.null()) });

export const reconciliationRun = v.object({
  runId: v.string(), orchestrationId: v.string(), accountId: v.string(), causeKey: v.string(), attempt: v.number(), mode: v.union(v.literal("mock"), v.literal("creao")),
  status: v.union(v.literal("investigating"), v.literal("validating"), v.literal("checking"), v.literal("needs_person"), v.literal("rejected"), v.literal("failed")),
  input: reconciliationInput, output: v.union(reconciliationOutput, v.null()), findingChecks: v.array(findingCheck), dryRun: v.union(correctionLock, v.null()),
  error: v.union(investigationError, v.null()), externalRunId: v.union(v.string(), v.null()), retries: v.number(), createdAt: v.number(), updatedAt: v.number(),
});

/** A proposed correcting entry. It changes status (proposed → posted | rejected); the ledger itself is only appended to. */
export const correction = v.object({
  correctionId: v.string(), accountId: v.string(), runId: v.string(), orchestrationId: v.string(), causeKey: v.string(), entry: correctingEntry, explanation: v.string(),
  status: v.union(v.literal("proposed"), v.literal("posted"), v.literal("rejected")), requestedBy: v.string(),
  decidedBy: v.optional(v.string()), rejectionReason: v.optional(v.string()), lock: v.optional(correctionLock), entryIds: v.optional(v.array(v.string())), createdAt: v.number(), updatedAt: v.number(),
});

export const backtestCase = v.object({ bankSourceId: v.string(), label: v.string(), predictedOwnerId: v.string(), decidedOwnerIds: v.array(v.string()), agrees: v.boolean() });
export const backtest = v.object({ statement: v.string(), testable: v.boolean(), handled: v.number(), agree: v.number(), disagree: v.number(), cases: v.array(backtestCase), summary: v.string(), reasonRequired: v.boolean() });
/** Append-only record of the backtest shown when a person approved a rule, and their reason when one was required. */
export const policyBacktest = backtest.extend({ backtestId: v.string(), accountId: v.string(), policyId: v.string(), runId: v.string(), reason: v.union(v.string(), v.null()), approvedBy: v.string(), at: v.number() });

export const scorecard = v.object({ scorecardId: v.string(), accountId: v.string(), kind: v.union(v.literal("planted"), v.literal("batch")), count: v.number(), startedAt: v.number() });
