import type { AgentEvent, EvidenceReference, Snapshot, StructuredObservation } from "@mangekyo/contracts";
import { fieldAnnotations } from "../annotations/evidence-annotations";

export const ORGANIZATION_ID = "harbor-trust-demo";
export const TASK_TYPE = "deposit_ownership";
export const DATA_CONTEXT = "ambiguous_deposit";
export const DEMO_TIME = "2026-10-23T12:00:00.000Z";

const bank: EvidenceReference = { id: "bank-1042", label: "Bank statement line 1042", source: "Harbor Trust Bank / October statement", field: "deposit", value: "$5,000" };
const invoice: EvidenceReference = { id: "invoice-88", label: "Invoice 88", source: "Client A invoice register", field: "payer name", value: "Client A" };
const reference: EvidenceReference = { id: "remit-1042", label: "Remittance reference", source: "Bank statement line 1042", field: "payment reference", value: "B-204 / Client B" };

type Step = {
  id: string;
  agent: string;
  role: string;
  action: AgentEvent["actionType"];
  title: string;
  summary: string;
  parents: string[];
  source: string;
  fields: StructuredObservation["fields"];
  evidence: EvidenceReference[];
  read?: string[];
  write?: string[];
  output?: Record<string, string>;
  changes?: StructuredObservation["changes"];
  audit?: Snapshot["auditStatus"];
  memoryRefs?: string[];
};

const steps: Step[] = [
  { id: "bank", agent: "intake", role: "Intake Agent", action: "READ", title: "Bank statement", summary: "Observed a $5,000 deposit with reference B-204.", parents: [], source: "Bank statement API (synthetic)", fields: [{ id: "amount", label: "Deposit amount", value: "$5,000", sourceRef: bank.id, emphasis: "read" }, { id: "bank-ref", label: "Payment reference", value: "B-204", sourceRef: reference.id, emphasis: "read" }], evidence: [bank, reference], read: ["bank statement line 1042"] },
  { id: "clients", agent: "intake", role: "Intake Agent", action: "READ", title: "Client records", summary: "Retrieved Client A invoice and Client B reference record.", parents: ["bank"], source: "Client record API (synthetic)", fields: [{ id: "invoice-name", label: "Invoice payer", value: "Client A", sourceRef: invoice.id, emphasis: "read" }, { id: "client-ref", label: "Client B payment code", value: "B-204", sourceRef: reference.id, emphasis: "read" }], evidence: [invoice, reference], read: ["invoice 88", "client reference index"] },
  { id: "maker", agent: "maker", role: "Matching Maker", action: "PROPOSE", title: "Ownership allocation", summary: "Proposed Client A from invoice name; did not resolve reference B-204.", parents: ["clients"], source: "Matching proposal (synthetic)", fields: [{ id: "proposed-owner", label: "Proposed owner", value: "Client A", sourceRef: invoice.id, emphasis: "modified" }, { id: "ignored-ref", label: "Unresolved reference", value: "B-204 / Client B", sourceRef: reference.id, emphasis: "conflict" }], evidence: [invoice, reference], read: ["invoice 88"], output: { proposedOwner: "Client A", status: "proposal only; no ledger write" }, audit: "flagged" },
  { id: "checker", agent: "checker", role: "Independent Checker", action: "DECISION", title: "Independent check", summary: "Matched payment reference B-204 to Client B without maker proposal context.", parents: ["clients"], source: "Checker evidence view (synthetic)", fields: [{ id: "checker-ref", label: "Payment reference", value: "B-204 / Client B", sourceRef: reference.id, emphasis: "conflict" }, { id: "checker-owner", label: "Checker conclusion", value: "Client B", sourceRef: reference.id, emphasis: "read" }], evidence: [reference], read: ["bank statement line 1042", "client reference index"], output: { independentlySuggestedOwner: "Client B" } },
  { id: "compare", agent: "orchestrator", role: "Orchestrator", action: "DECISION", title: "Conflicting conclusions", summary: "Maker proposed Client A; checker identified Client B. Allocation blocked.", parents: ["maker", "checker"], source: "Comparison (synthetic)", fields: [{ id: "maker-result", label: "Maker", value: "Client A", sourceRef: invoice.id, emphasis: "conflict" }, { id: "checker-result", label: "Checker", value: "Client B", sourceRef: reference.id, emphasis: "conflict" }], evidence: [invoice, reference], output: { status: "blocked; no posting" }, audit: "needs_review" },
  { id: "audit", agent: "mangekyo", role: "Mangekyo Auditor", action: "AUDIT", title: "Ownership conflict", summary: "Flagged the maker proposal at the earliest observable conflict.", parents: ["compare"], source: "Deterministic mock audit", fields: [{ id: "audit-conflict", label: "Conflict", value: "Invoice names Client A; reference identifies Client B", sourceRef: reference.id, emphasis: "conflict" }], evidence: [invoice, reference], audit: "flagged" },
  { id: "escalate", agent: "mangekyo", role: "Mangekyo Auditor", action: "ESCALATE", title: "Human review", summary: "Escalated conflicting ownership evidence before any financial write.", parents: ["audit"], source: "Deterministic mock escalation", fields: [{ id: "escalation-reason", label: "Reason", value: "Ownership ambiguity; human review required", sourceRef: reference.id, emphasis: "conflict" }], evidence: [invoice, reference], audit: "needs_review" },
];

export interface DemoStream { events: AgentEvent[]; snapshots: Snapshot[] }

export function createDemoStream(): DemoStream {
  const events: AgentEvent[] = [];
  const snapshots: Snapshot[] = [];
  steps.forEach((step, index) => {
    const sequence = index + 1;
    const timestamp = new Date(Date.parse(DEMO_TIME) + index * 1_000).toISOString();
    const id = `original-${step.id}`;
    events.push({ id, schemaVersion: 1, runId: "run-original", taskId: "deposit-1042", sequence, timestamp, agentId: step.agent, agentRole: step.role, actionType: step.action, title: step.title, summary: step.summary, parentEventIds: step.parents.map(parent => `original-${parent}`), branchId: "original", snapshotId: `snapshot-${id}`, status: "simulated" });
    snapshots.push({ id: `snapshot-${id}`, schemaVersion: 1, eventId: id, runId: "run-original", taskId: "deposit-1042", parentSnapshotId: step.parents[0] ? `snapshot-original-${step.parents[0]}` : undefined, agentId: step.agent, agentRole: step.role, timestamp, sequence, actionType: step.action, title: step.title, summary: step.summary, observation: { kind: "synthetic", label: step.source, fields: step.fields, input: step.id === "maker" ? { invoicePayer: "Client A", paymentReference: "B-204" } : undefined, output: step.output, changes: step.changes, toolInteractions: step.action === "READ" ? [{ tool: "Synthetic source adapter", request: `Read ${step.read?.join(", ") ?? step.source}`, response: step.summary }] : undefined }, source: step.source, readTargets: step.read ?? [], writeTargets: step.write ?? [], evidence: step.evidence, annotations: fieldAnnotations(`snapshot-${id}`, step.fields, step.evidence), instructionVersion: "demo-1", policyVersion: "demo-policy-1", executionStatus: "simulated", auditStatus: step.audit ?? "unreviewed", memoryRefs: step.memoryRefs });
  });
  return { events, snapshots };
}
