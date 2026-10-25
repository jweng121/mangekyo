export interface SteeringRequest {
  id: string;
  schemaVersion: 1;
  parentRunId: string;
  checkpointSnapshotId: string;
  instruction: string;
  evidenceIds: string[];
  actorId: string;
  createdAt: string;
  scope: "checkpoint" | "dependent_work";
  status: "submitted" | "simulated";
}
export interface CorrectionRequest {
  id: string;
  steeringId: string;
  parentRunId: string;
  newRunId: string;
  restartFromSnapshotId: string;
  affectedTaskIds: string[];
  replayPayments: false;
  status: "requested" | "simulated";
}
export interface ExecutionBranch {
  id: string;
  parentRunId: string;
  runId: string;
  forkSnapshotId: string;
  correctionId: string;
  createdAt: string;
  status: "simulated";
}
