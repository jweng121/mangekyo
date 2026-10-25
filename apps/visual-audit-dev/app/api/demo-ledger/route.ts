import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { assertLocalAccess } from "../../../lib/local-access";
import { artifactDirectory } from "../../../lib/local-store";
import { evidenceWorker } from "../../../lib/evidence-worker";
export const runtime = "nodejs";
const databasePath = () => path.join(artifactDirectory(), "..", "trust-ledger.sqlite");
export async function GET(request: NextRequest) {
  try { assertLocalAccess(request); return NextResponse.json(await evidenceWorker({ action: "read", databasePath: databasePath(), paymentCode: request.nextUrl.searchParams.get("paymentCode") })); }
  catch { return NextResponse.json({ error: "Unable to read the demo client register" }, { status: 500 }); }
}
async function write(request: NextRequest, action: "insert" | "update") {
  try {
    assertLocalAccess(request);
    const { owner, bankLine, draftId } = await request.json();
    if (typeof owner !== "string" || owner.length > 80 || bankLine !== "1042" || action === "update" && (typeof draftId !== "string" || !/^AL-[0-9a-f-]{36}$/.test(draftId))) return NextResponse.json({ error: "Invalid allocation" }, { status: 400 });
    return NextResponse.json(await evidenceWorker({ action, owner, bankLine, draftId, databasePath: databasePath() }));
  } catch { return NextResponse.json({ error: "The allocation draft could not be saved" }, { status: 500 }); }
}
export const POST = (request: NextRequest) => write(request, "insert");
export const PATCH = (request: NextRequest) => write(request, "update");
