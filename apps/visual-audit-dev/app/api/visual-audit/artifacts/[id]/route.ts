import { NextRequest, NextResponse } from "next/server";
import { assertLocalAccess } from "../../../../../lib/local-access";
import { loadScreenshot } from "../../../../../lib/local-store";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertLocalAccess(request);
    const { id } = await context.params;
    const bytes = await loadScreenshot(id);
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return NextResponse.json({ error: "Screenshot unavailable" }, { status: 404 }); }
}
