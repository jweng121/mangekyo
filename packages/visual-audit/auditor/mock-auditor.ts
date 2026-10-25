import type { AgentEvent, AuditRequest, AuditResult, Snapshot } from "@mangekyo/contracts";

export function runMockAudit(request: AuditRequest, events: AgentEvent[], snapshots: Snapshot[]): AuditResult {
  const relevant = events.filter(event => event.runId === request.runId && event.sequence <= request.throughSequence);
  const maker = relevant.find(event => event.id === "original-maker");
  const checker = relevant.find(event => event.id === "original-checker");
  if (!maker || !checker) return { outcome: "insufficient_evidence", reviewedThroughSequence: request.throughSequence, findings: [] };
  const makerSnapshot = snapshots.find(snapshot => snapshot.id === maker.snapshotId);
  const checkerSnapshot = snapshots.find(snapshot => snapshot.id === checker.snapshotId);
  if (!makerSnapshot || !checkerSnapshot) return { outcome: "insufficient_evidence", reviewedThroughSequence: request.throughSequence, findings: [] };
  const proposed = makerSnapshot.observation.output?.proposedOwner;
  const checked = checkerSnapshot.observation.output?.independentlySuggestedOwner;
  if (!proposed || !checked) return { outcome: "insufficient_evidence", reviewedThroughSequence: request.throughSequence, findings: [] };
  if (proposed === checked) return { outcome: "no_findings", reviewedThroughSequence: request.throughSequence, findings: [] };
  return { outcome: "needs_review", reviewedThroughSequence: request.throughSequence, findings: [{ id: "finding-ownership-1042", schemaVersion: 1, runId: request.runId, snapshotId: makerSnapshot.id, category: "ownership_conflict", severity: "high", explanation: `Maker proposed ${proposed}, but the independent checker identified ${checked} from payment reference B-204. No financial write was made.`, evidence: makerSnapshot.evidence, suggestedAction: "Review payment reference and steer from the maker proposal checkpoint.", reviewStatus: "open", reviewedThroughSequence: request.throughSequence }] };
}
