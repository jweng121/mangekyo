import { NextRequest, NextResponse } from "next/server";
import type { InvestigationReport, SteeringRequest } from "../../../../../packages/contracts";
import { correctSettlement } from "../../../lib/erp-demo";
import { runBrowserAgent } from "../../../lib/capture-agent";
import { auditCapturedRun } from "../../../lib/audit-run";
import { assertLocalAccess } from "../../../lib/local-access";
import { addSteering, approvedMemoryForDemo, readInvestigation, saveReport } from "../../../lib/local-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let running = false;

export async function GET(request: NextRequest) {
  try { assertLocalAccess(request); return NextResponse.json(await readInvestigation(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 403 }); }
}

export async function POST(request: NextRequest) {
  try {
    assertLocalAccess(request);
    if (running) return NextResponse.json({ error: "A browser run is already active" }, { status: 409 });
    const body = await request.json() as { action?: string; title?: string; snapshotId?: string; instruction?: string; scope?: SteeringRequest["scope"] };
    if (body.action !== "start" && body.action !== "steer" && body.action !== "future") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    running = true;
    try {
      if (body.action === "start") {
        const run = await runBrowserAgent(request.nextUrl.origin, undefined, undefined, typeof body.title === "string" ? body.title.slice(0, 100) : "PDF + database / Trust allocation");
        await auditCapturedRun(run);
        return NextResponse.json({ run, record: await readInvestigation() });
      }
      if (body.action === "future") {
        const memory = await approvedMemoryForDemo();
        if (!memory) return NextResponse.json({ error: "No approved scoped memory is available" }, { status: 400 });
        const run = await runBrowserAgent(request.nextUrl.origin, undefined, memory);
        await auditCapturedRun(run);
        return NextResponse.json({ run, record: await readInvestigation() });
      }
      const record = await readInvestigation();
      const source = record.snapshots.find(snapshot => snapshot.id === body.snapshotId);
      const parent = source && record.runs.find(run => run.id === source.runId);
      if (!source || !parent || parent.status !== "escalated" || source.actionType !== "PROPOSE") return NextResponse.json({ error: "Select the escalated proposal checkpoint" }, { status: 400 });
      if (parent.agentId === "trust-compliance-auditor") return NextResponse.json({ error: "The ownership lock cannot be overridden. Add cleared Hayes funds or reduce the request, then submit a new payment." }, { status: 400 });
      const instruction = body.instruction?.trim() ?? "";
      if (instruction.length < 12 || instruction.length > 2000) return NextResponse.json({ error: "Correction must be 12 to 2000 characters" }, { status: 400 });
      const steering: SteeringRequest = { id: crypto.randomUUID(), schemaVersion: 1, parentRunId: parent.id, checkpointSnapshotId: source.id, instruction, evidenceIds: source.evidence.map(item => item.id), actorId: "local-demo-reviewer", createdAt: new Date().toISOString(), scope: body.scope === "checkpoint" ? "checkpoint" : "dependent_work", status: "submitted" };
      await addSteering(steering);
      if(parent.taskId.startsWith("hartwell-"))return NextResponse.json(await correctSettlement(parent,steering));
      const corrected = await runBrowserAgent(request.nextUrl.origin, steering);
      await auditCapturedRun(corrected);
      const updated = await readInvestigation();
      const snapshots = updated.snapshots.filter(snapshot => snapshot.runId === corrected.id);
      const report: InvestigationReport = {
        id: crypto.randomUUID(), version: 1, runId: parent.id, correctedRunId: corrected.id, taskId: parent.taskId, agentId: parent.agentId,
        escalationSnapshotId: source.id, steeringRequestId: steering.id, status: "draft", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), authorId: "mangekyo-local-auditor",
        content: `Agent: ${parent.agentId}.\nTask: allocate bank line 1042 ($5,000).\nEscalation trigger: invoice INV-88 names Client A while bank reference B-204 and customer ownership identify Client B.\nEvidence inspected: bank statement PDF, funding instruction PDF, SQLite client lookup, draft selector, and confirmed database result; corrected run reread the sources and saved its changes.\nSuspected mistake: invoice-first matching despite a conflicting payment code.\nOriginal decision: ${parent.proposedOwner}; proposal only, no ledger write.\nHuman corrective instruction: ${instruction}\nCorrected execution: new Chromium run ${corrected.id} proposed ${corrected.proposedOwner}.\nBranch comparison: original ${parent.proposedOwner}, corrected ${corrected.proposedOwner}.\nRelevant snapshots: ${source.id}; ${snapshots.map(snapshot => snapshot.id).join(", ")}.\nRemaining uncertainty: synthetic records only; no external bank or ledger verification.\nResolution: ${corrected.proposedOwner === "Client B" ? "Reference-aligned proposal; pending reviewer approval." : "Still unresolved; review instructions and evidence."}\nRecommended follow-up: verify source records and approve through the finance gateway separately.`,
        evidenceSnapshotIds: [source.id, ...snapshots.map(snapshot => snapshot.id)], remainingUncertainty: "Synthetic records only; no external bank or ledger verification.",
      };
      await saveReport(report);
      return NextResponse.json({ steering, corrected, report, record: await readInvestigation() });
    } finally { running = false; }
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 500 }); }
}
