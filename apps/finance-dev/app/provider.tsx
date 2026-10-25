"use client";

import { useState, type ReactNode } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";

export function FinanceProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const url = process.env.NEXT_PUBLIC_PLATFORM_CONVEX_URL;
    return url ? new ConvexReactClient(url) : null;
  });
  if (!client) {
    return <main className="platform-config"><img src="/mangekyo-logo.png" alt="" width={52} height={52}/><h1>Connect your workspace</h1><p>Add the platform's public Convex URL to the app's local environment, then restart the app.</p><code>NEXT_PUBLIC_PLATFORM_CONVEX_URL</code><p>Your agent connection stays separate.</p><a href="/examples">Open local examples</a></main>;
  }
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
