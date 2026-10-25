import type { EvidenceReference } from "./events";

export type AuditOutcome = "no_findings" | "needs_review" | "insufficient_evidence" | "error";
export interface AuditFinding {
  id: string;
  schemaVersion: 1;
  runId: string;
  snapshotId: string;
  category: "ownership_conflict" | "missing_evidence" | "risky_write";
  severity: "low" | "medium" | "high";
  explanation: string;
  evidence: EvidenceReference[];
  suggestedAction: string;
  reviewStatus: "open" | "resolved";
  reviewedThroughSequence: number;
}
export interface AuditRequest { runId: string; throughSequence: number }
export interface AuditResult { outcome: AuditOutcome; reviewedThroughSequence: number; findings: AuditFinding[] }
export interface Escalation {
  id: string;
  findingId: string;
  snapshotId: string;
  runId: string;
  status: "open" | "resolved";
  createdAt: string;
}
