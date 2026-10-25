import "server-only";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { AgentEvent, AuditFinding, Escalation, InvestigationChatMessage, InvestigationRecord, InvestigationReport, InvestigationRun, MemoryEntry, Snapshot, SteeringRequest } from "../../../packages/contracts";

function client() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const token = process.env.MANGEKYO_CONVEX_AUTH_TOKEN;
  if (!url || !token) throw new Error("Convex mode requires NEXT_PUBLIC_CONVEX_URL and server-only MANGEKYO_CONVEX_AUTH_TOKEN");
  const result = new ConvexHttpClient(url);
  result.setAuth(token);
  return result;
}

const query = <T>(name: string) => makeFunctionReference<"query", Record<string, unknown>, T>(`investigations:${name}`);
const mutation = <T>(name: string) => makeFunctionReference<"mutation", Record<string, unknown>, T>(`investigations:${name}`);
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function readInvestigation(): Promise<InvestigationRecord> { return client().query(query<InvestigationRecord>("list"), {}); }
export async function addRun(run: InvestigationRun) { await client().mutation(mutation("addRun"), { run: clean(run) }); }
export async function updateRun(runId: string, changes: Pick<InvestigationRun, "status" | "proposedOwner">) { await client().mutation(mutation("updateRun"), clean({ runId, ...changes })); }
export async function appendCheckpoint(event: AgentEvent, snapshot: Snapshot) { await client().mutation(mutation("appendCheckpoint"), { event: clean(event), snapshot: clean(snapshot) }); }
export async function addSteering(request: SteeringRequest) { await client().mutation(mutation("addSteering"), { request: clean(request) }); }
export async function saveReport(report: InvestigationReport) { await client().mutation(mutation("saveReport"), { report: clean(report) }); }
export async function appendChatMessage(message: InvestigationChatMessage) { await client().mutation(mutation("appendChatMessage"), { message: clean(message) }); }
export async function appendMemory(memory: MemoryEntry) { await client().mutation(mutation("appendMemory"), { memory: clean(memory) }); }
export async function appendAudit(finding?: AuditFinding, escalation?: Escalation) { await client().mutation(mutation("appendAudit"), clean({ finding, escalation })); }
export async function resolveEscalation(runId: string, message: InvestigationChatMessage) { await client().mutation(mutation("resolveEscalation"), { runId, message: clean(message) }); }

export async function saveScreenshot(bytes: Buffer): Promise<string> {
  const convex = client();
  const uploadUrl = await convex.mutation(mutation<string>("generateUploadUrl"), {});
  const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "image/png" }, body: new Uint8Array(bytes) });
  if (!response.ok) throw new Error(`Convex screenshot upload failed (${response.status})`);
  const { storageId } = await response.json() as { storageId: string };
  const artifactId = crypto.randomUUID();
  await convex.mutation(mutation("registerArtifact"), { artifactId, storageId });
  return artifactId;
}

export async function loadScreenshot(artifactId: string): Promise<Buffer> {
  const url = await client().query(query<string | null>("artifactUrl"), { artifactId });
  if (!url) throw new Error("Screenshot unavailable");
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Screenshot unavailable");
  return Buffer.from(await response.arrayBuffer());
}
