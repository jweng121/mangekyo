import { NextRequest, NextResponse } from "next/server";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { InvestigationRecord } from "../../../../../../packages/contracts";
import { assertLocalAccess } from "../../../../lib/local-access";
import { readInvestigation } from "../../../../lib/local-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try { assertLocalAccess(request); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 403 }); }
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let last = "";
      const send = (record: InvestigationRecord) => {
        if (closed) return;
        const value = JSON.stringify(record);
        if (value === last) return;
        last = value;
        controller.enqueue(encoder.encode(`data: ${value}\n\n`));
      };
      const close = () => { if (closed) return; closed = true; cleanup(); try { controller.close(); } catch {} };
      request.signal.addEventListener("abort", close, { once: true });
      const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": ping\n\n")); }, 15000);
      if (process.env.NEXT_PUBLIC_VISUAL_AUDIT_MODE === "convex") {
        const url = process.env.NEXT_PUBLIC_CONVEX_URL;
        const token = process.env.MANGEKYO_CONVEX_AUTH_TOKEN;
        if (!url || !token) { controller.error(new Error("Convex subscription credentials missing")); clearInterval(heartbeat); return; }
        const convex = new ConvexClient(url);
        convex.setAuth(async () => token);
        const reference = makeFunctionReference<"query", Record<string, unknown>, InvestigationRecord>("investigations:list");
        const unsubscribe = convex.onUpdate(reference, {}, send, error => { if (!closed) controller.error(error); });
        cleanup = () => { clearInterval(heartbeat); unsubscribe(); void convex.close(); };
      } else {
        void readInvestigation().then(send).catch(error => { if (!closed) controller.error(error); });
        const polling = setInterval(() => { void readInvestigation().then(send).catch(() => {}); }, 1500);
        cleanup = () => { clearInterval(heartbeat); clearInterval(polling); };
      }
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
