import type { AgentEvent, CorrectionRequest, ExecutionBranch, Snapshot, SteeringRequest } from "@mangekyo/contracts";
import { DEMO_TIME } from "../adapters/mock-events";

export interface SimulatedCorrection {
  steering: SteeringRequest;
  correction: CorrectionRequest;
  branch: ExecutionBranch;
  events: AgentEvent[];
  snapshots: Snapshot[];
}

export function simulateSteering(checkpoint: Snapshot, instruction: string, actorId: string, scope: SteeringRequest["scope"]): SimulatedCorrection {
  if (!instruction.trim()) throw new Error("A corrective instruction is required.");
  if (!actorId.trim()) throw new Error("An authenticated reviewer identity is required.");
  if (checkpoint.id !== "snapshot-original-maker") throw new Error("The demo supports steering from the maker proposal checkpoint.");
  const steering: SteeringRequest = { id: "steering-1042", schemaVersion: 1, parentRunId: checkpoint.runId, checkpointSnapshotId: checkpoint.id, instruction: instruction.trim(), evidenceIds: checkpoint.evidence.map(item => item.id), actorId, createdAt: DEMO_TIME, scope, status: "simulated" };
  const correction: CorrectionRequest = { id: "correction-1042", steeringId: steering.id, parentRunId: checkpoint.runId, newRunId: "run-corrected", restartFromSnapshotId: checkpoint.id, affectedTaskIds: [checkpoint.taskId], replayPayments: false, status: "simulated" };
  const branch: ExecutionBranch = { id: "branch-corrected", parentRunId: checkpoint.runId, runId: correction.newRunId, forkSnapshotId: checkpoint.id, correctionId: correction.id, createdAt: DEMO_TIME, status: "simulated" };
  const specs = [
    { id: "steer", action: "STEER" as const, title: "Human correction", summary: "Reviewer directed the maker to resolve ownership using original payment evidence.", agent: "reviewer", role: "Human Reviewer", fields: [{ id: "instruction", label: "Correction instruction", value: instruction.trim(), emphasis: "modified" as const }], output: { status: "accepted for simulated rerun" } },
    { id: "recheck", action: "READ" as const, title: "Recheck payment reference", summary: "Revisited B-204 and found Client B ownership evidence.", agent: "maker", role: "Matching Maker", fields: [{ id: "reference", label: "Payment reference", value: "B-204 / Client B", sourceRef: "remit-1042", emphasis: "read" as const }], output: { ownerFromReference: "Client B" } },
    { id: "proposal", action: "PROPOSE" as const, title: "Revised allocation", summary: "Proposed Client B with reference evidence; still no financial write.", agent: "maker", role: "Matching Maker", fields: [{ id: "owner", label: "Revised owner", value: "Client B", sourceRef: "remit-1042", emphasis: "modified" as const }], output: { proposedOwner: "Client B", status: "proposal only" } },
    { id: "validated", action: "AUDIT" as const, title: "Branch comparison", summary: "Revised proposal agrees with the independent checker; no payment was replayed.", agent: "mangekyo", role: "Mangekyo Auditor", fields: [{ id: "comparison", label: "Original → corrected", value: "Client A → Client B", sourceRef: "remit-1042", emphasis: "read" as const }], output: { status: "simulated agreement; human review remains required" } },
  ];
  const events: AgentEvent[] = [];
  const snapshots: Snapshot[] = [];
  specs.forEach((spec, index) => {
    const id = `corrected-${spec.id}`;
    const parentEventId = index === 0 ? checkpoint.eventId : events[index - 1].id;
    const timestamp = new Date(Date.parse(DEMO_TIME) + (20 + index) * 1_000).toISOString();
    events.push({ id, schemaVersion: 1, runId: correction.newRunId, taskId: checkpoint.taskId, sequence: index + 1, timestamp, agentId: spec.agent, agentRole: spec.role, actionType: spec.action, title: spec.title, summary: spec.summary, parentEventIds: [parentEventId], branchId: branch.id, snapshotId: `snapshot-${id}`, status: "simulated" });
    snapshots.push({ id: `snapshot-${id}`, schemaVersion: 1, eventId: id, runId: correction.newRunId, taskId: checkpoint.taskId, parentSnapshotId: index === 0 ? checkpoint.id : snapshots[index - 1].id, agentId: spec.agent, agentRole: spec.role, timestamp, sequence: index + 1, actionType: spec.action, title: spec.title, summary: spec.summary, observation: { kind: "synthetic", label: "Simulated corrected branch", fields: spec.fields, output: Object.fromEntries(Object.entries(spec.output).filter((entry): entry is [string, string] => typeof entry[1] === "string")), changes: index === 2 ? [{ field: "proposed owner", before: "Client A", after: "Client B" }] : undefined }, source: "Simulated corrected branch", readTargets: index === 1 ? ["payment reference B-204"] : [], writeTargets: [], evidence: checkpoint.evidence, instructionVersion: "demo-1+steering-1042", policyVersion: checkpoint.policyVersion, executionStatus: "simulated", auditStatus: "unreviewed" });
  });
  return { steering, correction, branch, events, snapshots };
}
