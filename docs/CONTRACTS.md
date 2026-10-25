# Shared contracts

`packages/contracts` exports `AgentEvent`, `Snapshot`, `AuditRequest`, `AuditResult`, `AuditFinding`, `Escalation`, `SteeringRequest`, `CorrectionRequest`, `ExecutionBranch`, `MemoryEntry`, `MemoryProposal`, and `ChatMessage`. Fields carry schema or instruction versions where relevant.

`NarratedExplanation` groups `NarrationSegment` records under a chat message. Each segment may cite a snapshot, evidence IDs, and annotation IDs. `EvidenceAnnotation` links a recorded evidence ID to a stable structured field, exact document quote, or normalized image rectangle. Mangekyo validates each citation against the selected snapshot before playback. Missing geometry yields no image overlay.

For finance → Mangekyo, emit a committed `AgentEvent` and its matching `Snapshot`. Maintain a stable event ID and monotonic sequence within each run; set `parentEventIds` for dependencies, parallel branches, handoffs, and corrected branches. A screenshot may be attached only with its provenance. API-only observations should use `StructuredObservation` and source-field references. The checker should receive its own evidence context without maker proposal data.

For Mangekyo → finance, consume `AuditResult` as advisory output, `Escalation` for human review, and `CorrectionRequest` for an authorized workflow rerun. `CorrectionRequest.replayPayments` is always `false` in this prototype. Finance policy, approval, idempotency, and gateway controls remain owned by finance-core.

For future-run memory, implement `MemoryContextAdapter.getApprovedContext(query)`. The query includes organization, agent role, task type, and data context. The adapter returns only approved, current guidance with `authority: "guidance_only"`; it cannot grant tools or override financial policy. Phase 1 uses a local adapter and browser storage.
