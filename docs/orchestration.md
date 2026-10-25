# Agent orchestration

Branch `edwin-trust-agents` (from `edwin-orchestration`). Everything was verified in mock mode; no CREAO or external model run was started. No existing lock rule or validator was loosened; `packages/contracts` changed additively; no deployment setting changed. Frontend code (`apps/web`, `packages/visual-audit`, `scripts/monitored-agent`) was not edited. `apps/finance-dev` changed in one place: blocked payment cards that are superseded (a later request for the same line passed, or a person acknowledged them) leave "Needs a person", and lock cards show one pool figure, the adjusted cleared balance ([agent-api.md](agent-api.md#lock-results)).

Companion documents: [agent-api.md](agent-api.md) (every query and mutation for the desk and the visual audit), the five agent instruction files (`creao-trust-intake-agent.md`, `creao-disbursement-agent.md`, `creao-evidence-checker-agent.md`, `creao-three-way-reconciler-agent.md`, `creao-trust-compliance-auditor-agent.md`), [lawfirm-progress.md](lawfirm-progress.md) and the walkthrough in [ui-report.md](ui-report.md#current-law-firm-demo-walkthrough).

## 1. Five trust agents

| Agent | Was | Mode env (default `mock`) | Planned model (external) | What it does |
| --- | --- | --- | --- | --- |
| Trust Intake | investigator (Agent 1) | `INTAKE_MODE` (alias `FINANCE_AGENT_MODE`) | Claude Opus | matches each deposit to a client **and** a matter from settlement agreements, retainers and engagement letters; asks instead of guessing |
| Disbursement | new | `DISBURSEMENT_MODE` | Claude Opus | from a matter's signed settlement statement, fee agreement and approved invoices, proposes payout lines (fee, costs, liens, client share) with sources; never a payout a signed document doesn't state; asks when anything is missing or doesn't add up |
| Evidence Checker | claim checker (Agent 2) | `EVIDENCE_CHECKER_MODE` (alias `CHECKER_MODE`) | Gemini Pro | verifies every figure and reason from Intake, Disbursement and the Reconciler against the cited document |
| Three-Way Reconciler | mismatch agent | `RECONCILER_MODE` | Claude Opus | explains a break; proposes a correcting entry only when fully supported by cited records, otherwise asks one short question; never a balancing plug; also the monthly reconciliation report |
| Trust Compliance Auditor | new | `AUDITOR_MODE` | GPT | reviews posted activity for a period against the trust rules and writes an audit report; never changes money |

Rules shared by all five (`packages/finance-core/src/agents`):
- **One mode each**: `mock` (deterministic stand-in, default when unset), `creao` (the agent's own CREAO app: `CREAO_<AGENT>_APP_ID`, `CREAO_<AGENT>_API_KEY`; Intake falls back to `CREAO_APP_ID`/`CREAO_API_KEY`, the checker to `CREAO_CHECKER_*` then `CREAO_API_KEY`) or `external` (a model called directly: `<AGENT>_EXTERNAL_API_KEY`, optional `<AGENT>_EXTERNAL_MODEL` and `_URL`). An invalid value refuses to start anything. There is no silent fallback.
- **Model and mode are recorded on every run** as `provenance { agent, mode, model, instructionVersion }`: `mock`, `creao:<appId>` or the external model ID. Keys never leave the environment.
- **One provider interface** (`start`/`poll`). The external adapter (`ExternalModelProvider`) makes one HTTPS call to the model's family API (Claude Messages, Gemini generateContent, GPT chat completions) with the agent's instructions as the system prompt and `finance_context` as the one user message, and refuses anything but one raw JSON object.
- **Exact instructions live in code** (`src/agents/instructions.ts`) and the `creao-<agent>-agent.md` files are generated from them: one textarea input `finance_context`, raw JSON output only, sourceId-only citations, ask-don't-assume, at most 3 questions, law-firm examples. The Intake text includes the two edits from [overnight-report.md §6](overnight-report.md#6-creao-agent-instruction-changes-exact-text).
- **Every agent's proposal goes through the Evidence Checker, then a person, then the lock.** Code validates every answer strictly first; nothing is repaired.
- **Budget**: any agent in a paid mode counts one real run per attempt (`MAX_REAL_RUNS_PER_DAY`, `MAX_REAL_RUNS_PER_DEPOSIT`); mock runs count 0. Automatic starts (feed, auto-investigation, auto disbursement, reconciler) happen only while Intake is mock.

## 2. One orchestrator per subject

Every deposit, matter payout, code-found mismatch and audit period has one orchestrator (`financeOrchestrations`, kind `deposit` | `disbursement` | `reconciliation` | `audit`). The state machine, events and snapshots are as before:

```
                    ┌────────── budget refused ──────────┐
                    │                                    ▼
 received ──► investigating ──► validating ──► checking ──► needs_person
                  │  ▲ (1 retry)    │             │  ▲ (1 checker retry)
                  │  └──────────────┘             ├──► ready_for_approval
                  │                 │             ├──► rejected          (the checker stopped it)
                  └──────► failed ◄─┴─────────────┤
                       (needs a person)           └──► waiting_to_clear  (pending deposit)

 any settled state ──► investigating   (a person answered or corrected, the deposit cleared, an allocation posted, a person tried again)
```

Each transition, retry and budget check is one `financeOrchestratorEvents` row plus one `financeOrchestratorSnapshots` row, with who or what caused it (`system`, `code`, `agent:<name>:<mode>`, or a person). Illegal transitions throw and roll back. One active run per subject.

### Step snapshots for the visual audit

Every run also writes **one immutable `financeStepSnapshots` row per step** (`captureStep`): `actor`, `model`, `mode`, `instructionVersion`, `startedAt`/`finishedAt`, the exact frozen `input`, the validated `output`, `checkerVerdicts` and `lockResults`. Step kinds: `input_frozen`, `output_validated`, `claims_checked`, `lock_evaluated`, `failed`. Each one emits `finance.snapshot.captured {runId, stepIndex, snapshotId}` on the run's task stream (intake) or `finance.money.snapshot_captured` on the account stream (disbursement, reconciler, audit). Read them with `financeAgentApi.getRunSteps` and `getSnapshot`.

## 3. Trust rules in the lock (L8–L11)

Checked at request, approval and posting, each recorded in the lock result and the `finance.money.lock_checked` event, alongside L1–L7 (`packages/finance-core/src/gateway`, `evaluateTrustRules`).

| Rule | Code | Decision | What it checks |
| --- | --- | --- | --- |
| L8 | `COMMINGLING` | block | the firm's own money (an owner with `ownerKind: "firm"`) never funds a client payment: a client_share/lien/refund from the firm's bucket, or a client payout funded by a deposit allocated to the firm. Firm money sitting in trust is also flagged as a `COMMINGLING` warning cause in the three-way check |
| L9 | `FEE_NOT_EARNED` | block | a trust-to-firm fee (`payoutKind: "attorney_fee"`) needs either an approved invoice for that client (and matter) covering the amount, or a signed settlement statement fee line that equals the signed fee agreement's percentage of the statement total (integer cents, `contingencyFeeCents`); never more than the client's posted balance |
| L10 | `DISPUTED_FUNDS` | hold | disputed amounts (`financeDisputes`, recorded by a person) stay in trust: a payout that would dip into them is held through the existing `on_hold` path until a different person records the resolution; the hold is re-checked automatically and a person continues it |
| L11 | `SETTLEMENT_MISMATCH` | block | a settlement payout (client_share, attorney_fee, costs, lien) must match a line of the signed settlement statement exactly (kind, amount, payee); a statement whose lines don't add up to the settlement deposit blocks every line |

Source records gained optional fields for this (`packages/contracts/money.ts`): owners `ownerKind`, documents `signed`, `matterId`, `lines` (structured settlement lines) and `feeBasisPoints`, obligations `matterId`, payments `payoutKind`, `matterId`, `settlementSourceId`, `payeeOwnerId`. Documents that aren't marked signed back nothing.

**Fixture additions** (`fixtures/lawFirm.ts`): the firm's own-money owner (opens at zero), Delgado's signed settlement statement ($85,000.00 = attorney fee 33% $28,050.00 + costs $950.00 + client $56,000.00, payees the firm/the firm/the client) and her signed 33% contingency fee agreement, all on matter `matter:delgado-v-ridgeway`. The Delgado deposit links the settlement agreement and the statement.

## 4. The Disbursement flow

`convex/financeTrust.ts`. One orchestrator per matter (`disb:<account>:<matter>`).
1. **Start**: a person (`startDisbursement`), the demo feed (step 2), or automatically when the allocation of a settlement deposit with a signed statement posts (mock mode).
2. **Input frozen**: the matter's client, the firm, the settlement deposit, the matter's documents, approved invoices, the client's code-computed balance, open disputes, policies and clarifications (`buildDisbursementInput`), saved as the `input_frozen` step.
3. **Agent** (mock, CREAO or external) answers `proposal_ready` with lines or `needs_information` with ≤3 questions. `validateDisbursementOutput` refuses extra fields, unknown citations, lines not backed by a signed document, non-integer cents.
4. **Code line check** (`codeCheckPayoutLines`): every line is exactly a line of the cited signed statement, the lines are exactly the statement's lines, and a fee line equals the fee agreement's percentage.
5. **Evidence Checker** judges every finding and one claim per line against the documents.
6. **Lock**: each line becomes one payment proposal (`payoutKind`, `matterId`, `settlementSourceId`, `payeeOwnerId`, `fundingSourceId` = the deposit, evidence = the signed documents). Before clearing every line is `blocked` by L2 ("has not cleared"); after clearing and allocation they wait for a person. The run settles `ready_for_approval`, `needs_person` or `rejected`.
7. **A person approves and posts each line** (approver, L4). L9 passes the fee via the contingency agreement, L11 passes because the lines match the statement.

## 5. Memory and improvement

- **Every person's answer is saved as a clarification the next run sees**: clarifications carry `accountId` and `makeAttempt` reads the task's own answers plus the account's (`accountClarifications`, bounded to 100). The mock Intake uses an earlier confirmed partial retainer as memory for a new client's partial retainer and says so ("From memory of an earlier answer").
- **Repeatable patterns become candidate policies**: after a person confirms a partial retainer, the agent proposes `PARTIAL_RETAINER_POLICY`; it is backtested against decided deposits (`policy/index.ts` has its executable form), approved by a person (reason required if any case disagrees), and shown when used: "Used policy P-1, approved by dev-unverified:sam" (`usedPolicyLabel`, `financeAgentApi.listPolicies`).
- **Corrections**: `financeAgentApi.submitCorrection({runId, stepIndex, kind, payload, reason, actor})` with kinds `cite_clarification`, `checker_wrong`, `add_document`, `correct_input_field` ({path, value} on a small allowlist of input fields). It saves a `financeRunCorrections` row and a clarification and starts a new linked attempt; the old run is unchanged. The desk's `correctAndRerun` is the same code path.
- **Eval cases**: every checker rejection and every correction becomes a `financeEvalCases` row (frozen input, observed output, a code-checkable expectation). `evaluateInstructions({agent, instructionVersion})` replays them through the mock and saves `passed / failed / changed`. With unchanged instructions the rejection cases fail (the agent repeats the claim) and the corrections hold.

## 6. Three-Way Reconciler and monthly report

- The reconciler proposes `record_bank_item` or `reverse_entry` only when the records fully support it (a bank item marked `client-check-return` for an allocated deposit; a duplicate posting). For an outflow the bank attributes to a client with no return marker it asks one question: "The bank is $2,500.00 short. Did Daniel Okafor's check bounce, or is this a bank fee?" A ledger entry the bank never shows asks whether the payment was issued or voided. At most 3 questions.
- It runs in its own mode (`RECONCILER_MODE`), budget-checked in a paid mode, with step snapshots.
- `financeAudit.monthlyReconciliationReport({accountId, month})` computes bank, books, each client ledger (client/firm/unallocated) and the reconciling items at the month's end; `signOffMonthlyReconciliation` (approver, after the month ends, only when matched) saves the report immutably with who signed and when.

## 7. Trust Compliance Auditor and drill

`convex/financeAudit.ts`, `packages/finance-core/src/auditor`. `runAudit({accountId, from, to})` freezes the posted history (entries, bank items, proposals and approvals, signed documents, approved invoices, disputes, signed months) and code applies the eight rules first: A1 no client below zero, A2 good funds, A3 no commingling, A4 fees only once earned, A5 disputed funds held, A6 settlement splits match, A7 monthly reconciliation signed, A8 a second approver and evidence on every entry (and every reversal linked). The agent may only add findings that cite entries from the input; code's findings are never removed. The report is append-only (`financeAuditReports`) and the audit never writes a ledger entry.

**Drill** (`runAuditorDrill`): a fresh law-firm account with four mistakes planted in posted history (a self-approved entry, a payout before the funding check cleared, a $3,000 fee with no invoice, an unlinked reversal). `getAuditorScorecard` returns caught / missed / false alarms: **Caught 4 of 4 · missed 0 · false alarms 0** (the missing monthly sign-off is a warning, not an alarm).

## 8. Reliability, budget, saving under load

Unchanged from the previous branch: `PROVIDER_TIMEOUT_MS`, one automatic retry for provider or network trouble only, never for validation or an ambiguous paid start; `MAX_REAL_RUNS_PER_DAY` / `MAX_REAL_RUNS_PER_DEPOSIT`; write-conflict retries on every save (the 200-deposit batch reached 200 of 200 on the previous branch, so part A of this task was skipped); `MOCK_PROVIDER_FAULT` for tests. New runs write a few more rows (step snapshots), so the 40-deposit batch test has a longer timeout.

## 9. Demo feed (ten steps, same order every time)

1 Harborline's $85,000 check arrives pending · 2 Disbursement prepares the three lines, blocked by L2 until the check clears · 3 the check clears; approve the allocation; Disbursement runs again · 4 Okafor's partial retainer · 5 J NGUYEN's memo · 6 two Bayview wires · 7 Cho's $6,000 (L1) · 8 the insurance policy · 9 Westbrook's $18,000 · 10 a paralegal moves $3,000 of Chen & Park fees with no invoice (L9).

## 10. What was verified

Commands from the repository root, pnpm as `npx --yes pnpm@10.20.0`.

| Command | Result |
| --- | --- |
| Baseline `… typecheck` / `… test` | exit 0 / 31 files, 228 tests |
| Final `… typecheck` | exit 0 |
| Final `… test` | 37 files, 269 tests, all pass (after the superseded-card and pool-figure fixes and the merge of `origin/main`) |
| Final `… build:finance` | exit 0 |
| `edwin-smoke`: `… typecheck` / `… test` / `… build:finance` | exit 0 / 38 files, 279 tests, all pass / exit 0 (adds the real-agent smoke test, §14, with 10 fake-HTTP tests) |

Browser click-through: ten feed steps on `demo:account:pool-026`, see [lawfirm-progress.md](lawfirm-progress.md).

New tests: trust rules L8–L11 (contingency fee passing L9, no-invoice fee failing it, disputed funds held then released, settlement mismatch, commingling), the Disbursement split and its ask-when-unsure cases, the reconciler asking, memory reused on the next similar case and becoming a used policy, `submitCorrection` for every kind, eval replay, step snapshots, the auditor drill, the monthly report and sign-off, the agent registry and the external adapter with fake fetch, and the ten-step law-firm flow.

## 11. Environment variables (Convex deployment)

| Name | Default | Purpose |
| --- | --- | --- |
| `INTAKE_MODE` / `FINANCE_AGENT_MODE` | `mock` | Trust Intake mode (`mock`, `creao`, `external`); the new name wins |
| `CREAO_INTAKE_APP_ID` / `CREAO_APP_ID`, `CREAO_INTAKE_API_KEY` / `CREAO_API_KEY` | — | Intake's CREAO app and `capi_` key |
| `INTAKE_EXTERNAL_API_KEY`, `INTAKE_EXTERNAL_MODEL`, `INTAKE_EXTERNAL_URL` | — / `claude-opus-5-5` / family endpoint | Intake in external mode |
| `DISBURSEMENT_MODE`, `CREAO_DISBURSEMENT_APP_ID`, `CREAO_DISBURSEMENT_API_KEY`, `DISBURSEMENT_EXTERNAL_*` | `mock` | Disbursement |
| `EVIDENCE_CHECKER_MODE` / `CHECKER_MODE`, `CREAO_EVIDENCE_CHECKER_APP_ID` / `CREAO_CHECKER_APP_ID`, `CREAO_EVIDENCE_CHECKER_API_KEY` / `CREAO_CHECKER_API_KEY` / `CREAO_API_KEY`, `EVIDENCE_CHECKER_EXTERNAL_*` | `mock` / `gemini-2.5-pro` | Evidence Checker |
| `RECONCILER_MODE`, `CREAO_RECONCILER_APP_ID`, `CREAO_RECONCILER_API_KEY`, `RECONCILER_EXTERNAL_*` | `mock` | Three-Way Reconciler |
| `AUDITOR_MODE`, `CREAO_AUDITOR_APP_ID`, `CREAO_AUDITOR_API_KEY`, `AUDITOR_EXTERNAL_*` | `mock` / `gpt-5` | Trust Compliance Auditor |
| `PROVIDER_TIMEOUT_MS`, `MAX_REAL_RUNS_PER_DAY`, `MAX_REAL_RUNS_PER_DEPOSIT`, `AUTO_INVESTIGATE`, `OUTSTANDING_MAX_DAYS`, `MOCK_PROVIDER_FAULT` | unchanged | see §8 and finance-money-workflow.md |

The deployment's existing `FINANCE_AGENT_MODE=mock`, `CREAO_APP_ID` and `CREAO_API_KEY` keep working unchanged. Nothing was set or changed on the deployment.

## 12. What you do to switch an agent to real

Each `creao-<agent>-agent.md` has the steps: create the CREAO agent with one `finance_context` input, paste the instructions, create an app-scoped `capi_` key, set `CREAO_<AGENT>_APP_ID`, `CREAO_<AGENT>_API_KEY` and `<AGENT>_MODE=creao`. For an external model set `<AGENT>_EXTERNAL_API_KEY` (and `_MODEL`) and `<AGENT>_MODE=external`. In any paid mode: the feed, scorecard, drill and automatic starts refuse to run for that agent, every attempt is budget-checked, and `provenance` on the run shows the model.

## 13. Limits and not done

- **No real run of any agent.** CREAO and external adapters are verified with fake HTTP only. §14 is the one-call smoke test to try each agent for real. The default external model IDs are configurable and should be checked against the providers' current catalogues before use.
- **Backend only.** The desk has no card for Disbursement runs (the three lines appear as ordinary payment proposals), disputes, audits, monthly reports, step snapshots or agent configuration; see [agent-api.md](agent-api.md).
- **Paid checker on a disbursement run** polls inside the action for up to the run deadline rather than through scheduled polls.
- **Eval cases are recorded for Trust Intake only.** `evaluateInstructions` refuses other agents with a message.
- **At request stage, any lock failure still blocks** (including L10); the hold path applies at approval and posting, as before.
- **A2 good funds** reconstructs cleared money from the bank feed's current clearing status, so a deposit that cleared after a payout is judged by the time order of entries, not by a historical clearing timestamp (the feed doesn't record one).
- **The browser click-through** of the ten-step feed ran once on `demo:account:pool-026` (local desk on :3001, dev deployment, zero console errors; screenshots in `docs/screenshots/trust-agents/`). The push of this branch's functions to the shared dev deployment (`convex dev --once`) replaced the previous branch's code there, as before; no environment variable was changed.
- Left untouched: `packages/visual-audit`, `scripts/monitored-agent`, the teammate's ERP data, the uncommitted `packages/visual-audit/playground/next-env.d.ts` and `stash@{0}`.

## 14. Real-agent smoke test

`convex/financeSmoke.ts`, branch `edwin-smoke`. `financeSmoke:runAgentOnce({agent})` is an internal action (run it from the CLI; no client can call it). It calls one agent once on that agent's normal frozen input for a fixed law-firm case, on a fresh DEMO account (the next `demo:account:pool-NNN`), and runs the agent's normal strict validator on the answer.

| `agent` | Frozen input | Built with |
| --- | --- | --- |
| `intake` | Harborline's $85,000.00 check for Maria Delgado, cleared | `buildDepositRecordSet` + `buildIntakeInput` (the same code as every Intake attempt) |
| `disbursement` | the Delgado matter after the deposit cleared and was allocated to her | `matterOf` + `buildDisbursementInput` |
| `evidence_checker` | the mock Intake's claims for that deposit | `codeCheckClaims` + `buildCheckerInput` |
| `reconciler` | Daniel Okafor's $2,500.00 retainer check, allocated to him, then returned by the bank (`client-check-return`) | `reconcilableCauses` + `buildReconciliationInput` |
| `auditor` | the auditor drill's posted history (four planted mistakes) over the drill period | `drillHistory` + `auditInputFrom` |

What it does and doesn't do:
- **Refuses unless that agent's mode is `creao` or `external`**, and unless its credentials are set, before it creates or sends anything.
- **Counts one real run** (`financeRealRuns`, provider = the agent) and checks `MAX_REAL_RUNS_PER_DAY` first; past the limit it returns `ok: false` with `BUDGET_DAY_EXCEEDED` and calls nothing. The default limit is 5 a day, so all five smoke runs fit only if nothing else ran for real that UTC day. For `evidence_checker` the Intake claims come from the mock Intake, so it costs one run too.
- **Never posts money.** The account gets the law-firm fixture through the normal import with automatic starts off (no investigation, reconciler or disbursement is scheduled). The allocation, the returned check and the drill's history exist only in the frozen input; the account's ledger holds import entries only. The answer is validated and returned, never checked further, queued or posted.
- **No automatic retry.** One start, then polls every 3 s (CREAO) for up to 8 minutes; an unfinished CREAO run comes back as `provider_timeout` with its external run ID.
- Saves two step snapshots on run `smoke:<account>:<agent>:run:1` (`input_frozen`, then `output_validated` or `failed`), readable with `financeAgentApi:getRunSteps`.

It returns `{agent, mode, model, appId, runId, accountId, ok, outcome, validationErrors, error, rawOutputPreview, durationMs}`. `outcome` is the validated answer's outcome (`proposal_ready`, `needs_information`, `correction_proposed`; the checker's `passed`/`rejected`; the auditor's `findings`/`clean`). `validationErrors` are the validator's `{path, reason}` details. `rawOutputPreview` is the first 2,000 characters of the agent's answer, or of the provider's last response body when there was no usable answer (a fenced or prose reply, a CREAO failure). `error` is `{code, message}` or null; it never contains a key.

### Commands (PowerShell, repository root)

The functions are on the dev deployment (`convex dev --once` from this branch). Each agent's CREAO app and app-scoped `capi_` key must be set once; an app-scoped key only works for its own app, so the Intake key can't be reused for the others:

```powershell
npx convex env set CREAO_DISBURSEMENT_APP_ID "<app id>"
npx convex env set CREAO_DISBURSEMENT_API_KEY "<capi_ key>"
# likewise CREAO_EVIDENCE_CHECKER_*, CREAO_RECONCILER_*, CREAO_AUDITOR_*. Intake already uses CREAO_APP_ID / CREAO_API_KEY.
```

Then, one agent at a time. Keep the desk idle between the first and last line: while an agent is `creao`, anything that starts that agent automatically (the Evidence Checker on any mock Intake run, the Reconciler on any new mismatch) would be a real run too.

Trust Intake:

```powershell
npx convex env set INTAKE_MODE creao
npx convex run financeSmoke:runAgentOnce "{agent: 'intake'}"
npx convex env set INTAKE_MODE mock
```

Disbursement:

```powershell
npx convex env set DISBURSEMENT_MODE creao
npx convex run financeSmoke:runAgentOnce "{agent: 'disbursement'}"
npx convex env set DISBURSEMENT_MODE mock
```

Evidence Checker:

```powershell
npx convex env set EVIDENCE_CHECKER_MODE creao
npx convex run financeSmoke:runAgentOnce "{agent: 'evidence_checker'}"
npx convex env set EVIDENCE_CHECKER_MODE mock
```

Three-Way Reconciler:

```powershell
npx convex env set RECONCILER_MODE creao
npx convex run financeSmoke:runAgentOnce "{agent: 'reconciler'}"
npx convex env set RECONCILER_MODE mock
```

Trust Compliance Auditor:

```powershell
npx convex env set AUDITOR_MODE creao
npx convex run financeSmoke:runAgentOnce "{agent: 'auditor'}"
npx convex env set AUDITOR_MODE mock
```

The argument is JSON5 (the CLI parses it that way), so `"{agent: 'intake'}"` passes through Windows PowerShell 5.1 and PowerShell 7 alike. To read the two saved steps afterwards: `npx convex run financeAgentApi:getRunSteps "{runId: '<runId from the result>'}"`. For an external model instead of CREAO, set `<AGENT>_EXTERNAL_API_KEY` and use `external` in place of `creao`; if a long answer hits the 20 s default call timeout (`provider_start_ambiguous`), set `PROVIDER_TIMEOUT_MS` to `120000` for the run.
