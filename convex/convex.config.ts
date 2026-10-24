import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    FINANCE_AGENT_MODE: v.optional(v.string()),
    CREAO_APP_ID: v.optional(v.string()),
    CREAO_API_KEY: v.optional(v.string()),
    AUTO_INVESTIGATE: v.optional(v.string()),
    OUTSTANDING_MAX_DAYS: v.optional(v.string()),
  },
});
