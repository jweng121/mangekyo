"use client";

import { useState, type ReactNode } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";

export function FinanceProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    return url ? new ConvexReactClient(url) : null;
  });
  if (!client) {
    return <main><h1>Finance development</h1><p role="alert">
      Set NEXT_PUBLIC_CONVEX_URL in apps/finance-dev/.env.local using .env.example, then restart the app.
    </p></main>;
  }
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
