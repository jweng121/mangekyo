import type { EvidenceReference } from "./events";
export type MemoryType = "episodic" | "procedural" | "policy_reference";
export type MemoryStatus = "pending" | "approved" | "rejected" | "revoked" | "superseded";
export interface MemoryEntry {
  id: string;
  schemaVersion: 1;
  title: string;
  content: string;
  type: MemoryType;
  agentRole: string;
  organizationId: string;
  taskType: string;
  dataContext: string;
  sourceRunId: string;
  sourceSnapshotId: string;
  sourceCorrectionId: string;
  sourceReportId?: string;
  evidence: EvidenceReference[];
  createdBy: string;
  approvedBy?: string;
  createdAt: string;
  approvedAt?: string;
  status: MemoryStatus;
  version: number;
  supersedesId?: string;
}
export interface MemoryProposal extends MemoryEntry { status: "pending" }
export interface MemoryQuery { organizationId: string; agentRole: string; taskType: string; dataContext: string }
export interface ApprovedMemoryContext {
  entries: Pick<MemoryEntry, "id" | "version" | "title" | "content">[];
  authority: "guidance_only";
}
