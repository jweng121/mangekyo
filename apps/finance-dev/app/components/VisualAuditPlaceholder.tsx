"use client";

/**
 * Handoff point for the visual-audit package (see docs/visual-audit-handoff.md).
 * Replace this component's body with the captured view; keep the props.
 */
export interface VisualAuditFrameProps {
  /** Investigation run, e.g. "intake:demo:account:pool-004:deposit:demo:run-004:bank:txn:A-001:investigation:1". */
  runId: string;
  /** Zero-based index into the run's ordered steps (events with the same runId, by sequence). */
  stepIndex: number;
  /** Snapshot saved atomically with that step's event, or null if the step has none. */
  snapshotId: string | null;
}

export function VisualAuditPlaceholder({ runId, stepIndex, snapshotId }: VisualAuditFrameProps) {
  return <div className="shot" role="img" aria-label="Placeholder for the captured agent view" data-run-id={runId} data-step-index={stepIndex} data-snapshot-id={snapshotId ?? ""}>
    <img src="/mangekyo-logo.png" alt="" width={48} height={48} style={{ opacity: .6, borderRadius: 8 }} />
    <b style={{ fontSize: 16 }}>Captured view of the agent at this step</b>
    <span style={{ fontSize: 13, color: "#9FB1B8", maxWidth: 440 }}>To be filled by the visual-audit package from this run&apos;s snapshots and events. Nothing is shown here yet.</span>
  </div>;
}
