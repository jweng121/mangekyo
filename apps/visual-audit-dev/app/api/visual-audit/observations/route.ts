import { NextRequest, NextResponse } from "next/server";
import type { AgentEvent, StructuredObservation } from "../../../../../../packages/contracts";
import { captureStructuredCheckpoint, createMonitoredRun } from "../../../../lib/capture-agent";
import { assertLocalAccess } from "../../../../lib/local-access";
import { localTenantId, readInvestigation, updateRun } from "../../../../lib/local-store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertLocalAccess(request);
    const body = await request.json() as {
      action?: "start" | "structured" | "finish"; runId?: string; taskId?: string; agentId?: string; status?: "completed" | "escalated" | "failed";
      sequence?: number; actionType?: AgentEvent["actionType"]; title?: string; summary?: string;
      documentId?: string; documentVersion?: string; observation?: Omit<StructuredObservation, "kind">;
      toolCall?: string; toolResponse?: string; recordedJustification?: string;
    };
    if (body.action === "start") {
      if (!body.taskId || !body.agentId || body.taskId.length > 200 || body.agentId.length > 200) return NextResponse.json({ error: "Agent and task IDs are required" }, { status: 400 });
      const run = await createMonitoredRun({ tenantId: localTenantId(), taskId: body.taskId, agentId: body.agentId });
      return NextResponse.json({ run }, { status: 201 });
    }
    if (body.action === "finish") {
      const run = (await readInvestigation()).runs.find(item => item.id === body.runId && item.status === "running");
      if (!run || !body.status || !["completed", "escalated", "failed"].includes(body.status)) return NextResponse.json({ error: "Active run and valid finish status are required" }, { status: 400 });
      await updateRun(run.id, { status: body.status, proposedOwner: run.proposedOwner });
      return NextResponse.json({ run: { ...run, status: body.status } });
    }
    if (body.action !== "structured") return NextResponse.json({ error: "Unknown observation action" }, { status: 400 });
    const run = (await readInvestigation()).runs.find(item => item.id === body.runId && item.status === "running");
    if (!run) return NextResponse.json({ error: "Active run not found" }, { status: 404 });
    if (!body.sequence || !body.actionType || !body.title || !body.summary || !body.documentId || !body.documentVersion || !body.observation || !Array.isArray(body.observation.fields) || !body.toolCall || !body.toolResponse) return NextResponse.json({ error: "Incomplete structured checkpoint" }, { status: 400 });
    if ([body.title, body.summary, body.documentId, body.documentVersion, body.toolCall, body.toolResponse].some(value => value.length > 4000) || body.observation.fields.length > 100) return NextResponse.json({ error: "Observation exceeds limit" }, { status: 400 });
    const snapshot = await captureStructuredCheckpoint({ run, sequence: body.sequence, actionType: body.actionType, title: body.title, summary: body.summary, documentId: body.documentId, documentVersion: body.documentVersion, observation: body.observation, toolCall: body.toolCall, toolResponse: body.toolResponse, recordedJustification: body.recordedJustification });
    return NextResponse.json({ snapshot }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
}
