import type { AgentEvent } from "./events";
import type { Snapshot } from "./snapshots";
import type { SteeringRequest } from "./corrections";
import type { MemoryEntry } from "./memory";
import type { AuditFinding, Escalation } from "./audit";

export interface InvestigationRun {
  id: string;
  displayName?: string;
  schemaVersion: 1;
  tenantId: string;
  taskId: string;
  agentId: string;
  branchId: string;
  parentRunId?: string;
  steeringId?: string;
  memoryId?: string;
  createdAt: string;
  status: "running" | "completed" | "escalated" | "corrected" | "failed";
  proposedOwner?: string;
}

export interface InvestigationReport {
  id: string;
  version: number;
  runId: string;
  correctedRunId: string;
  taskId: string;
  agentId: string;
  escalationSnapshotId: string;
  steeringRequestId: string;
  status: "draft" | "pending_review" | "approved" | "filed";
  createdAt: string;
  updatedAt: string;
  authorId: string;
  content: string;
  evidenceSnapshotIds: string[];
  remainingUncertainty: string;
}

export interface InvestigationRecord {
  runs: InvestigationRun[];
  events: AgentEvent[];
  snapshots: Snapshot[];
  steeringRequests: SteeringRequest[];
  reports: InvestigationReport[];
  chatMessages: InvestigationChatMessage[];
  memoryRecords: MemoryEntry[];
  findings: AuditFinding[];
  escalations: Escalation[];
}

export interface SnapshotChatSection {
  snapshotId?: string;
  text: string;
  annotationIds: string[];
}

export interface InvestigationChatMessage {
  sections?: SnapshotChatSection[];
  conversationId?: string;
  conversationTitle?: string;
  id: string;
  runId: string;
  role: "user" | "assistant";
  text: string;
  snapshotIds: string[];
  provider: "local" | "openai" | "anthropic";
  createdAt: string;
}

export * from "./finance-investigation";
