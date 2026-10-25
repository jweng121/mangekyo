import { test } from "node:test";
import assert from "node:assert/strict";
import type { InvestigationRecord, Snapshot } from "@mangekyo/contracts";
import { validatedFocus, visualActionsForQuestion } from "../chat/visual-actions";

const make = (id: string, title: string): Snapshot => ({
  id, schemaVersion: 1, eventId: `${id}-event`, runId: "run-1", taskId: "task-1", agentId: "agent-1", agentRole: "Matching Agent", timestamp: "2026-10-24T00:00:00Z", sequence: Number(id.at(-1)), actionType: "READ", title, summary: title, observation: { kind: "browser", label: title, fields: [{ id: "value", label: "Value", value: title, sourceRef: `${id}-evidence` }] }, source: title, readTargets: [title], writeTargets: [], evidence: [{ id: `${id}-evidence`, label: title, source: title, value: title }], annotations: [{ id: `${id}-highlight`, evidenceRef: `${id}-evidence`, snapshotId: id, label: title, fieldPath: "observation.fields.value" }], instructionVersion: "1", policyVersion: "1", executionStatus: "completed", auditStatus: "unreviewed"
});
const bank = make("snapshot-1", "Bank payment reference");
const invoice = make("snapshot-2", "Invoice payer");
const customer = make("snapshot-3", "Customer record");
const record: InvestigationRecord = { runs: [], events: [], snapshots: [bank, invoice, customer], steeringRequests: [], reports: [], chatMessages: [], memoryRecords: [], findings: [], escalations: [] };

test("visual questions resolve to actual captured evidence IDs", () => {
  const action = visualActionsForQuestion("Show me the original bank statement", invoice, record)[0];
  assert.equal(action.kind, "focus_snapshot");
  assert.equal(validatedFocus(action, record, new Set(["run-1"]))?.id, bank.id);
  assert.equal(visualActionsForQuestion("Where did Client A come from?", bank, record)[0].kind, "focus_snapshot");
  assert.equal(visualActionsForQuestion("How did the error happen?", bank, record)[0].kind, "walkthrough");
});

test("visual navigation rejects invented evidence and cross-run targets", () => {
  assert.equal(validatedFocus({ kind: "focus_snapshot", snapshotId: bank.id, evidenceIds: ["invented"] }, record, new Set(["run-1"])), undefined);
  assert.equal(validatedFocus({ kind: "focus_snapshot", snapshotId: bank.id, evidenceIds: [bank.evidence[0].id] }, record, new Set(["another-run"])), undefined);
});
