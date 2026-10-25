import "server-only";
import type { NextRequest } from "next/server";

export function assertLocalAccess(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_VISUAL_AUDIT_MODE && !["local", "convex"].includes(process.env.NEXT_PUBLIC_VISUAL_AUDIT_MODE)) throw new Error("Unsupported audit storage mode");
  const hostname = new URL(request.url).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) throw new Error("Local demo access only");
}
