# Demo ERP sandbox

This worktree contains a standalone synthetic trust ERP at `apps/demo-erp`. It does not connect to a bank or Edwin's finance core. The monitored runner is deterministic and scripted; it performs real Chromium navigation, reads, screenshots, and form submission.

## Install and run

From this worktree root:

```powershell
pnpm install
pnpm exec playwright install chromium
pnpm dev:demo-erp
```

Open `http://localhost:3001`. Start visual audit separately with `pnpm dev:visual-audit` at port 3000. This script selects `apps/visual-audit-dev` when the Phase 1 app is present, otherwise the repository playground. In this isolated worktree the visual-audit package is the repository skeleton. The adjacent Phase 1 checkout has the actual workspace; integration there still requires an ingestion endpoint or loader.

In another terminal:

```powershell
$env:MANGEKYO_BROWSER_HEADLESS="true"
pnpm dev:monitored-agent B
```

Run A, B, C, or D as the last argument. B deliberately proposes Client A using ambiguous invoice context; the server rejects it because remittance evidence identifies Client B. C also reads the Company X revenue field. D attempts a duplicate payment allocation, which is rejected.

For a real corrected run, use the parent run ID printed by the first run:

```powershell
$env:MANGEKYO_PARENT_RUN_ID="demo-b-..."
$env:MANGEKYO_STEERING_INSTRUCTION="Review the payment reference again. The evidence identifies Client B."
pnpm dev:monitored-agent F
```

The corrected run receives a new run and branch ID and keeps the original JSON and screenshots. No posted action is replayed. Scenario E is the invalid/blocked write path of B or D. Reset state with `pnpm demo:reset` or `pnpm demo:seed`; both restore deterministic seed 42. Set `DEMO_ERP_SEED` to use another seed identifier. Demo state is stored in `apps/demo-erp/.data/state.json` and is intentionally separate from audit artifacts.

## Capture and integration

Each `record()` operation waits for a visible target, returns its actual DOM text, takes its viewport `boundingBox()`, then captures the same viewport at 1440 × 900 device scale 1. The snapshot stores the pixel box in `observation.fields[].bounds` and a normalized `annotations[].region`. Its screenshot is served from `http://localhost:3001/captures/<snapshot-id>.png`. A screenshot alone never marks other visible elements as read. The runner also POSTs the read to the ERP operational activity log.

Run bundles are in `artifacts/monitored-agent/<run-id>.json`, with `AgentEvent`, `Snapshot`, and an escalation payload for rejected proposals. IDs and sequence numbers are monotonic within the run. The types match the Phase 1 `packages/contracts` browser observation schema. When `MANGEKYO_INGEST_URL` is set, the runner also POSTs the same bundle to it. A Mangekyo ingestion adapter should read these bundles or accept them over HTTP, store screenshot references, render the annotation region, and attach the escalation to the stated snapshot. The Phase 1 skeleton in this worktree has no ingestion API; this is the remaining integration step. The audit history must remain separate from resettable ERP activity.

## Controls

`POST /api/allocations` enforces proposal, reviewer approval, and idempotent posting on the server. The `simulated-reviewer` role is a clearly labeled test identity, not production authentication. An incorrect beneficiary or duplicate transaction produces a rejected proposal or denied write. Posting requires approval and an idempotency key. The seeded $8,250 unallocated suspense covers TX-001 and TX-002; posting transfers from suspense into an owner ledger, keeping the control balance consistent. Every proposal and actual balance change remains in local JSON until reset.

## Verification

Run `pnpm demo:test`, `pnpm --filter @mangekyo/demo-erp typecheck`, and `pnpm --filter @mangekyo/demo-erp build`. The browser test checks that a read target has a bounding box wholly within its captured viewport. It also verifies the Company X field is independently addressable.
