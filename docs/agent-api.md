# Agent API for the visual audit and the desk

Backend contract for the five trust agents, the trust rules and the audit trail. Branch `edwin-trust-agents`. Types live in `packages/contracts/orchestration.ts` (`@mangekyo/contracts/orchestration`, additive). Every function is a Convex query or mutation on the dev deployment; call them with `api.<module>.<name>`.

Conventions:
- **Amounts are integer cents.** `2805000` is $28,050.00.
- **IDs are stable strings** (`runId`, `snapshotId`, `proposalId`, `entryId`, `sourceId`), never Convex document IDs.
- **History is append-only.** Runs, steps, snapshots, events, reports and sign-offs are never edited. A correction creates a new linked attempt.
- **Nothing here moves money.** Only `financeProposals.postProposal` and `financeReconciliation.approveCorrection` write ledger entries, and only for a person in the approver role.
- `dev: { role: "requester" | "approver", name }` is the dev-only identity switcher (recorded as `dev-unverified:<name>`), not authentication.
- The example data is the fictional law firm: Maria Delgado (settlement $85,000.00 from Harborline Insurance), the Nguyens (James and Linh), Raymond Cho, Daniel Okafor, Chen & Park Holdings, Westbrook HOA, Bayview Title. Account IDs look like `demo:account:pool-001`.

The names below marked **fixed** are the ones agreed with the frontend and will not change: `getRunSteps`, `getSnapshot`, `getClaims`, `submitCorrection`, `listPolicies`, `getAuditReport`, `getScorecard`, `listTaskEvents`.

## Where each function lives

| Module | Functions |
| --- | --- |
| `financeAgentApi` | `getRunSteps`, `getSnapshot`, `getClaims`, `submitCorrection`, `listCorrections`, `listPolicies`, `listEvalCases`, `evaluateInstructions`, `listEvalRuns` |
| `financeAudit` | `runAudit`, `getAuditReport`, `listAuditReports`, `runAuditorDrill`, `getAuditorScorecard`, `monthlyReconciliationReport`, `signOffMonthlyReconciliation`, `listMonthlyReconciliations` |
| `financeTrust` | `startDisbursement`, `getDisbursement`, `listDisbursements`, `recordDispute`, `resolveDispute`, `listDisputes` |
| `financeScorecard` | `getScorecard`, `listScorecards`, `runPlanted`, `runBatch` |
| `finance` | `listTaskEvents`, `listTaskSnapshots`, `listMoneyEvents`, `listMoneySnapshots` |
| `financeOrchestrator` | `getConfiguration` (now with `agents`), `getTimeline`, `getPipeline` |
| unchanged | `financeDesk.getRunView`, `financeDesk.getDeskData`, `financeInvestigations.*`, `financeProposals.*`, `financeReconciliation.*`, `financeIntake.*` |

## Runs, steps and snapshots (screen: run inspector, "What the agent saw")

### `financeAgentApi.getRunSteps({ runId })` — fixed

Every step of a run, oldest first, for any agent (intake `…:investigation:N`, disbursement `disb:…:disbursement:N`, reconciler `recon:…:run:N`, audit `audit:…:audit:N`). Returns `RunStep[]`.

```json
[
  { "stepIndex": 0, "snapshotId": "intake:demo:account:pool-001:deposit:demo:bank:txn:harborline-delgado:investigation:2:step:0", "kind": "input_frozen", "actor": { "type": "system", "identity": "system:orchestrator" }, "model": "mock", "mode": "mock", "startedAt": 1792843200000, "finishedAt": 1792843200003, "message": "Exactly what the Trust Intake agent is given for attempt 2." },
  { "stepIndex": 1, "snapshotId": "…:investigation:2:step:1", "kind": "output_validated", "actor": { "type": "agent", "identity": "agent:trust-intake:mock" }, "model": "mock", "mode": "mock", "startedAt": 1792843200003, "finishedAt": 1792843200010, "message": "proposal_ready: Proposed ownership requires a person's approval before posting." },
  { "stepIndex": 2, "snapshotId": "…:investigation:2:step:2", "kind": "claims_checked", "actor": { "type": "agent", "identity": "agent:evidence-checker:mock" }, "model": "mock", "mode": "mock", "startedAt": 1792843200010, "finishedAt": 1792843200012, "message": "Evidence Checker (mock): 1 supported, 0 not supported, 0 not checkable." },
  { "stepIndex": 3, "snapshotId": "…:investigation:2:step:3", "kind": "lock_evaluated", "actor": { "type": "code", "identity": "code:finance-core" }, "model": "mock", "mode": "mock", "startedAt": 1792843200012, "finishedAt": 1792843200014, "message": "Lock at request: demo:account:pool-001:alloc:0001 pending_approval." }
]
```

Step kinds: `input_frozen`, `agent_answered`, `output_validated`, `claims_checked`, `lock_evaluated`, `person_decided`, `failed`. A run that failed ends with a `failed` step. Stable: `stepIndex`, `snapshotId`, `kind`, `actor`, `model`, `mode`, `startedAt`, `finishedAt`. `message` is display text.

### `financeAgentApi.getSnapshot({ snapshotId })` — fixed

One immutable `StepSnapshot`, or `null`.

```json
{
  "snapshotId": "…:investigation:2:step:2", "runId": "…:investigation:2", "taskId": "intake:demo:account:pool-001:deposit:demo:bank:txn:harborline-delgado", "accountId": "demo:account:pool-001",
  "agent": "evidence_checker", "stepIndex": 2, "kind": "claims_checked",
  "actor": { "type": "agent", "identity": "agent:evidence-checker:mock" }, "model": "mock", "mode": "mock", "instructionVersion": "finance-claim-checker/v1",
  "startedAt": 1792843200010, "finishedAt": 1792843200012,
  "input": { "schemaVersion": "finance-claim-check-input/v1", "runId": "…", "investigationInput": { "…": "the frozen finance-investigation-input/v1" }, "claims": [ { "findingId": "owner-named-in-source", "claim": "Delgado v. Ridgeway Logistics settlement agreement names Maria Delgado as recipient/beneficiary for $85,000.00.", "sourceRefs": ["demo:bank:txn:harborline-delgado", "demo:document:delgado-settlement:v1", "demo:document:delgado-settlement-statement:v1"], "codeVerdict": "supported", "codeReason": "Every quoted fact appears in the cited records: $85,000.00, Maria Delgado." } ] },
  "output": { "schemaVersion": "finance-claim-check/v1", "agentMode": "mock", "status": "passed", "claims": ["…"], "checkedAt": 1792843200012 },
  "checkerVerdicts": [ { "findingId": "owner-named-in-source", "verdict": "supported", "checkedBy": "code", "reason": "…", "facts": ["$85,000.00", "Maria Delgado"], "missing": [], "sourceSays": null, "claim": "…", "sourceRefs": ["…"] } ],
  "lockResults": null,
  "message": "Evidence Checker (mock): 1 supported, 0 not supported, 0 not checkable."
}
```

`input` is exactly what that step's actor was given (for `input_frozen` it equals the run's `providerInput`). `output` is the validated output or `null`. `checkerVerdicts` is filled on `claims_checked`; `lockResults` on `lock_evaluated` (one `LockResult` per proposal, with `evaluated` listing L1–L11 and `failures`). Stable: everything except `message`.

Events: every snapshot also appends `finance.snapshot.captured` with `payload.stepIndex` and `payload.snapshotId` to the run's task stream (`finance.listTaskEvents`), or `finance.money.snapshot_captured` on the account stream for disbursement, reconciler and audit runs (`payload.sourceIds = [snapshotId, runId]`).

### `financeAgentApi.getClaims({ runId })` — fixed

The Evidence Checker's verdicts for an intake or disbursement run.

```json
{ "runId": "disb:demo:account:pool-001:matter:delgado-v-ridgeway:disbursement:2", "agent": "disbursement", "status": "passed", "checkerMode": "mock",
  "claims": [
    { "findingId": "line-1", "claim": "Attorney fee (33%): $28,050.00.", "sourceRefs": ["demo:document:delgado-settlement-statement:v1", "demo:document:delgado-fee-agreement:v1"], "verdict": "supported", "checkedBy": "code", "reason": "Every quoted fact appears in the cited records: $28,050.00.", "facts": ["$28,050.00"], "missing": [], "sourceSays": null },
    { "findingId": "payout:line-3", "claim": "Net to client Maria Delgado: $56,000.00.", "sourceRefs": ["demo:document:delgado-settlement-statement:v1"], "verdict": "supported", "checkedBy": "code", "reason": "…", "facts": ["$56,000.00", "Maria Delgado"], "missing": [], "sourceSays": null }
  ] }
```

`status` is `passed`, `rejected` or `not_checked`. A `not_supported` claim carries `missing` (facts no cited record contains) and `sourceSays` (what the record really says). Stable: all fields.

### `financeDesk.getRunView({ runId })` and `finance.listTaskEvents({ taskId, afterSequence? })` — fixed

Unchanged. `listTaskEvents` now also returns `finance.snapshot.captured` events. Intake runs carry `provenance` and `checkerProvenance` (`{ agent, mode, model, instructionVersion }`).

## Corrections (screen: run inspector, "Correct and rerun")

### `financeAgentApi.submitCorrection({ runId, stepIndex, kind, payload, reason, actor })` — fixed

Creates a new linked attempt. The corrected run never changes. `stepIndex` must be a step of the run. Kinds and payloads:

| kind | payload | effect on the new attempt |
| --- | --- | --- |
| `cite_clarification` | `{ note? }` | the person's saved answer is the source for the owner claim |
| `checker_wrong` | `{ note }` (or `reason`) | a recorded dispute of the verdict; code-found contradictions still apply |
| `add_document` | `{ text, title? }` | the pasted text is a clarification the agent may cite |
| `correct_input_field` | `{ path, value }` | the field is changed in the new attempt's frozen input and noted in `records.missingEvidence`; allowed paths: `records.bankTransactions[i].reference`, `records.bankTransactions[i].counterparty`, `records.transactions[i].description` |

```json
{ "correctionId": "…:investigation:2:correction:cite_clarification", "newRunId": "…:investigation:3", "created": true }
```

Refusals (`ConvexError`): the run is still active; a newer attempt exists; the step doesn't exist; a required note or reason is missing; an unsupported path. `financeAgentApi.listCorrections({ runId })` or `({ taskId })` returns `CorrectionRecord[]` (`correctionId, runId, taskId, stepIndex, kind, payload, reason, actor, newRunId, clarificationId, createdAt`). `financeInvestigations.correctAndRerun` remains for the desk's checker-stopped card.

## Policies (screen: desk policy cards, "Used policy")

### `financeAgentApi.listPolicies({ accountId })` — fixed

```json
[ { "policyId": "P-1", "version": "v1", "statement": "A client's deposit smaller than the retainer in their engagement letter is a partial retainer payment for that client.", "status": "approved", "accountId": "demo:account:pool-001", "currency": "USD", "approvedAt": 1792843300000, "approvedBy": "dev-unverified:sam", "fromRunId": "…:priya-raman-retainer:investigation:1", "sourceId": "policy:demo:account:pool-001:P-1@v1",
    "usedLabel": "Used policy P-1, approved by dev-unverified:sam",
    "backtest": { "statement": "…", "testable": true, "handled": 1, "agree": 1, "disagree": 0, "cases": [ { "bankSourceId": "demo:bank:txn:okafor-retainer", "label": "$2,500.00 from D OKAFOR", "predictedOwnerId": "demo:owner:daniel-okafor", "decidedOwnerIds": ["demo:owner:daniel-okafor"], "agrees": true } ], "summary": "Would have handled 1 past deposit: 1 agree with what people decided, 0 disagree.", "reasonRequired": false, "reason": null, "approvedBy": "dev-unverified:sam", "at": 1792843300000 } } ]
```

Show `usedLabel` wherever a run cites `sourceId` or its summary begins with "Used policy". Candidate (unapproved) policies with their live backtest are in `financeDesk.getDeskData().policies`; approval is `financeProposals.approvePolicy` (a written reason is required when any backtest case disagrees).

## Eval (screen: agent settings)

- `financeAgentApi.listEvalCases({ agent, instructionVersion? })` — `EvalCase[]`; `agent` accepts old names (`investigator`).
- `financeAgentApi.evaluateInstructions({ agent, instructionVersion? })` — replays every case through the mock and saves an `EvalReport`:

```json
{ "evalRunId": "eval:intake:finance-investigator/v1:1", "agent": "intake", "instructionVersion": "finance-investigator/v1", "mode": "mock", "passed": 1, "failed": 1, "changed": 1, "total": 3, "ranAt": 1792843400000,
  "results": [ { "evalCaseId": "eval:…:investigation:2:checker_rejection", "verdict": "failed", "detail": "repeated the claim the checker rejected; the code check still rejects a claim: The cited records don't contain: James Nguyen." } ] }
```

`passed`: same answer as recorded and the expectation holds; `changed`: the expectation holds but the answer differs; `failed`: the expectation is broken. Only intake cases are recorded so far; other agents refuse with a message.

## Disbursement (screen: matter payout card)

### `financeTrust.startDisbursement({ accountId, bankSourceId, dev })`

Starts (or returns the running) disbursement for the settlement deposit's matter. `{ runId, created, refused? }`. Mangekyo also starts it on its own when the allocation of a deposit with a signed settlement statement posts (mock mode).

### `financeTrust.getDisbursement({ runId })`

```json
{ "state": "ready_for_approval",
  "run": { "runId": "disb:demo:account:pool-001:matter:delgado-v-ridgeway:disbursement:2", "matterId": "matter:delgado-v-ridgeway", "clientOwnerId": "demo:owner:maria-delgado", "settlementSourceId": "demo:document:delgado-settlement-statement:v1", "attempt": 2, "status": "ready_for_approval", "provenance": { "agent": "disbursement", "mode": "mock", "model": "mock", "instructionVersion": "finance-disbursement/v1" },
    "output": { "outcome": "proposal_ready", "summary": "Proposed 3 payout lines for Maria Delgado's matter matter:delgado-v-ridgeway from the signed settlement statement and the signed 33% fee agreement. …", "lines": ["…"], "findings": ["…"], "questions": [] },
    "lineChecks": [ { "lineId": "line-1", "supported": true, "reason": "The line is exactly a line of the signed settlement statement.", "sourceIds": ["…"] } ],
    "claimCheck": { "status": "passed", "agentMode": "mock", "claims": ["…"] }, "proposalIds": ["demo:account:pool-001:pay:0005", "demo:account:pool-001:pay:0006", "demo:account:pool-001:pay:0007"], "input": "…", "error": null },
  "lines": [
    { "proposalId": "demo:account:pool-001:pay:0005", "status": "pending_approval", "line": { "lineId": "line-1", "kind": "attorney_fee", "label": "Attorney fee (33%)", "amountCents": 2805000, "payeeOwnerId": "demo:owner:firm", "sourceRefs": ["demo:document:delgado-settlement-statement:v1", "demo:document:delgado-fee-agreement:v1"] }, "check": { "lineId": "line-1", "supported": true, "reason": "…", "sourceIds": ["…"] }, "lock": { "allowed": true, "stage": "request", "failures": [], "evaluated": ["L6", "L3", "L2", "L1", "L5", "L8", "L9", "L10", "L11"], "facts": { "payoutKind": "attorney_fee", "requestedCents": 2805000, "ownerAvailableCents": 2805000 } } },
    { "proposalId": "demo:account:pool-001:pay:0006", "status": "pending_approval", "line": { "lineId": "line-2", "kind": "costs", "label": "Costs advanced", "amountCents": 95000, "payeeOwnerId": "demo:owner:firm", "sourceRefs": ["demo:document:delgado-settlement-statement:v1"] }, "check": "…", "lock": "…" },
    { "proposalId": "demo:account:pool-001:pay:0007", "status": "pending_approval", "line": { "lineId": "line-3", "kind": "client_share", "label": "Net to client Maria Delgado", "amountCents": 5600000, "payeeOwnerId": null, "sourceRefs": ["demo:document:delgado-settlement-statement:v1"] }, "check": "…", "lock": "…" }
  ],
  "events": [ { "sequence": 1, "kind": "transition", "from": null, "to": "received", "trigger": "person_started", "actor": "…", "reason": "…", "snapshotId": "…" } ] }
```

Before the check clears each `lock.allowed` is `false` with `failures[].rule` containing `L2` and the proposals are `blocked`. A `needs_information` answer has `lines: []` and `output.questions` (≤3). Approve and post each line with `financeProposals.approveProposal` / `postProposal` (approver). `financeTrust.listDisbursements({ accountId })` lists runs, newest first.

## Disputes (screen: client ledger)

- `financeTrust.recordDispute({ accountId, ownerId, amountCents, reason, sourceIds?, dev })` → `TrustDispute` (`disputeId` like `demo:account:pool-001:dispute:001`). Any role.
- `financeTrust.resolveDispute({ disputeId, resolution, dev })` → `TrustDispute` with `resolvedBy`, `resolvedAt`. Approver only, and not the person who recorded it (L4).
- `financeTrust.listDisputes({ accountId })` → `TrustDispute[]`.

While a dispute is open, a payout that would dip into the disputed amount is held at approval or posting (`proposal.status = "on_hold"`, `hold.reasonCodes = ["DISPUTED_FUNDS"]`, L10). Resolving re-checks the hold; a person still continues it (`financeProposals.continueHeld`).

## Audit (screen: compliance page)

### `financeAudit.runAudit({ accountId, from, to, dev })`

`{ runId, reportId | null, refused? }`. Mock mode answers immediately (`reportId` set); a paid mode runs after the budget check and `reportId` appears on the run later.

### `financeAudit.getAuditReport({ accountId, reportId? })` — fixed

Latest report for the account, or one by ID. `null` when none.

```json
{ "reportId": "audit:demo:account:pool-002:…:audit:1:report", "accountId": "demo:account:pool-002", "period": { "from": 1792583999000, "to": 1792843200000 }, "agent": "auditor", "mode": "mock", "model": "mock", "instructionVersion": "finance-trust-auditor/v1", "status": "findings",
  "summary": "Reviewed 18 posted entries, 4 proposals and 7 owners from 2026-10-21 to 2026-10-24. 5 finding(s): A8_SECOND_APPROVER_AND_EVIDENCE ×2, A2_GOOD_FUNDS ×1, A4_FEE_NOT_EARNED ×1, A7_MONTHLY_RECONCILIATION ×1.",
  "findings": [
    { "findingId": "A2_GOOD_FUNDS:2", "ruleId": "A2_GOOD_FUNDS", "severity": "violation", "message": "$56,000.00 was paid out for Maria Delgado (drill:uncleared:entry:1) when only $0.00 of their money had cleared; demo:bank:txn:drill-harborline had not cleared.", "entryIds": ["drill:uncleared:entry:1"], "sourceIds": ["demo:bank:txn:drill-harborline"], "ownerId": "demo:owner:maria-delgado", "amountCents": -5600000, "foundBy": "code" },
    { "findingId": "A4_FEE_NOT_EARNED:3", "ruleId": "A4_FEE_NOT_EARNED", "severity": "violation", "message": "A $3,000.00 fee left Chen & Park Holdings's trust balance (drill:fee:entry:1) with no approved invoice and no signed settlement fee line matching a signed fee agreement.", "entryIds": ["drill:fee:entry:1"], "sourceIds": ["demo:owner-record:chen-park"], "ownerId": "demo:owner:chen-park", "amountCents": -300000, "foundBy": "code" },
    { "findingId": "A7_MONTHLY_RECONCILIATION:4", "ruleId": "A7_MONTHLY_RECONCILIATION", "severity": "warning", "message": "2026-10 has posted activity but no monthly reconciliation signed off by a person.", "entryIds": ["…"], "sourceIds": [], "ownerId": null, "amountCents": null, "foundBy": "code" }
  ],
  "reviewed": { "entries": 18, "proposals": 4, "owners": 7, "months": 1 }, "generatedAt": 1792843200000, "generatedBy": "dev-unverified:sam" }
```

Rule IDs: `A1_NEGATIVE_CLIENT_BALANCE`, `A2_GOOD_FUNDS`, `A3_COMMINGLING`, `A4_FEE_NOT_EARNED`, `A5_DISPUTED_FUNDS_PAID`, `A6_SETTLEMENT_SPLIT`, `A7_MONTHLY_RECONCILIATION`, `A8_SECOND_APPROVER_AND_EVIDENCE`. Stable: all fields. `financeAudit.listAuditReports({ accountId })` lists the last 20.

### `financeAudit.runAuditorDrill({})` and `financeAudit.getAuditorScorecard({ accountId })`

The drill creates a fresh law-firm account, plants four mistakes in posted history (self-approved entry, payout before funds cleared, fee with no invoice, unlinked reversal) and audits it. The scorecard:

```json
{ "accountId": "demo:account:pool-002", "reportId": "…", "caught": 4, "missed": 0, "falseAlarms": 0, "falseAlarmFindings": [], "line": "Caught 4 of 4 · missed 0 · false alarms 0",
  "planted": [ { "key": "self-approved", "label": "Self-approved entry", "entryId": "drill:self-approved:entry:1", "ruleId": "A8_SECOND_APPROVER_AND_EVIDENCE", "status": "caught" }, { "key": "payout-before-cleared", "label": "Payout before funds cleared", "entryId": "drill:uncleared:entry:1", "ruleId": "A2_GOOD_FUNDS", "status": "caught" }, { "key": "fee-no-invoice", "label": "Fee taken with no invoice", "entryId": "drill:fee:entry:1", "ruleId": "A4_FEE_NOT_EARNED", "status": "caught" }, { "key": "unlinked-reversal", "label": "Unlinked reversal", "entryId": "drill:reversal:entry:1", "ruleId": "A8_SECOND_APPROVER_AND_EVIDENCE", "status": "caught" } ] }
```

### `financeAudit.monthlyReconciliationReport({ accountId, month })` and `signOffMonthlyReconciliation({ accountId, month, note?, dev })`

`month` is `YYYY-MM` (UTC). The query is code-computed until signed; once signed it returns the saved report exactly as the person saw it.

```json
{ "reportId": "demo:account:pool-001:monthly:2026-10", "accountId": "demo:account:pool-001", "month": "2026-10", "periodEnd": 1793491199999,
  "bank": { "statementCents": 33950000, "adjustedCents": 33950000, "clearedCents": 33950000, "pendingCents": 0 }, "bookCents": 33950000,
  "clientLedgers": [ { "ownerId": "demo:owner:westbrook", "name": "Westbrook HOA", "postedCents": 21000000, "clearedCents": 21000000, "ownerKind": "client" }, { "ownerId": "demo:owner:firm", "name": "Hartwell & Moreno LLP operating account", "postedCents": 0, "clearedCents": 0, "ownerKind": "firm" }, { "ownerId": null, "name": "Unallocated", "postedCents": 0, "clearedCents": 0, "ownerKind": "unallocated" } ],
  "reconcilingItems": [], "threeWay": { "status": "matched", "bankMinusBook": 0, "bookMinusOwners": 0, "causes": [] },
  "signedOff": { "by": "dev-unverified:sam", "at": 1793613600000, "note": "Reviewed against the bank statement." } }
```

Sign-off is approver only, once per month, only after the month ends and only when the three-way check is `matched`. `listMonthlyReconciliations({ accountId })` lists signed months.

## Scorecards (screen: scorecard page)

`financeScorecard.getScorecard({ accountId })` — fixed; unchanged shape (`kind: "planted" | "batch"`), `null` for other accounts (audit drill accounts use `getAuditorScorecard`). `listScorecards` now also lists `audit_drill` cards.

## Configuration (screen: agent settings)

`financeOrchestrator.getConfiguration({ now })` adds `agents`:

```json
{ "agents": [
  { "agent": "intake", "label": "Trust Intake", "aliases": ["investigator", "Agent 1"], "plannedModel": "Claude Opus", "mode": "mock", "model": "mock", "configured": true, "message": "Trust Intake simulated: deterministic mock behind the provider interface. No external model runs.", "realRuns": 0, "instructionVersion": "finance-investigator/v1" },
  { "agent": "disbursement", "label": "Disbursement", "aliases": [], "plannedModel": "Claude Opus", "mode": "mock", "model": "mock", "configured": true, "message": "…", "realRuns": 0, "instructionVersion": "finance-disbursement/v1" },
  { "agent": "evidence_checker", "label": "Evidence Checker", "aliases": ["checker", "claim checker", "Agent 2"], "plannedModel": "Gemini Pro", "mode": "mock", "model": "mock", "configured": true, "message": "…", "realRuns": 0, "instructionVersion": "finance-claim-checker/v1" },
  { "agent": "reconciler", "label": "Three-Way Reconciler", "aliases": ["mismatch agent"], "plannedModel": "Claude Opus", "mode": "mock", "model": "mock", "configured": true, "message": "…", "realRuns": 0, "instructionVersion": "finance-reconciler/v1" },
  { "agent": "auditor", "label": "Trust Compliance Auditor", "aliases": [], "plannedModel": "GPT", "mode": "mock", "model": "mock", "configured": true, "message": "…", "realRuns": 0, "instructionVersion": "finance-trust-auditor/v1" }
] }
```

`model` is `mock`, `creao:<appId>` or the external model ID; keys are never returned. `investigator` and `checker` fields remain for the current desk.

## Lock results

`LockResult.evaluated` now lists the trust rules too: `["L7","L4","L6","L3","L2","L1","L5","L8","L9","L10","L11"]` at approval. New `failures[].rule` / `code` pairs: `L8 COMMINGLING`, `L9 FEE_NOT_EARNED`, `L10 DISPUTED_FUNDS` (held), `L11 SETTLEMENT_MISMATCH`. Payments carry optional `payoutKind`, `matterId`, `settlementSourceId`, `payeeOwnerId`. The three-way check may report a `COMMINGLING` warning cause. Everything else about proposals, holds and transitions is unchanged.
