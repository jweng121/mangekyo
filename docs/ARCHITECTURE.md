# Phase 1 architecture

The standalone Next.js app in `apps/visual-audit-dev` renders reusable UI from `packages/visual-audit`. The package separates immutable observations, deterministic audit findings, explicit human steering, and approved memory. `packages/contracts` defines the integration boundary for both developers.

The synthetic stream starts with independent maker and checker branches. Each committed event has a stable ID, run ID, sequence, parent event IDs, and exactly one linked snapshot. The execution graph is derived from these parent links. Duplicate event IDs are ignored; conflicting sequence numbers and unknown parent IDs are rejected.

The Phase 1 auditor examines structured maker and checker outputs. It returns a finding attached to the earliest conflicting maker proposal. It has no finance posting capability. The escalation selects that checkpoint and opens its recorded evidence. The simulated steering workflow produces a structured request, a correction request, a new run, and graph edges back to the selected checkpoint. It does not restore a prior ERP session or replay payments.

Memory proposals remain separate from steering. A reviewer must explicitly approve a scoped version before the future-run adapter retrieves it. The demo persists memory records in browser local storage; production storage and authenticated authorization are Phase 2 work. The `demo-reviewer` identity in Phase 1 is synthetic and conveys no real permissions.
