import { NextRequest, NextResponse } from "next/server";
import { assertLocalAccess } from "../../../../lib/local-access";
import { readInvestigation, resolveEscalation, saveReport } from "../../../../lib/local-store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertLocalAccess(request);
    const { runId, conversationId, conversationTitle } = await request.json() as { runId?: string; conversationId?: string; conversationTitle?: string };
    if ((conversationId !== undefined && (typeof conversationId !== "string" || conversationId.length > 100)) || (conversationTitle !== undefined && (typeof conversationTitle !== "string" || conversationTitle.length > 80))) return NextResponse.json({ error: "Invalid conversation" }, { status: 400 });
    const record = await readInvestigation();
    const escalation = record.escalations.find(item => item.runId === runId && item.status === "open");
    const corrected = [...record.runs].reverse().find(item => item.parentRunId === runId && item.branchId === "corrected");
    const report = [...record.reports].reverse().find(item => item.runId === runId && item.correctedRunId === corrected?.id);
    if (!escalation || !corrected || corrected.status !== "corrected" || !report || record.findings.some(item => item.runId === corrected.id && item.reviewStatus === "open")) {
      return NextResponse.json({ error: "A completed, conflict-free corrected branch is required before approval" }, { status: 400 });
    }
    if (report.status !== "approved" && report.status !== "filed") {
      await saveReport({ ...report, version: report.version + 1, status: "approved", updatedAt: new Date().toISOString(), authorId: "local-demo-reviewer" });
    }
    const run = record.runs.find(item => item.id === runId)!;
    const agent = run.agentId === "deposit-matching-agent" ? "Matching Agent" : run.agentId.replaceAll(/[-_]/g, " ");
    await resolveEscalation(runId!, {
      id: `resolution-${escalation.id}`, runId: runId!, role: "assistant",
      text: `Marked as resolved. Your correction to ${agent}'s work has been approved, and this escalation is closed.`,
      snapshotIds: [], provider: "local", createdAt: new Date().toISOString(),
      conversationId: conversationId ?? "default", conversationTitle: conversationTitle ?? "Case review",
    });
    return NextResponse.json({ record: await readInvestigation() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
