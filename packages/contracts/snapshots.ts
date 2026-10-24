import type { EvidenceReference, FinanceTask, SyntheticRecord } from "./finance";

/** Structured state at a persisted event, with no generated reasoning or screenshot. */
export interface InitialFinanceSnapshot extends SyntheticRecord {
  snapshotId: string;
  eventId: string;
  taskId: string;
  runId: string;
  sequence: number;
  timestamp: number;
  taskState: FinanceTask;
  inputs: {
    transactionId: string;
    candidateOwnerId: string;
    evidenceRefs: EvidenceReference[];
  };
  output: {
    allocationStatus: "unallocated";
    allocatedAmountCents: 0;
    approved: false;
    investigationStatus: "not_started";
  };
}

export interface InvestigationSnapshot extends SyntheticRecord {
  snapshotId: string;
  eventId: string;
  taskId: string;
  runId: string;
  sequence: number;
  timestamp: number;
  taskState: FinanceTask;
  inputs: {
    transactionId: string;
    candidateOwnerId: string;
    evidenceRefs: EvidenceReference[];
    contextRunId: string;
    instructionVersion: string;
  };
  output: {
    allocationStatus: "unallocated";
    allocatedAmountCents: 0;
    approved: false;
    investigationStatus: import("./investigation").InvestigationStatus;
    providerMode: import("./investigation").FinanceAgentMode;
    simulated: boolean;
    result: import("./investigation").FinanceAgentOutput | null;
    deterministicChecks: import("./investigation").DeterministicChecks | null;
    error: import("./investigation").InvestigationError | null;
    reportSource?: import("./investigation").FinanceReportSource;
  };
}

export type FinanceSnapshot = InitialFinanceSnapshot | InvestigationSnapshot;
