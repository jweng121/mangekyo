"use client";
import type { NarratedExplanation as Explanation, Snapshot } from "@mangekyo/contracts";

export function NarratedExplanation({ explanation, snapshots, activeSegmentIndex, onSelect }: { explanation: Explanation; snapshots: Snapshot[]; activeSegmentIndex?: number; onSelect: (index: number) => void }) {
  return <div className="narration-segments" aria-label="Evidence-linked explanation">{explanation.segments.map((segment, index) => {
    const snapshot = snapshots.find(item => item.id === segment.snapshotId);
    return <button type="button" key={segment.id} className={`narration-segment ${activeSegmentIndex === index ? "active" : ""}`} onClick={() => onSelect(index)}><span className="segment-index">{String(index + 1).padStart(2, "0")}</span><span><strong>{segment.text}</strong><small>{snapshot ? `${snapshot.agentRole} · ${snapshot.title}` : "Written explanation"}{segment.evidenceRefs.length ? ` · ${segment.evidenceRefs.join(", ")}` : ""}</small></span></button>;
  })}</div>;
}
