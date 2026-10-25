export type ActionType = "READ" | "PROPOSE" | "DECISION" | "WRITE_ATTEMPT" | "WRITE_CONFIRMED" | "HANDOFF" | "AUDIT" | "ESCALATE" | "STEER" | "MEMORY_WRITE";
export type ExecutionStatus = "running" | "completed" | "blocked" | "simulated";
export type AuditStatus = "unreviewed" | "clear" | "flagged" | "needs_review";

export interface EvidenceReference {
  id: string;
  label: string;
  source: string;
  field?: string;
  value?: string;
  href?: string;
}

export interface AgentEvent {
  id: string;
  schemaVersion: 1;
  runId: string;
  taskId: string;
  sequence: number;
  timestamp: string;
  agentId: string;
  agentRole: string;
  actionType: ActionType;
  title: string;
  summary: string;
  parentEventIds: string[];
  branchId: string;
  snapshotId: string;
  status: ExecutionStatus;
  toolCall?: string;
  toolResponse?: string;
  browserUrl?: string;
}
