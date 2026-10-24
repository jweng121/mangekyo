import type { EvidenceReference, SyntheticRecord } from "./finance";

/** Persisted append-only facts; sequence orders events within a task. Timestamps are Unix ms. */
export interface TaskCreatedEvent extends SyntheticRecord {
  eventId: string;
  taskId: string;
  runId: string;
  sequence: number;
  type: "finance.task.created";
  timestamp: number;
  actor: { type: "system"; component: "finance-dev.synthetic-seed" };
  evidenceRefs: EvidenceReference[];
  payload: {
    transactionId: string;
    candidateOwnerId: string;
    amountCents: number;
    currency: "USD";
    allocationStatus: "unallocated";
  };
}

export type InvestigationEventType = "finance.investigation.started" | "finance.evidence.retrieved" |
  "finance.checks.completed" | "finance.provider.started" | "finance.provider.result_received" |
  "finance.validation.failed" | "finance.investigation.failed" | "finance.question.raised" |
  "finance.clarification.saved" | "finance.investigation.resumed" | "finance.investigation.completed";

export interface InvestigationEvent extends SyntheticRecord {
  eventId: string;
  taskId: string;
  runId: string;
  sequence: number;
  type: InvestigationEventType;
  timestamp: number;
  actor: { type: "system"; component: "finance-investigation" } |
    { type: "human"; component: "finance-dev"; identity: string; authenticated: boolean };
  evidenceRefs: EvidenceReference[];
  payload: {
    mode: import("./investigation").FinanceAgentMode;
    simulated: boolean;
    message: string;
    instructionVersion: string;
    policyVersions: string[];
    contextRunId?: string;
    parentRunId?: string;
    externalRunId?: string;
    reportSource?: import("./investigation").FinanceReportSource;
    questionId?: string;
    clarificationId?: string;
    errorCode?: string;
  };
}

export type FinanceEvent = TaskCreatedEvent | InvestigationEvent;

export type MoneyEventType = "finance.money.import_completed" | "finance.money.lock_checked" |
  "finance.money.proposal_transitioned" | "finance.money.ledger_posted" | "finance.money.bank_item_recorded";

/** Account-level money stream. taskId is the stream key `money:<accountId>`; runId is the operation ID. */
export interface MoneyEvent extends SyntheticRecord {
  eventId: string;
  taskId: string;
  runId: string;
  sequence: number;
  type: MoneyEventType;
  timestamp: number;
  actor: { type: "system"; component: "finance-money" } |
    { type: "human"; component: "finance-dev"; identity: string; authenticated: boolean };
  evidenceRefs: EvidenceReference[];
  payload: {
    accountId: string;
    message: string;
    proposalId: string | null;
    allowed: boolean | null;
    reasonCodes: string[];
    sourceIds: string[];
    entryIds: string[];
  };
}

export type AnyFinanceEvent = FinanceEvent | MoneyEvent;
