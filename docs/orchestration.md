# Agent orchestration

Branch `edwin-orchestration` (from `edwin-lawfirm-demo`), local commits only. Everything was verified in mock mode; no CREAO run was started. No lock rule, validator, contract (`packages/contracts`) or deployment setting changed.

## 1. One orchestrator per deposit

Every deposit task has exactly one orchestrator: one row in `financeOrchestrations`, keyed by task. Each code-found mismatch gets its own orchestrator of kind `reconciliation`. The orchestrator is an explicit state machine; the pure rules live in `packages/finance-core/src/orchestrator`.

```
                    ┌────────── budget refused ──────────┐
                    │                                    ▼
 received ──► investigating ──► validating ──► checking ──► needs_person
                  │  ▲ (1 retry)    │             │  ▲ (1 checker retry)
                  │  └──────────────┘             ├──► ready_for_approval
                  │                 │             ├──► rejected          (the checker stopped it)
                  └──────► failed ◄─┴─────────────┤
                       (needs a person)           └──► waiting_to_clear  (pending deposit)

 any settled state ──► investigating   (a person answered or corrected, the deposit cleared, a person tried again)
```

| From | Allowed to |
| --- | --- |
| received | investigating, needs_person (budget refusal) |
| investigating | investigating (the single retry), validating, failed |
| validating | checking, failed |
| checking | checking (checker retry), needs_person, ready_for_approval, rejected, waiting_to_clear, failed |
| needs_person, ready_for_approval, rejected, waiting_to_clear, failed | investigating, needs_person |

Anything else throws `IllegalTransitionError`, and the mutation rolls back. So nothing reaches `ready_for_approval` without passing validation and the checker.

**Every step is saved, append-only**:
- each transition, retry and budget check is one row in `financeOrchestratorEvents` plus one in `financeOrchestratorSnapshots` (the orchestration as it was after the step, plus a run summary with its checker tally)
- each event records:
  - **who or what caused it**: actor `system` (orchestrator), `code`, `agent` (investigator, checker or mismatch agent, with its mode) or `person` (their identity)
  - a `trigger`, such as `auto_start`, `person_answered`, `deposit_cleared`, `provider_result`, `validated`, `checker_result`, `provider_error`, `budget_refused` or `mismatch_found`
  - a reason code and message
- the investigation's own events and snapshots (`financeEvents` / `financeSnapshots`) are unchanged

**Where a checked run settles** (`settledState`):

| Outcome | Settled state |
| --- | --- |
| Any `not_supported` claim | `rejected` |
| A question | `needs_person` |
| A proposal that passed the lock | `ready_for_approval` |
| A proposal the lock blocked | `needs_person` |
| Findings on a pending deposit | `waiting_to_clear` |
| Other findings | `needs_person` |

**One active run per deposit**: a second start while investigating, validating or checking returns the running attempt (`created: false`) and writes nothing. That covers auto-start, the feed and a person double-clicking. Auto-starts go through `internal.financeInvestigations.autoStartInvestigation`, with trigger `auto_start` or `deposit_cleared`.

## 2. Reliability

- **Provider timeout**: `PROVIDER_TIMEOUT_MS` bounds each provider call (default 20 000, range 100–600 000).
  - The CREAO adapters use it for their HTTP timeout too.
  - The ten-minute run deadline is unchanged.
- **One automatic retry, only for provider or network trouble**:
  - **Retried**: network errors, timeouts, HTTP 429/503 on a start, and 429/5xx on a status check.
  - **Never retried**:
    - validation failures
    - checker validation failures
    - configuration errors
    - authentication errors
    - a CREAO run that reports `failed`
    - a start that may have created a paid run (lost response, other 5xx), so a second paid run is never risked
  - Each retry is a saved `retry` event before the call is repeated. The count lives on the run, so polls share the one retry. The checker gets its own single retry.
- **Otherwise: failed, needs a person.**
  - The run is `failed`, the orchestrator is `failed` with "Failed, needs a person: …", and the desk shows a card with **Try again**.
  - Nothing is sent for approval.
- **Saving under load** (found in the live batch, see §7):
  - Settling reads the whole account for the lock and appends to the account's one event stream, so many runs settling at once conflict.
  - Actions retry a save that hit a write conflict, up to 10 times with capped backoff. This is not a provider retry: the provider is not called again, and the save mutations are idempotent through their status guards.
  - A save that still fails is recorded as `save_conflict`.
  - Imports of more than 10 new deposits start their investigations 400 ms apart.
- **`MOCK_PROVIDER_FAULT`** (mock mode only; leave unset): `network_once`, `network_always`, `hang` or `invalid_output`. It exercises the paths above in tests and demos.

## 3. Real-run budget

- **Limits**: `MAX_REAL_RUNS_PER_DAY` (default 5, UTC day) and `MAX_REAL_RUNS_PER_DEPOSIT` (default 2).
- **What counts**: a real run is the investigator in `creao` mode, or the checker in `creao` mode. An attempt with both needs 2. Mock runs need 0 and are never recorded.
- **Check**: every attempt is checked before anything starts. The check is saved as a `budget_check` event with the counts (`financeRealRuns` rows are written only for real runs).
- **Refusal**: when an attempt would exceed a limit, it doesn't start.
  - The orchestrator goes to `needs_person`, with reason `BUDGET_DAY_EXCEEDED` or `BUDGET_DEPOSIT_EXCEEDED` and the counts in words, e.g. "Refused: 1 of 1 real runs already used for this deposit; this attempt needs 1."
  - The start returns `refused`, and the desk shows a "Real-run budget · refused" card.
  - An answer typed by a person is still saved.

## 4. Agents

| Agent | Real or mock | Notes |
| --- | --- | --- |
| Investigator (Agent 1) | `FINANCE_AGENT_MODE=mock\|creao` | unchanged contract; CREAO adapter existed and now shares a client with the checker |
| Claim checker (Agent 2) | `CHECKER_MODE=mock\|creao`, default `mock` | code part always on; CREAO adapter + strict validator in `finance-core/src/checker`, called from the action; instructions in [creao-checker-agent.md](creao-checker-agent.md) |
| Mismatch agent (reconciliation mode) | mock only | runs only when `FINANCE_AGENT_MODE=mock`; same provider interface (`start`/`poll`), so a CREAO reconciler can plug in |
| Planted mistakes | mock only | the mock investigator misbehaves only on records marked `raw.recordType = "scorecard-plant"` |

`CHECKER_MODE` replaces `CHECKER_AGENT_MODE`, which is no longer read; the deployment had it unset. Its default changed from `off` to `mock`.

**Mismatch agent**:
- **Trigger**: anything that changes the books calls `recheckHeldProposals`. When the three-way check is mismatched, it schedules `financeReconciliation.autoStart`, which creates one orchestrator per new code-found cause, idempotently.
- **Input**: only the cause and the records it involves: its bank items (and a returned item's original deposit), their ledger entries, owners and linked documents.
- **Output**: an explanation, findings with sourceIds, and either one correcting entry (`record_bank_item` or `reverse_entry`, signed integer cents) or a question.
- **Checks before a person sees it**:
  - the output is validated strictly
  - every amount and name in a finding must be in its cited records
  - the entry is dry-run through the **correction lock**:
    - L3 evidence exists
    - L6 exact amount
    - L7 still proposed and not already recorded
    - R1 the three-way check no longer has that cause and has no new mismatch
- **Then**: it goes to `needs_person` with a proposed correction (`financeCorrections`), or to `rejected`.
- **Approval**: a person approves on the desk ("Approve entry"). The lock runs again with **L4** (not the requester, and not the person who recorded the bank item), then the entry is appended. A refusal is recorded and changes nothing; a rejection needs a reason. The old one-click code fix stays for causes the agent didn't propose a fix for.

## 5. Learning you can trust

Before a proposed rule can be approved, it is backtested against every past deposit a person decided (a posted, unreversed allocation). The desk card says, for example, "Would have handled 1 past deposit: 1 agree with what people decided, 0 disagree." and lists each disagreement.

- **Disagreement**: a rule with any disagreement can't be approved without a written reason. `approvePolicy` refuses, server-side.
- **Rules code can't replay**: these also need a reason. Executable forms exist for the insurance-claim and invoice rules (`finance-core/src/policy`).
- **Record**: the backtest, the reason and who approved it are saved in `financePolicyBacktests` and in the `policy_approved` event.

## 6. Scorecard and batch

**Measure… → Planted-mistake scorecard** creates a fresh DEMO law-firm account with six planted mistakes, each with its known right answer:

| Mistake | Right answer | Caught by |
| --- | --- | --- |
| Wrong client: the bank hint says Chen & Park; the letter says Westbrook HOA | checker stops it; nothing reaches approval | checker (code) |
| Duplicate Bayview wire | first wire allocated; second asks a person | investigator |
| Uncleared payout: $56,000 from a pending check | blocked by L2 | lock |
| Overdraw: $6,000 for Raymond Cho, who has $1,800 | blocked by L1 | lock |
| Unsupported claim: memo "quotes invoice INV-7781" | checker stops it; shows what the memo says | checker (code) |
| Bounced check: Okafor's posted $2,500 returned | mismatch agent proposes recording the return against Okafor; a person approves through the lock | mismatch agent |

The desk shows **"Caught 6 of 6 · wrong 0 · asked a person 2"**, scored live from saved state (`financeScorecard.getScorecard`).
- **Wrong**: the system did something other than the right answer, e.g. an allocation reached approval.
- **Asked a person**: it was caught by settling in `needs_person`.

**Measure… → Batch: 200 deposits** generates 200 deterministic synthetic deposits with known right answers and runs them through the ordinary pipeline. The mix is clear, invoice-exact, partial, duplicate, vague, pending and planted. The scorecard reports:
- **Time taken**: import to the last settled deposit.
- **% handled without a person**: `ready_for_approval` on the first attempt. Nothing posts without a person.
- **% flagged**: `needs_person`, `rejected` or `failed`.
- **How many matched their right answer.**

## 7. What was verified

**Commands**, from the repository root. pnpm was run as `npx --yes pnpm@10.20.0`.

| Command | Result |
| --- | --- |
| Baseline `… typecheck` / `… test` | exit 0 / 22 files, 158 tests |
| Final `… typecheck` | exit 0 |
| Final `… test` | 31 files, 228 tests, all pass |
| Final `… build:finance` | pass (adds `/reconciliation/[runId]`, `/scorecard/[accountId]`) |
| `convex env get FINANCE_AGENT_MODE` (read-only) | `mock`. Only `FINANCE_AGENT_MODE`, `CREAO_APP_ID`, `CREAO_API_KEY` are set; none changed |
| `convex dev --once` (×4) | pushed this branch's functions and additive schema to `laudable-sturgeon-5` for the click-through |

**New tests**:
- **finance-core**: orchestrator, checker provider and validator, reconciliation and correction lock, policy backtest, scorecard and batch.
- **Convex**: saved transitions and snapshots, idempotent start, retry, failure, timeout, budget refusals with fake CREAO credentials and no HTTP, the CREAO checker with fake HTTP, the mismatch agent and lock, the backtest gate, planted 6 of 6, a 40-deposit batch.
- **Render tests**: desk, inspector, mismatch run page, scorecard.

**Playwright click-through** (mock, local desk on :3001, dev deployment). Screenshots and the step log are in [`docs/screenshots/orchestration/`](screenshots/orchestration/).
- **Fresh law-firm run** (pool-021), feed steps 1–4. Pipeline: 1 ready for approval, 1 needs a person. Answering Okafor resumed the same orchestrator, and the inspector shows 11 saved steps ending "Ready for approval" (`01`, `02`).
- **Planted scorecard** (pool-022): "Caught 6 of 6 · wrong 0 · asked a person 2" 2.5 s after starting (`03`, `04`). The wrong-client run is rejected by the checker (`05`), and the bounced-check mismatch run shows the dry-run lock (`06`). Approving the fix as sam brought the books back to matched (`07`).
- **Batch** (pool-025): **200 deposits in 96.4 s · 65% handled without a person · 31% flagged · 200 of 200 matched the right answer**. The rest (4%) were waiting to clear (`08`, `09`).
- **At 390 px**: the scorecard and desk have no sideways scroll (`10`, `11`).
- **Earlier batch attempts**, before the save fixes:
  - pool-014: 156 of 200; 44 runs failed on write conflicts, mislabelled `provider_failure`
  - pool-023: 197 of 200 (3 `save_conflict`)
  - pool-024: 199 of 200
  - they and pools 012–020 are kept, as are all earlier DEMO accounts
- **Console**: clean. A duplicate React key (two identical Bayview wires in progress) was fixed.

## 8. Environment variables (Convex deployment)

| Name | Default | Purpose |
| --- | --- | --- |
| `FINANCE_AGENT_MODE` | (required) | `mock` or `creao` for the investigator |
| `CREAO_APP_ID`, `CREAO_API_KEY` | — | investigator app and its app-scoped `capi_` key |
| `CHECKER_MODE` | `mock` | `mock` or `creao`; anything else refuses to start investigations |
| `CREAO_CHECKER_APP_ID` | — | the checker agent's app ID (`creao` only) |
| `CREAO_CHECKER_API_KEY` | `CREAO_API_KEY` | the checker app's own `capi_` key |
| `PROVIDER_TIMEOUT_MS` | 20000 | one provider call's timeout |
| `MAX_REAL_RUNS_PER_DAY` | 5 | real runs per UTC day; `0` refuses all |
| `MAX_REAL_RUNS_PER_DEPOSIT` | 2 | real runs per deposit |
| `AUTO_INVESTIGATE`, `OUTSTANDING_MAX_DAYS` | unchanged | see finance-money-workflow.md |
| `MOCK_PROVIDER_FAULT` | unset | tests and demos only |

## 9. What you do in CREAO to switch to real

**Investigator.** The deployment already has `CREAO_APP_ID` and `CREAO_API_KEY`.
1. In the existing CREAO investigator agent, update the instructions: take the block in [finance-investigation.md](finance-investigation.md#copyable-creao-agent-instructions) and apply the two edits in [overnight-report.md §6](overnight-report.md#6-creao-agent-instruction-changes-exact-text). Without them, the agent is told never to propose an allocation. The input stays `finance_context`, and the output contract is unchanged.
2. Decide the budget, then set it if you want something other than 5 a day and 2 per deposit:
   ```powershell
   npx.cmd --no-install convex env set MAX_REAL_RUNS_PER_DAY 5
   npx.cmd --no-install convex env set MAX_REAL_RUNS_PER_DEPOSIT 2
   ```
3. Run `npx.cmd --no-install convex env set FINANCE_AGENT_MODE creao`.
4. **In creao mode**:
   - auto-investigation is off unless `AUTO_INVESTIGATE=true`
   - the live feed, scorecard and batch refuse to run
   - the mismatch agent doesn't start
   - answering a question, Rerun from step 3 and Try again start real runs, each one budget-checked and saying so

**Checker**: follow [creao-checker-agent.md](creao-checker-agent.md#what-you-do-in-creao-to-switch-the-checker-to-real):
1. A new agent with input `finance_context`, the instructions there, and an app-scoped key.
2. `CREAO_CHECKER_APP_ID`, `CREAO_CHECKER_API_KEY`, then `CHECKER_MODE=creao`.
3. It works with either investigator mode. With both real, each attempt is 2 real runs.

## 10. Limits and not done

- **No real CREAO run**: neither the checker nor the investigator was called in this work. The adapters are verified only with fake HTTP.
- **The mismatch agent is mock-only**: there is no CREAO reconciler app or instructions yet. In creao mode, mismatches show the existing code-found fix card.
- **Settling serializes per account**: the lock reads the whole account, and every settle appends to one event stream. 200 deposits take about 1.5 minutes and rely on save retries plus the bulk-import stagger. Real volumes need aggregates or a work pool (`@convex-dev/workpool`).
- **No recovery for an exhausted save**: a run that exhausts the save retries is `failed` (`save_conflict`) and needs **Try again**. For a CREAO run, the external run ID is kept, but there is no "check again" action.
- **The backtest is limited to known rules**: it only replays rules with an executable form (insurance claim, invoice). Others always need a written reason.
- **The scorecard is mock-only**: its planted wrong-client and unsupported-claim mistakes are scripted in the mock investigator.
- **The shared dev deployment now runs this branch**: the four `convex dev --once` pushes put this branch's code and the new tables on `laudable-sturgeon-5`. Other branches' code will replace it when they push.
- **Left untouched**: `packages/visual-audit`, `scripts/monitored-agent` and the teammate's ERP data were not modified. The uncommitted `packages/visual-audit/playground/next-env.d.ts` and `stash@{0}` are as found.
