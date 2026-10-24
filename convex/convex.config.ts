import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    FINANCE_AGENT_MODE: v.optional(v.string()),
    CREAO_APP_ID: v.optional(v.string()),
    CREAO_API_KEY: v.optional(v.string()),
    AUTO_INVESTIGATE: v.optional(v.string()),
    OUTSTANDING_MAX_DAYS: v.optional(v.string()),
    // Agent 2's model part: mock (default) or creao. The code part always runs.
    CHECKER_MODE: v.optional(v.string()),
    CREAO_CHECKER_APP_ID: v.optional(v.string()),
    // App-scoped key for the checker agent; falls back to CREAO_API_KEY when unset.
    CREAO_CHECKER_API_KEY: v.optional(v.string()),
    PROVIDER_TIMEOUT_MS: v.optional(v.string()),
    MAX_REAL_RUNS_PER_DAY: v.optional(v.string()),
    MAX_REAL_RUNS_PER_DEPOSIT: v.optional(v.string()),
    // Mock mode only: network_once | network_always | hang | invalid_output. Leave unset outside tests and demos.
    MOCK_PROVIDER_FAULT: v.optional(v.string()),
  },
});
