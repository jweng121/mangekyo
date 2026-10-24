import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "edge-runtime", include: ["convex/**/*.test.ts", "packages/finance-core/tests/**/*.test.ts"] },
});
