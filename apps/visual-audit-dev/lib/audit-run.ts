import "server-only";
import type { AgentEvent, AuditFinding, Escalation, InvestigationRun, Snapshot } from "../../../packages/contracts";
import { appendAudit, appendCheckpoint, readInvestigation } from "./local-store";

export async function auditCapturedRun(run: InvestigationRun) {
  const record = await readInvestigation();
  const snapshots = record.snapshots.filter(item => item.runId === run.id);
  const bank = snapshots.find(item => item.sequence === 1);
  const invoice = snapshots.find(item => item.sequence === 2);
  const customer = snapshots.find(item => item.sequence === 3);
  const proposal = snapshots.find(item => item.sequence === 4);
  if (!bank || !invoice || !customer || !proposal) throw new Error("Audit requires captured browser observations");
  const code = bank.observation.fields[0]?.value.split(" ")[0];
  const customerMatch = customer.observation.fields[0]?.value.startsWith(`${code} /`);
  const conflict = customerMatch && run.proposedOwner === invoice.observation.fields[0]?.value;
  const summary = conflict ? `The ${code} payment code matches the Client B record, while the agent proposed ${run.proposedOwner}.` : `The agent proposal ${run.proposedOwner} aligns with the captured ${code} customer record.`;
  const evidence = [...bank.evidence, ...invoice.evidence, ...customer.evidence, ...proposal.evidence];
  const timestamp = new Date().toISOString();
  const auditId = `${run.id}-event-6`;
  const auditSnapshotId = `${run.id}-snapshot-6`;
  const event: AgentEvent = { id: auditId, schemaVersion: 1, runId: run.id, taskId: run.taskId, sequence: 6, timestamp, agentId: "mangekyo-auditor", agentRole: "Mangekyo Auditor", actionType: "AUDIT", title: conflict ? "Conflicting evidence" : "Reference check", summary, parentEventIds: [`${run.id}-event-5`], branchId: run.branchId, snapshotId: auditSnapshotId, status: conflict ? "blocked" : "completed" };
  const snapshot: Snapshot = { id: auditSnapshotId, schemaVersion: 1, eventId: auditId, runId: run.id, taskId: run.taskId, parentSnapshotId: `${run.id}-snapshot-5`, agentId: "mangekyo-auditor", agentRole: "Mangekyo Auditor", timestamp, sequence: 6, actionType: "AUDIT", title: event.title, summary, observation: { kind: "api", label: "Deterministic audit of recorded browser values", fields: [{ id: "audit-result", label: "Comparison", value: summary, sourceRef: bank.evidence[0]?.id, emphasis: conflict ? "conflict" : "read" }], input: { bankReference: bank.observation.fields[0]?.value ?? "", invoicePayer: invoice.observation.fields[0]?.value ?? "", customerRecord: customer.observation.fields[0]?.value ?? "", proposedOwner: run.proposedOwner ?? "" }, output: { finding: conflict ? "ownership conflict" : "no conflict" } }, source: "Mangekyo deterministic auditor", readTargets: [bank.id, invoice.id, customer.id, proposal.id], writeTargets: [], evidence, instructionVersion: "auditor-local-1", policyVersion: "demo-no-posting-1", executionStatus: event.status, auditStatus: conflict ? "flagged" : "clear" };
  await appendCheckpoint(event, snapshot);
  if (!conflict) return;
  const finding: AuditFinding = { id: crypto.randomUUID(), schemaVersion: 1, runId: run.id, snapshotId: proposal.id, category: "ownership_conflict", severity: "high", explanation: summary, evidence, suggestedAction: "Review the bank reference and customer record, then steer the task agent before any finance approval.", reviewStatus: "open", reviewedThroughSequence: 5 };
  const escalationId = `${run.id}-event-7`;
  const escalationSnapshotId = `${run.id}-snapshot-7`;
  const escalationEvent: AgentEvent = { id: escalationId, schemaVersion: 1, runId: run.id, taskId: run.taskId, sequence: 7, timestamp: new Date().toISOString(), agentId: "review-queue", agentRole: "Human Review Queue", actionType: "ESCALATE", title: "Human ownership review", summary: "Stopped at a draft allocation pending human investigation.", parentEventIds: [auditId], branchId: run.branchId, snapshotId: escalationSnapshotId, status: "blocked" };
  const escalationSnapshot: Snapshot = { ...snapshot, id: escalationSnapshotId, eventId: escalationId, parentSnapshotId: auditSnapshotId, agentId: "review-queue", agentRole: "Human Review Queue", timestamp: escalationEvent.timestamp, sequence: 7, actionType: "ESCALATE", title: escalationEvent.title, summary: escalationEvent.summary, observation: { ...snapshot.observation, output: { status: "human review required", financialPosting: "none" } }, executionStatus: "blocked", auditStatus: "needs_review" };
  await appendCheckpoint(escalationEvent, escalationSnapshot);
  const escalation: Escalation = { id: crypto.randomUUID(), findingId: finding.id, snapshotId: proposal.id, runId: run.id, status: "open", createdAt: escalationEvent.timestamp };
  await appendAudit(finding, escalation);
}
