export interface EvidenceAnnotation {
  id: string;
  evidenceRef: string;
  snapshotId: string;
  label: string;
  fieldPath?: string;
  pageNumber?: number;
  textQuote?: string;
  /** Coordinates are normalized to 0..1 and require recorded source geometry. */
  region?: { x: number; y: number; width: number; height: number };
}

export interface NarrationSegment {
  id: string;
  text: string;
  snapshotId?: string;
  evidenceRefs: string[];
  highlightIds: string[];
  navigationTarget?: { snapshotId: string; evidenceRef?: string };
}

export interface NarratedExplanation {
  id: string;
  messageId: string;
  segments: NarrationSegment[];
}
