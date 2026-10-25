import type { ActionType, AuditStatus, EvidenceReference, ExecutionStatus } from "./events";
import type { EvidenceAnnotation } from "./narration";

export interface ObservationField {
  id: string;
  label: string;
  value: string;
  sourceRef?: string;
  emphasis?: "read" | "modified" | "conflict" | "memory";
  bounds?: { x: number; y: number; width: number; height: number };
}

/** Immutable tool result used by the shared read/write evidence renderer. */
export interface RecordEvidence {
  system: string;
  resource: string;
  operation: "read" | "insert" | "update" | "delete";
  status: "succeeded" | "failed" | "proposed";
  filters: Record<string, string>;
  columns: { key: string; label: string; align?: "left" | "right" }[];
  rows: Record<string, string | number | boolean | null>[];
  rowCount: number;
  truncated: boolean;
  executedAt: string;
  changes?: { field: string; before: string; after: string }[];
  transactionId?: string;
  postingEffect?: string;
}

export interface StructuredObservation {
  kind: "api" | "document" | "browser" | "synthetic";
  label: string;
  fields: ObservationField[];
  input?: Record<string, string>;
  output?: Record<string, string>;
  changes?: { field: string; before: string; after: string }[];
  toolInteractions?: { tool: string; request: string; response: string }[];
  documentText?: string;
  record?: RecordEvidence;
}

export interface Snapshot {
  id: string;
  schemaVersion: 1;
  eventId: string;
  runId: string;
  taskId: string;
  parentSnapshotId?: string;
  documentId?: string;
  documentVersion?: string;
  viewport?: { width: number; height: number; page?: number };
  targetRegion?: { x: number; y: number; width: number; height: number };
  agentId: string;
  agentRole: string;
  timestamp: string;
  sequence: number;
  actionType: ActionType;
  title: string;
  summary: string;
  screenshot?: { url: string; provenance: "actual" | "simulated"; alt: string; capturedAt?: string; artifactId?: string };
  observation: StructuredObservation;
  source: string;
  readTargets: string[];
  writeTargets: string[];
  evidence: EvidenceReference[];
  annotations?: EvidenceAnnotation[];
  instructionVersion: string;
  policyVersion: string;
  executionStatus: ExecutionStatus;
  auditStatus: AuditStatus;
  memoryRefs?: string[];
  browserUrl?: string;
  toolCall?: string;
  toolResponse?: string;
  recordedJustification?: string;
  screenshotDimensions?: { width: number; height: number };
  sourceDocument?: { url: string; filename: string; mimeType: "application/pdf"; sha256: string; pageNumber: number; pageCount: number; extraction: "pdf-text" };
}

export * from "./finance-snapshots";
