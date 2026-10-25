import type { EvidenceAnnotation, NarratedExplanation, Snapshot } from "@mangekyo/contracts";

export function resolveAnnotation(snapshot: Snapshot, annotation: EvidenceAnnotation): EvidenceAnnotation | undefined {
  if (annotation.snapshotId !== snapshot.id || !snapshot.evidence.some(item => item.id === annotation.evidenceRef)) return undefined;
  if (annotation.fieldPath) {
    const fieldId = annotation.fieldPath.startsWith("observation.fields.") ? annotation.fieldPath.slice("observation.fields.".length) : "";
    if (!snapshot.observation.fields.some(field => field.id === fieldId && field.sourceRef === annotation.evidenceRef)) return undefined;
  }
  if (annotation.textQuote && !snapshot.observation.documentText?.includes(annotation.textQuote)) return undefined;
  if (annotation.region) {
    const { x, y, width, height } = annotation.region;
    if (!snapshot.screenshot || [x, y, width, height].some(value => !Number.isFinite(value)) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return undefined;
  }
  if (!annotation.fieldPath && !annotation.textQuote && !annotation.region) return undefined;
  return annotation;
}

export function resolveHighlights(snapshot: Snapshot, ids: string[]): EvidenceAnnotation[] {
  const selected = new Set(ids);
  return (snapshot.annotations ?? []).filter(annotation => selected.has(annotation.id) && resolveAnnotation(snapshot, annotation));
}

export function validateNarratedExplanation(explanation: NarratedExplanation, snapshots: Snapshot[]): void {
  for (const segment of explanation.segments) {
    if (!segment.text.trim()) throw new Error(`Empty narration segment ${segment.id}`);
    if (!segment.snapshotId) {
      if (segment.evidenceRefs.length || segment.highlightIds.length || segment.navigationTarget) throw new Error(`Ungrounded narration segment ${segment.id}`);
      continue;
    }
    const snapshot = snapshots.find(item => item.id === segment.snapshotId);
    if (!snapshot) throw new Error(`Missing snapshot ${segment.snapshotId}`);
    for (const ref of segment.evidenceRefs) if (!snapshot.evidence.some(item => item.id === ref)) throw new Error(`Unknown evidence ${ref}`);
    const highlights = resolveHighlights(snapshot, segment.highlightIds);
    if (highlights.length !== segment.highlightIds.length) throw new Error(`Unknown highlight in ${segment.id}`);
    if (highlights.some(item => !segment.evidenceRefs.includes(item.evidenceRef))) throw new Error(`Highlight is not cited in ${segment.id}`);
    if (segment.navigationTarget && (segment.navigationTarget.snapshotId !== snapshot.id || (segment.navigationTarget.evidenceRef && !segment.evidenceRefs.includes(segment.navigationTarget.evidenceRef)))) throw new Error(`Invalid navigation target in ${segment.id}`);
  }
}
