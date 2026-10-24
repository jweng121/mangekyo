# Visual-audit handoff: "What the agent saw"

The route `/runs/[runId]/view` (finance-dev) has a clearly labelled **PLACEHOLDER · VISUAL AUDIT** area. It also has a frame strip with one frame per step of the run. The placeholder is the place to plug in the captured view.

## The one component to replace

`apps/finance-dev/app/components/VisualAuditPlaceholder.tsx`

```ts
export interface VisualAuditFrameProps {
  runId: string;            // investigation run, e.g. "intake:demo:account:pool-004:deposit:...:investigation:1"
  stepIndex: number;        // zero-based index into the run's ordered steps
  snapshotId: string | null; // snapshot saved with that step's event, or null
}
```

**How to replace it**
- Keep the export name, the props and the 16:9 frame (`.shot`); replace only the body.
- The page passes the frame the person selected in the strip. The selection changes `stepIndex` and `snapshotId`.

**What a step is**
- A step is one saved event for the run, in `sequence` order. These are the same steps the run inspector lists.
- Each step's snapshot was written in the same transaction as its event.

**Reading the data**: use `api.financeDesk.getRunView({ runId })`. It returns:
- `steps`: `sequence`, `eventId`, `snapshotId`, `type`, `timestamp`, `message`, `status`
- `run`: includes the frozen `providerInput`
- `runs`: every attempt for the same deposit, each linked to its parent
- `clarifications`

Use `api.finance.listTaskSnapshots({ taskId })` for full snapshot bodies.

## Rules

- Treat runs, events and snapshots as read-only history. Never edit or delete them.
- The right-hand panel, **Exactly what it was given**, is already built from the real frozen input. Leave it as the source of truth for what the agent could see.
- No credentials or provider payloads beyond the frozen input are available here, and none should be added.
