import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import { evidenceWorker } from "./evidence-worker";
import { appendCheckpoint, savePdf, saveScreenshot } from "./local-store";
import type { AgentEvent, InvestigationRun, Snapshot } from "../../../packages/contracts";

export type PdfReadResult = { text: string; pageNumber: number; pageCount: number; matchCount: number; value?: string; region?: { x: number; y: number; width: number; height: number }; pngBase64: string; dimensions: { width: number; height: number } };
export const demoPdfPath = (name: "bank" | "funding") => path.resolve(process.cwd(), "../../output/pdf", name === "bank" ? "trust-bank-statement.pdf" : "trust-funding-instruction.pdf");
export function readPdf(bytes: Buffer, pageNumber = 1, pattern?: string, group = 0) {
  return evidenceWorker<PdfReadResult>({ action: "pdf", bytes: bytes.toString("base64"), pageNumber, pattern, group });
}
export async function capturePdfRead(input: { bytes: Buffer; filename: string; run: InvestigationRun; sequence: number; title: string; field: string; label: string; pattern: string; group?: number; pageNumber?: number; parentSnapshotId?: string; summary?:string }) {
  const result = await readPdf(input.bytes, input.pageNumber ?? 1, input.pattern, input.group);
  if (result.matchCount !== 1 || !result.value || !result.region) throw new Error(`PDF field ${input.label} was missing or ambiguous; no value inferred`);
  const sourceId = await savePdf(input.bytes);
  const artifactId = await saveScreenshot(Buffer.from(result.pngBase64, "base64"));
  const id = `${input.run.id}-snapshot-${input.sequence}`, eventId = `${input.run.id}-event-${input.sequence}`, evidenceId = `${id}-${input.field}`, timestamp = new Date().toISOString();
  const summary = input.summary ?? `Read ${input.label.toLowerCase()} ${result.value} from ${input.filename}, page ${result.pageNumber}.`;
  const event: AgentEvent = { id: eventId, schemaVersion: 1, runId: input.run.id, taskId: input.run.taskId, sequence: input.sequence, timestamp, agentId: input.run.agentId, agentRole: input.run.agentId, actionType: "READ", title: input.title, summary, parentEventIds: input.sequence > 1 ? [`${input.run.id}-event-${input.sequence - 1}`] : input.parentSnapshotId ? [input.parentSnapshotId.replace("-snapshot-", "-event-")] : [], branchId: input.run.branchId, snapshotId: id, status: "completed", toolCall: `PDF text extraction: ${input.filename} / page ${result.pageNumber}`, toolResponse: result.value };
  const snapshot: Snapshot = { id, schemaVersion: 1, eventId, runId: input.run.id, taskId: input.run.taskId, parentSnapshotId: input.parentSnapshotId ?? (input.sequence > 1 ? `${input.run.id}-snapshot-${input.sequence - 1}` : undefined), agentId: input.run.agentId, agentRole: input.run.agentId, timestamp, sequence: input.sequence, actionType: "READ", title: input.title, summary, documentId: input.filename, documentVersion: createHash("sha256").update(input.bytes).digest("hex"),
    sourceDocument: { url: `/api/visual-audit/documents/${sourceId}`, filename: input.filename, mimeType: "application/pdf", sha256: createHash("sha256").update(input.bytes).digest("hex"), pageNumber: result.pageNumber, pageCount: result.pageCount, extraction: "pdf-text" },
    screenshot: { url: `/api/visual-audit/artifacts/${artifactId}`, provenance: "actual", alt: `${input.filename}, page ${result.pageNumber}`, capturedAt: timestamp, artifactId }, screenshotDimensions: result.dimensions, targetRegion: result.region,
    observation: { kind: "document", label: input.filename, documentText: result.text, fields: [{ id: input.field, label: input.label, value: result.value, sourceRef: evidenceId, bounds: result.region, emphasis: "read" }] }, source: input.filename, readTargets: [input.label], writeTargets: [], evidence: [{ id: evidenceId, label: input.label, source: input.filename, field: input.field, value: result.value }], annotations: [{ id: `${id}:${input.field}`, snapshotId: id, evidenceRef: evidenceId, label: input.label, textQuote: result.value, region: result.region }], instructionVersion: "pdf-text-reader-1", policyVersion: "demo-no-posting-1", executionStatus: "completed", auditStatus: "unreviewed", toolCall: event.toolCall, toolResponse: result.value };
  await appendCheckpoint(event, snapshot);
  return { snapshot, value: result.value };
}
