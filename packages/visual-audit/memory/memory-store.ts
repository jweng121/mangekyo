import type { ApprovedMemoryContext, MemoryEntry, MemoryProposal, MemoryQuery, Snapshot, SteeringRequest } from "@mangekyo/contracts";
import { DATA_CONTEXT, ORGANIZATION_ID, TASK_TYPE } from "../adapters/mock-events";

export function proposeMemory(steering: SteeringRequest, source: Snapshot): MemoryProposal {
  return { id: `memory-${steering.id}`, schemaVersion: 1, title: "Resolve conflicting deposit ownership evidence", content: "When invoice information and payment references disagree, investigate the payment reference and seek additional ownership evidence before proposing a final allocation.", type: "procedural", agentRole: "Matching Maker", organizationId: ORGANIZATION_ID, taskType: TASK_TYPE, dataContext: DATA_CONTEXT, sourceRunId: steering.parentRunId, sourceSnapshotId: source.id, sourceCorrectionId: steering.id, evidence: source.evidence, createdBy: steering.actorId, createdAt: steering.createdAt, status: "pending", version: 1 };
}

export function approveMemory(proposal: MemoryProposal, reviewerId: string, approvedAt: string): MemoryEntry {
  if (!reviewerId.trim()) throw new Error("An authorized reviewer identity is required.");
  return { ...proposal, status: "approved", approvedBy: reviewerId, approvedAt };
}

export function reviseMemory(entry: MemoryEntry, actorId: string, createdAt: string): MemoryProposal {
  if (entry.status !== "approved") throw new Error("Only an approved memory can be revised.");
  if (!actorId.trim()) throw new Error("A reviewer identity is required.");
  return { ...entry, id: `${entry.id}-v${entry.version + 1}`, version: entry.version + 1, supersedesId: entry.id, status: "pending", createdBy: actorId, createdAt, approvedBy: undefined, approvedAt: undefined };
}

export function retrieveApprovedMemory(entries: MemoryEntry[], query: MemoryQuery): ApprovedMemoryContext {
  return { authority: "guidance_only", entries: entries.filter(entry => entry.status === "approved" && entry.type !== "policy_reference" && entry.organizationId === query.organizationId && entry.agentRole === query.agentRole && entry.taskType === query.taskType && entry.dataContext === query.dataContext).map(({ id, version, title, content }) => ({ id, version, title, content })) };
}

export function readStoredMemories(storage: Pick<Storage, "getItem">): MemoryEntry[] {
  try {
    const value = JSON.parse(storage.getItem("mangekyo-demo-memory-v1") ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter(isMemoryEntry) : [];
  } catch { return []; }
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<MemoryEntry>;
  return typeof entry.id === "string" && entry.schemaVersion === 1 && typeof entry.organizationId === "string" && typeof entry.version === "number" && ["pending", "approved", "rejected", "revoked", "superseded"].includes(entry.status ?? "");
}

export function writeStoredMemories(storage: Pick<Storage, "setItem">, entries: MemoryEntry[]): void {
  storage.setItem("mangekyo-demo-memory-v1", JSON.stringify(entries));
}

export function readStoredProposal(storage: Pick<Storage, "getItem">): MemoryProposal | undefined {
  try {
    const value = JSON.parse(storage.getItem("mangekyo-demo-proposal-v1") ?? "null") as unknown;
    return isMemoryEntry(value) && value.status === "pending" ? value as MemoryProposal : undefined;
  } catch { return undefined; }
}

export function writeStoredProposal(storage: Pick<Storage, "setItem">, proposal?: MemoryProposal): void {
  storage.setItem("mangekyo-demo-proposal-v1", JSON.stringify(proposal ?? null));
}
