import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

async function tenant(ctx: { auth: { getUserIdentity(): Promise<{ tokenIdentifier: string } | null> } }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Authenticated Convex identity required");
  return identity.tokenIdentifier;
}

async function byItem(ctx: any, table: string, tenantId: string, itemId: string) {
  return (await ctx.db.query(table).withIndex("by_tenant", (q: any) => q.eq("tenantId", tenantId)).collect()).find((row: any) => row.itemId === itemId);
}
async function all(ctx: any, table: string, tenantId: string) {
  return (await ctx.db.query(table).withIndex("by_tenant", (q: any) => q.eq("tenantId", tenantId)).collect()).map((row: any) => row.payload);
}

export const list = queryGeneric({ args: {}, handler: async ctx => {
  const tenantId = await tenant(ctx);
  const [runs, events, snapshots, findings, escalations, steeringRequests, reports, chatMessages, memoryRecords] = await Promise.all([
    all(ctx, "runs", tenantId), all(ctx, "events", tenantId), all(ctx, "snapshots", tenantId), all(ctx, "auditFindings", tenantId), all(ctx, "escalations", tenantId), all(ctx, "steeringRequests", tenantId), all(ctx, "investigationReports", tenantId), all(ctx, "chatMessages", tenantId), all(ctx, "memoryRecords", tenantId),
  ]);
  return { runs, events, snapshots, findings, escalations, steeringRequests, reports, chatMessages, memoryRecords };
} });

export const addRun = mutationGeneric({ args: { run: v.any() }, handler: async (ctx, { run }) => {
  const tenantId = await tenant(ctx);
  if (typeof run?.id !== "string" || await byItem(ctx, "runs", tenantId, run.id)) throw new Error("Invalid or duplicate run");
  const payload = { ...run, tenantId };
  await ctx.db.insert("runs", { tenantId, itemId: run.id, runId: run.id, payload });
  if (run.parentRunId) await ctx.db.insert("executionBranches", { tenantId, itemId: run.id, runId: run.id, payload: { runId: run.id, parentRunId: run.parentRunId, branchId: run.branchId, steeringId: run.steeringId, memoryId: run.memoryId } });
} });

export const updateRun = mutationGeneric({ args: { runId: v.string(), status: v.string(), proposedOwner: v.optional(v.string()) }, handler: async (ctx, args) => {
  const tenantId = await tenant(ctx);
  const row = await byItem(ctx, "runs", tenantId, args.runId);
  if (!row) throw new Error("Unknown run");
  await ctx.db.patch(row._id, { payload: { ...row.payload, status: args.status, proposedOwner: args.proposedOwner } });
} });

export const appendCheckpoint = mutationGeneric({ args: { event: v.any(), snapshot: v.any() }, handler: async (ctx, { event, snapshot }) => {
  const tenantId = await tenant(ctx);
  if (!event?.id || !snapshot?.id || event.runId !== snapshot.runId || event.id !== snapshot.eventId || event.snapshotId !== snapshot.id) throw new Error("Checkpoint mismatch");
  if (!await byItem(ctx, "runs", tenantId, event.runId)) throw new Error("Unknown run");
  if (await byItem(ctx, "events", tenantId, event.id) || await byItem(ctx, "snapshots", tenantId, snapshot.id)) throw new Error("Duplicate checkpoint");
  await ctx.db.insert("events", { tenantId, itemId: event.id, runId: event.runId, payload: event });
  await ctx.db.insert("snapshots", { tenantId, itemId: snapshot.id, runId: snapshot.runId, payload: snapshot });
} });

export const addSteering = mutationGeneric({ args: { request: v.any() }, handler: async (ctx, { request }) => {
  const tenantId = await tenant(ctx);
  if (!request?.id || !await byItem(ctx, "runs", tenantId, request.parentRunId)) throw new Error("Unknown parent run");
  await ctx.db.insert("steeringRequests", { tenantId, itemId: request.id, runId: request.parentRunId, payload: request });
} });

export const saveReport = mutationGeneric({ args: { report: v.any() }, handler: async (ctx, { report }) => {
  const tenantId = await tenant(ctx);
  if (!report?.id || !await byItem(ctx, "runs", tenantId, report.runId) || !await byItem(ctx, "runs", tenantId, report.correctedRunId)) throw new Error("Unknown report run");
  const prior = (await ctx.db.query("investigationReports").withIndex("by_tenant", q => q.eq("tenantId", tenantId)).collect()).filter(row => row.itemId === report.id).at(-1);
  if (prior && (report.version !== prior.payload.version + 1 || prior.payload.status === "filed")) throw new Error("Invalid report revision");
  if (!prior && report.version !== 1) throw new Error("Invalid initial report version");
  await ctx.db.insert("investigationReports", { tenantId, itemId: report.id, runId: report.runId, payload: report });
} });

export const appendChatMessage = mutationGeneric({ args: { message: v.any() }, handler: async (ctx, { message }) => {
  const tenantId = await tenant(ctx);
  if (!message?.id || !await byItem(ctx, "runs", tenantId, message.runId) || await byItem(ctx, "chatMessages", tenantId, message.id)) throw new Error("Invalid or duplicate chat message");
  await ctx.db.insert("chatMessages", { tenantId, itemId: message.id, runId: message.runId, payload: message });
} });

export const appendMemory = mutationGeneric({ args: { memory: v.any() }, handler: async (ctx, { memory }) => {
  const tenantId = await tenant(ctx);
  if (!memory?.id || !await byItem(ctx, "runs", tenantId, memory.sourceRunId)) throw new Error("Unknown memory source run");
  const prior = (await ctx.db.query("memoryRecords").withIndex("by_tenant", q => q.eq("tenantId", tenantId)).collect()).filter(row => row.itemId === memory.id).at(-1);
  if (prior && (memory.version !== prior.payload.version + 1 || prior.payload.status !== "pending" || memory.status !== "approved")) throw new Error("Invalid memory transition");
  if (!prior && (memory.version !== 1 || memory.status !== "pending")) throw new Error("Invalid memory proposal");
  await ctx.db.insert("memoryRecords", { tenantId, itemId: memory.id, runId: memory.sourceRunId, payload: { ...memory, organizationId: tenantId } });
} });

export const appendAudit = mutationGeneric({ args: { finding: v.optional(v.any()), escalation: v.optional(v.any()) }, handler: async (ctx, { finding, escalation }) => {
  const tenantId = await tenant(ctx);
  if (finding) { if (!await byItem(ctx, "runs", tenantId, finding.runId)) throw new Error("Unknown audit run"); await ctx.db.insert("auditFindings", { tenantId, itemId: finding.id, runId: finding.runId, payload: finding }); }
  if (escalation) { if (!await byItem(ctx, "runs", tenantId, escalation.runId)) throw new Error("Unknown escalation run"); await ctx.db.insert("escalations", { tenantId, itemId: escalation.id, runId: escalation.runId, payload: escalation }); }
} });

export const resolveEscalation = mutationGeneric({ args: { runId: v.string(), message: v.any() }, handler: async (ctx, { runId, message }) => {
  const tenantId = await tenant(ctx);
  const escalation = (await ctx.db.query("escalations").withIndex("by_tenant", q => q.eq("tenantId", tenantId)).collect()).find(row => row.runId === runId && row.payload.status === "open");
  if (!escalation) throw new Error("No open review case");
  if (!message?.id || message.runId !== runId || message.role !== "assistant" || await byItem(ctx, "chatMessages", tenantId, message.id)) throw new Error("Invalid resolution message");
  await ctx.db.insert("chatMessages", { tenantId, itemId: message.id, runId, payload: message });
  await ctx.db.patch(escalation._id, { payload: { ...escalation.payload, status: "resolved" } });
  const finding = await byItem(ctx, "auditFindings", tenantId, escalation.payload.findingId);
  if (finding) await ctx.db.patch(finding._id, { payload: { ...finding.payload, reviewStatus: "resolved" } });
} });

export const generateUploadUrl = mutationGeneric({ args: {}, handler: async ctx => { await tenant(ctx); return ctx.storage.generateUploadUrl(); } });
export const registerArtifact = mutationGeneric({ args: { artifactId: v.string(), storageId: v.id("_storage") }, handler: async (ctx, args) => {
  const tenantId = await tenant(ctx);
  if ((await ctx.db.query("screenshotArtifacts").withIndex("by_tenant_artifact", q => q.eq("tenantId", tenantId)).collect()).some(row => row.artifactId === args.artifactId)) throw new Error("Duplicate artifact");
  await ctx.db.insert("screenshotArtifacts", { tenantId, ...args });
} });
export const artifactUrl = queryGeneric({ args: { artifactId: v.string() }, handler: async (ctx, { artifactId }) => {
  const tenantId = await tenant(ctx);
  const artifact = (await ctx.db.query("screenshotArtifacts").withIndex("by_tenant_artifact", q => q.eq("tenantId", tenantId)).collect()).find(row => row.artifactId === artifactId);
  if (!artifact) throw new Error("Artifact unavailable");
  const snapshot = (await ctx.db.query("snapshots").withIndex("by_tenant", q => q.eq("tenantId", tenantId)).collect()).find(row => row.payload?.screenshot?.url === `/api/visual-audit/artifacts/${artifactId}`);
  if (!snapshot) throw new Error("Artifact has no tenant snapshot");
  return ctx.storage.getUrl(artifact.storageId);
} });
