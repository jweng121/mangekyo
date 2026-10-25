import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { demoPdfPath } from "../../../../lib/pdf-evidence";
import { assertLocalAccess } from "../../../../lib/local-access";
export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  try { assertLocalAccess(request); const { name } = await context.params; if (name !== "bank" && name !== "funding") return new NextResponse(null, { status: 404 }); const data = await readFile(demoPdfPath(name)); return new NextResponse(new Uint8Array(data), { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: "Demo PDF unavailable" }, { status: 404 }); }
}
