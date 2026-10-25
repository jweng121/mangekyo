import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const record = defineTable({ tenantId: v.string(), itemId: v.string(), runId: v.string(), payload: v.any() })
  .index("by_tenant", ["tenantId"])
  .index("by_tenant_item", ["tenantId", "itemId"])
  .index("by_tenant_run", ["tenantId", "runId"]);

export default defineSchema({
  runs: record,
  events: record,
  snapshots: record,
  auditFindings: record,
  escalations: record,
  steeringRequests: record,
  executionBranches: record,
  chatMessages: record,
  investigationReports: record,
  memoryRecords: record,
  screenshotArtifacts: defineTable({ tenantId: v.string(), artifactId: v.string(), storageId: v.id("_storage") }).index("by_tenant_artifact", ["tenantId", "artifactId"]),
});
