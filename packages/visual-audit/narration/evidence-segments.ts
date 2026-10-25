import type { AuditFinding, ChatMessage, NarratedExplanation, NarrationSegment, Snapshot } from "@mangekyo/contracts";
import { resolveHighlights, validateNarratedExplanation } from "../annotations/highlight-resolver";

function groundedSegment(id: string, text: string, snapshot: Snapshot, fieldIds: string[]): NarrationSegment {
  const highlightIds = fieldIds.map(field => `${snapshot.id}:${field}`);
  const annotations = resolveHighlights(snapshot, highlightIds);
  if (annotations.length !== fieldIds.length) throw new Error(`Missing recorded annotation for ${id}`);
  return { id, text, snapshotId: snapshot.id, evidenceRefs: [...new Set(annotations.map(item => item.evidenceRef))], highlightIds, navigationTarget: { snapshotId: snapshot.id, evidenceRef: annotations[0]?.evidenceRef } };
}

export function buildIssueExplanation(messageId: string, finding: AuditFinding, snapshots: Snapshot[]): NarratedExplanation {
  const byId = (id: string) => {
    const snapshot = snapshots.find(item => item.id === id);
    if (!snapshot) throw new Error(`Missing issue evidence snapshot ${id}`);
    return snapshot;
  };
  if (finding.snapshotId !== "snapshot-original-maker") throw new Error("No synthetic issue narration for this finding.");
  const explanation: NarratedExplanation = { id: `explanation-${finding.id}`, messageId, segments: [
    groundedSegment("maker-proposal", "The matching maker proposed Client A using the invoice payer name. This was a proposal, not a financial write.", byId("snapshot-original-maker"), ["proposed-owner"]),
    groundedSegment("bank-reference", "The intake agent recorded payment reference B-204 on the five thousand dollar bank deposit.", byId("snapshot-original-bank"), ["bank-ref"]),
    groundedSegment("client-record", "The client record associates B-204 with Client B, which conflicts with the maker's proposed owner.", byId("snapshot-original-clients"), ["client-ref"]),
    groundedSegment("independent-check", "The independent checker also identified Client B from that reference. The discrepancy was escalated for human review.", byId("snapshot-original-checker"), ["checker-ref"]),
  ] };
  validateNarratedExplanation(explanation, snapshots);
  return explanation;
}

export function buildPlainExplanation(message: ChatMessage): NarratedExplanation {
  return { id: `explanation-${message.id}`, messageId: message.id, segments: [{ id: `${message.id}-spoken`, text: message.text, evidenceRefs: [], highlightIds: [] }] };
}
