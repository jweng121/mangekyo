import type { EvidenceAnnotation, EvidenceReference, ObservationField } from "@mangekyo/contracts";

export function fieldAnnotations(snapshotId: string, fields: ObservationField[], evidence: EvidenceReference[]): EvidenceAnnotation[] {
  const sourceIds = new Set(evidence.map(item => item.id));
  return fields.flatMap(field => field.sourceRef && sourceIds.has(field.sourceRef) ? [{ id: `${snapshotId}:${field.id}`, evidenceRef: field.sourceRef, snapshotId, label: field.label, fieldPath: `observation.fields.${field.id}` }] : []);
}
