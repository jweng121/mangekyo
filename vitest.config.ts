import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "finance", environment: "edge-runtime", include: ["convex/**/*.test.ts", "packages/finance-core/tests/**/*.test.ts"] } },
      { test: { name: "demo-erp", environment: "node", include: ["tests/*.test.ts"] } },
    ],
  },
});
