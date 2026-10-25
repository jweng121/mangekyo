import {atomicRename} from "./atomic-rename";
import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AgentEvent, AuditFinding, Escalation, InvestigationChatMessage, InvestigationRecord, InvestigationReport, InvestigationRun, MemoryEntry, Snapshot, SteeringRequest } from "../../../packages/contracts";
import * as convexStore from "./convex-store";

const tenantId = process.env.MANGEKYO_DEMO_TENANT_ID || "harbor-trust-demo";
const root = process.env.MANGEKYO_LOCAL_DATA_DIR || path.join(tmpdir(), "mangekyo-local-demo");
const file = path.join(root, "investigations.json");
const empty = (): InvestigationRecord => ({ runs: [], events: [], snapshots: [], steeringRequests: [], reports: [], chatMessages: [], memoryRecords: [], findings: [], escalations: [] });
let writeQueue = Promise.resolve();
const useConvex = () => process.env.NEXT_PUBLIC_VISUAL_AUDIT_MODE === "convex";

export function localTenantId() { return tenantId; }
export function artifactDirectory() { return path.join(root, "artifacts"); }

export async function readInvestigation(): Promise<InvestigationRecord> {
  if (useConvex()) return convexStore.readInvestigation();
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as InvestigationRecord;
    const runs = data.runs.filter(run => run.tenantId === tenantId);
    const ids = new Set(runs.map(run => run.id));
    return { runs, events: data.events.filter(event => ids.has(event.runId)), snapshots: data.snapshots.filter(snapshot => ids.has(snapshot.runId)), steeringRequests: data.steeringRequests.filter(request => ids.has(request.parentRunId)), reports: data.reports.filter(report => ids.has(report.runId)), chatMessages: (data.chatMessages ?? []).filter(message => ids.has(message.runId)), memoryRecords: (data.memoryRecords ?? []).filter(memory => ids.has(memory.sourceRunId)), findings: (data.findings ?? []).filter(finding => ids.has(finding.runId)), escalations: (data.escalations ?? []).filter(escalation => ids.has(escalation.runId)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw error;
  }
}

async function change(update: (record: InvestigationRecord) => void): Promise<void> {
  const next = writeQueue.then(async () => {
    await mkdir(root, { recursive: true });
    const record = await readInvestigation();
    update(record);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2));
    await atomicRename(temporary, file);
  });
  writeQueue = next.catch(() => {});
  await next;
}

export async function addRun(run: InvestigationRun) {
  if (useConvex()) return convexStore.addRun(run);
  if (run.tenantId !== tenantId) throw new Error("Tenant mismatch");
  await change(record => { if (record.runs.some(item => item.id === run.id)) throw new Error("Duplicate run"); record.runs.push(run); });
}

export async function appendCheckpoint(event: AgentEvent, snapshot: Snapshot) {
  if (useConvex()) return convexStore.appendCheckpoint(event, snapshot);
  await change(record => {
    if (!record.runs.some(run => run.id === event.runId)) throw new Error("Unknown run");
    if (event.runId !== snapshot.runId || event.snapshotId !== snapshot.id || snapshot.eventId !== event.id) throw new Error("Checkpoint mismatch");
    if (record.events.some(item => item.id === event.id || (item.runId === event.runId && item.sequence === event.sequence))) throw new Error("Duplicate checkpoint");
    record.events.push(event);
    record.snapshots.push(snapshot);
  });
}

export async function updateRun(runId: string, changes: Pick<InvestigationRun, "status" | "proposedOwner">) {
  if (useConvex()) return convexStore.updateRun(runId, changes);
  await change(record => { const run = record.runs.find(item => item.id === runId); if (!run) throw new Error("Unknown run"); Object.assign(run, changes); });
}

export async function addSteering(request: SteeringRequest) {
  if (useConvex()) return convexStore.addSteering(request);
  await change(record => { if (!record.runs.some(run => run.id === request.parentRunId)) throw new Error("Unknown parent run"); record.steeringRequests.push(request); });
}

export async function saveReport(report: InvestigationReport) {
  if (useConvex()) return convexStore.saveReport(report);
  await change(record => {
    if (!record.runs.some(run => run.id === report.runId) || !record.runs.some(run => run.id === report.correctedRunId)) throw new Error("Unknown report run");
    const prior = record.reports.filter(item => item.id === report.id).at(-1);
    if (prior && (report.version !== prior.version + 1 || prior.status === "filed")) throw new Error("Invalid report revision");
    if (!prior && report.version !== 1) throw new Error("Invalid initial report version");
    record.reports.push(report);
  });
}

export async function appendChatMessage(message: InvestigationChatMessage) {
  if (useConvex()) return convexStore.appendChatMessage(message);
  await change(record => { if (!record.runs.some(run => run.id === message.runId)) throw new Error("Unknown run"); if (record.chatMessages.some(item => item.id === message.id)) throw new Error("Duplicate chat message"); record.chatMessages.push(message); });
}

export async function appendMemory(memory: MemoryEntry) {
  if (useConvex()) return convexStore.appendMemory(memory);
  await change(record => {
    if (!record.runs.some(run => run.id === memory.sourceRunId)) throw new Error("Unknown source run");
    const prior = record.memoryRecords.filter(item => item.id === memory.id).at(-1);
    if (prior && (prior.version + 1 !== memory.version || prior.status !== "pending" || memory.status !== "approved")) throw new Error("Invalid memory transition");
    if (!prior && (memory.version !== 1 || memory.status !== "pending")) throw new Error("Invalid memory proposal");
    record.memoryRecords.push(memory);
  });
}

export async function appendAudit(finding?: AuditFinding, escalation?: Escalation) {
  if (useConvex()) return convexStore.appendAudit(finding, escalation);
  await change(record => {
    if (finding && !record.runs.some(run => run.id === finding.runId)) throw new Error("Unknown audit run");
    if (finding) record.findings.push(finding);
    if (escalation) record.escalations.push(escalation);
  });
}

export async function resolveEscalation(runId: string, message: InvestigationChatMessage) {
  if (useConvex()) return convexStore.resolveEscalation(runId, message);
  await change(record => {
    const escalation = record.escalations.find(item => item.runId === runId && item.status === "open");
    if (!escalation) throw new Error("No open review case");
    if (message.runId !== runId || record.chatMessages.some(item => item.id === message.id)) throw new Error("Invalid resolution message");
    record.chatMessages.push(message);
    escalation.status = "resolved";
    const finding = record.findings.find(item => item.id === escalation.findingId);
    if (finding) finding.reviewStatus = "resolved";
  });
}

export async function approvedMemoryForDemo(): Promise<MemoryEntry | undefined> {
  const record = await readInvestigation();
  const latest = new Map<string, MemoryEntry>();
  for (const memory of record.memoryRecords) latest.set(memory.id, memory);
  return [...latest.values()].reverse().find(memory => memory.status === "approved" && memory.agentRole === "Deposit Matching Agent" && memory.taskType === "deposit_ownership" && memory.dataContext === "ambiguous_deposit");
}

export async function saveScreenshot(bytes: Buffer): Promise<string> {
  if (useConvex()) return convexStore.saveScreenshot(bytes);
  await mkdir(artifactDirectory(), { recursive: true });
  const id = crypto.randomUUID();
  await writeFile(path.join(artifactDirectory(), `${id}.png`), bytes, { flag: "wx" });
  return id;
}

export async function loadScreenshot(id: string): Promise<Buffer> {
  if (useConvex()) return convexStore.loadScreenshot(id);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid artifact ID");
  const record = await readInvestigation();
  if (!record.snapshots.some(snapshot => snapshot.screenshot?.url === `/api/visual-audit/artifacts/${id}`)) throw new Error("Artifact not in tenant");
  return readFile(path.join(artifactDirectory(), `${id}.png`));
}

export async function savePdf(bytes: Buffer): Promise<string> {
  if (useConvex()) throw new Error("PDF source storage currently requires local mode");
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Invalid PDF source");
  await mkdir(artifactDirectory(), { recursive: true });
  const id = crypto.randomUUID();
  await writeFile(path.join(artifactDirectory(), `${id}.pdf`), bytes, { flag: "wx" });
  return id;
}
export async function loadPdf(id: string): Promise<Buffer> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid PDF ID");
  const record = await readInvestigation();
  if (!record.snapshots.some(snapshot => snapshot.sourceDocument?.url === `/api/visual-audit/documents/${id}`)) throw new Error("PDF is not in this investigation store");
  return readFile(path.join(artifactDirectory(), `${id}.pdf`));
}
