import { NextRequest, NextResponse } from "next/server";
import type { MemoryEntry } from "../../../../../../packages/contracts";
import { assertLocalAccess } from "../../../../lib/local-access";
import { appendMemory, localTenantId, readInvestigation } from "../../../../lib/local-store";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    assertLocalAccess(request);
    const body = await request.json() as { action?: "propose" | "approve"; reportId?: string; memoryId?: string; content?: string };
    const record = await readInvestigation();
    let memory: MemoryEntry;
    if (body.action === "propose") {
      const report = record.reports.filter(item => item.id === body.reportId).at(-1);
      if (!report || report.status !== "filed") return NextResponse.json({ error: "File the approved report before proposing memory" }, { status: 400 });
      if (record.memoryRecords.some(item => item.sourceReportId === report.id)) return NextResponse.json({ error: "A lesson already exists for this report" }, { status: 409 });
      const source = record.snapshots.find(item => item.id === report.escalationSnapshotId);
      if (!source) throw new Error("Report source snapshot missing");
      const content = body.content?.trim() || "For ambiguous deposits, verify the bank payment reference against the customer ownership record before proposing an owner. Treat invoice amount matches as supporting evidence only.";
      if (content.length < 30 || content.length > 2000) return NextResponse.json({ error: "Lesson must be 30 to 2000 characters" }, { status: 400 });
      memory = { id: crypto.randomUUID(), schemaVersion: 1, title: "Verify payment reference before allocation", content, type: "procedural", agentRole: "Deposit Matching Agent", organizationId: localTenantId(), taskType: "deposit_ownership", dataContext: "ambiguous_deposit", sourceRunId: report.runId, sourceSnapshotId: source.id, sourceCorrectionId: report.steeringRequestId, sourceReportId: report.id, evidence: source.evidence, createdBy: "local-demo-reviewer", createdAt: new Date().toISOString(), status: "pending", version: 1 };
    } else if (body.action === "approve") {
      const prior = record.memoryRecords.filter(item => item.id === body.memoryId).at(-1);
      if (!prior || prior.status !== "pending") return NextResponse.json({ error: "Pending lesson not found" }, { status: 400 });
      const content = body.content?.trim() || prior.content;
      if (content.length < 30 || content.length > 2000) return NextResponse.json({ error: "Lesson must be 30 to 2000 characters" }, { status: 400 });
      memory = { ...prior, content, status: "approved", version: prior.version + 1, approvedBy: "local-demo-reviewer", approvedAt: new Date().toISOString() };
    } else return NextResponse.json({ error: "Unknown memory action" }, { status: 400 });
    await appendMemory(memory);
    return NextResponse.json({ memory, record: await readInvestigation() });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 500 }); }
}
