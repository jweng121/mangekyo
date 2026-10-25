import { NextRequest, NextResponse } from "next/server";
import { assertLocalAccess } from "../../../../../lib/local-access";
import { readPdf } from "../../../../../lib/pdf-evidence";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    assertLocalAccess(request);
    if (Number(request.headers.get("content-length") ?? 0) > 21 * 1024 * 1024) return NextResponse.json({ error: "PDF exceeds 20 MB" }, { status: 413 });
    const form = await request.formData(), file = form.get("file"), quote = form.get("quote"), pageNumber = Number(form.get("pageNumber") ?? 1);
    if (!(file instanceof File) || file.size > 20 * 1024 * 1024 || !Number.isInteger(pageNumber) || pageNumber < 1 || typeof quote === "string" && quote.length > 500) return NextResponse.json({ error: "Provide a PDF up to 20 MB and a valid page number" }, { status: 400 });
    const pattern = typeof quote === "string" && quote ? quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : undefined;
    const result = await readPdf(Buffer.from(await file.arrayBuffer()), pageNumber, pattern);
    return NextResponse.json({ ...result, filename: file.name }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 422 }); }
}
