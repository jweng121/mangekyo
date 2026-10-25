import type { AgentEvent, MemoryEntry, Snapshot } from "@mangekyo/contracts";
import { DATA_CONTEXT, DEMO_TIME, ORGANIZATION_ID, TASK_TYPE } from "./mock-events";
import { createLocalMemoryContextAdapter } from "./memory-context";

export function simulateFutureRun(entries: MemoryEntry[]): { events: AgentEvent[]; snapshots: Snapshot[]; memoryId: string } {
  const context = createLocalMemoryContextAdapter(entries).getApprovedContext({ organizationId: ORGANIZATION_ID, agentRole: "Matching Maker", taskType: TASK_TYPE, dataContext: DATA_CONTEXT });
  const memory = context.entries[0];
  if (!memory) throw new Error("No approved applicable memory is available.");
  const specs = [
    { id: "new-bank", action: "READ" as const, agent: "intake", role: "Intake Agent", title: "New ambiguous deposit", summary: "Observed a $3,200 deposit with reference B-305 and an invoice for Client A.", fields: [{ id: "deposit", label: "Deposit", value: "$3,200" }, { id: "new-ref", label: "Payment reference", value: "B-305" }] },
    { id: "memory", action: "READ" as const, agent: "maker", role: "Matching Maker", title: "Approved lesson retrieved", summary: `Retrieved approved ${memory.id} v${memory.version} as task guidance.`, fields: [{ id: "lesson", label: "Guidance", value: memory.content, emphasis: "memory" as const }] },
    { id: "investigate", action: "DECISION" as const, agent: "maker", role: "Matching Maker", title: "Investigate ownership", summary: "Following the approved lesson, the maker flags the conflict for more evidence before allocation.", fields: [{ id: "decision", label: "Decision", value: "Request additional ownership evidence", emphasis: "memory" as const }] },
  ];
  const events: AgentEvent[] = [];
  const snapshots: Snapshot[] = [];
  specs.forEach((spec, index) => {
    const id = `future-${spec.id}`;
    const timestamp = new Date(Date.parse(DEMO_TIME) + (40 + index) * 1_000).toISOString();
    events.push({ id, schemaVersion: 1, runId: "run-future", taskId: "deposit-305", sequence: index + 1, timestamp, agentId: spec.agent, agentRole: spec.role, actionType: spec.action, title: spec.title, summary: spec.summary, parentEventIds: index ? [events[index - 1].id] : [], branchId: "future", snapshotId: `snapshot-${id}`, status: "simulated" });
    snapshots.push({ id: `snapshot-${id}`, schemaVersion: 1, eventId: id, runId: "run-future", taskId: "deposit-305", parentSnapshotId: index ? snapshots[index - 1].id : undefined, agentId: spec.agent, agentRole: spec.role, timestamp, sequence: index + 1, actionType: spec.action, title: spec.title, summary: spec.summary, observation: { kind: "synthetic", label: "Second synthetic deposit case", fields: spec.fields }, source: "Simulated future-run adapter", readTargets: index === 1 ? [`approved memory ${memory.id}`] : [], writeTargets: [], evidence: [{ id: "future-reference", label: "New payment reference", source: "Synthetic bank statement", field: "reference", value: "B-305" }], instructionVersion: "demo-1", policyVersion: "demo-policy-1", executionStatus: "simulated", auditStatus: "unreviewed", memoryRefs: index ? [memory.id] : [] });
  });
  return { events, snapshots, memoryId: memory.id };
}
