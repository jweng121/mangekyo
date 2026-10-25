import { NextRequest, NextResponse } from "next/server";
import type { InvestigationReport } from "../../../../../../packages/contracts";
import { assertLocalAccess } from "../../../../lib/local-access";
import { readInvestigation, saveReport } from "../../../../lib/local-store";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    assertLocalAccess(request);
    const body = await request.json() as { id?: string; content?: string; status?: InvestigationReport["status"] };
    const record = await readInvestigation();
    const prior = record.reports.filter(item => item.id === body.id).at(-1);
    if (!prior) return NextResponse.json({ error: "Report not found" }, { status: 404 });
    const allowed: Record<InvestigationReport["status"], InvestigationReport["status"][]> = { draft: ["draft", "pending_review"], pending_review: ["pending_review", "approved"], approved: ["approved", "filed"], filed: [] };
    const status = body.status ?? prior.status;
    if (!allowed[prior.status].includes(status)) return NextResponse.json({ error: "Invalid report transition" }, { status: 400 });
    const content = body.content?.trim() ?? prior.content;
    if (content.length < 50 || content.length > 20_000) return NextResponse.json({ error: "Report content must be 50 to 20,000 characters" }, { status: 400 });
    const next: InvestigationReport = { ...prior, version: prior.version + 1, content, status, updatedAt: new Date().toISOString(), authorId: "local-demo-reviewer" };
    await saveReport(next);
    return NextResponse.json({ report: next, record: await readInvestigation() });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 500 }); }
}
