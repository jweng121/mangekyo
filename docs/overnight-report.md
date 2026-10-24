# Overnight report — core money workflow

Branch **`edwin-core-money-flow`**, based on `Edwin` at `92ccecc` (it contains
`52eb0a2`; checked with `git merge-base --is-ancestor`). Seven local commits.
Nothing was pushed. Mock mode only: no CREAO run was started, and no secrets or
`.env` values were read or committed.

## Summary

- **Status**: all four parts are built end to end in code and covered by tests: source adapter, three-way check, lock, and approve-then-post. Demo scenarios A–E pass as Convex function tests.
- **Final gate (`c4d23bc`)**: typecheck passes; 12 test files / 107 tests pass; both builds pass.
- **Not done**: the UI was not used in a browser against a live backend (see section 8).
- **Before demoing**: running `dev:backend` will push these functions and the new schema to the shared dev deployment. Confirm `FINANCE_AGENT_MODE=mock` there first.

## 1. What was built

### Step 0: discovery

- [docs/erp-data-notes.md](erp-data-notes.md) covers his data: where it lives, record types, examples, counts, IDs, cents handling, gaps, and the mapping.
- Baseline before any change: typecheck pass, 6 files / 49 tests pass, both builds pass.

### Step 1: source adapter

- **Contracts**: [packages/contracts/money.ts](../packages/contracts/money.ts) is a new file. There are optional v1 additions in `investigation.ts`, plus `accountId`/`bankSourceId` on `FinanceTask`, and `MoneyEvent`/`MoneySnapshot` in `events.ts`/`snapshots.ts`.
- **Adapter**: [packages/finance-core/src/intake/](../packages/finance-core/src/intake/)
  - `cents.ts`: exact decimal → cents; never `float * 100`.
  - `erp.ts`: deterministic sourceIds such as `bank:txn:TX-001`, `erp:invoice:INV-001`, `erp:document:DOC-OWN-002:v1`, with a `raw` pointer on every record. Unrepresentable rows become `issues` and are never rounded.
  - `context.ts`: scoped deposit investigation records.
- **Demo fixture**: [packages/finance-core/fixtures/demoMoney.ts](../packages/finance-core/fixtures/demoMoney.ts). Every ID starts with `demo:` and every name with `DEMO`.
- **Convex import**: [convex/financeIntake.ts](../convex/financeIntake.ts) `importErpSandbox` / `loadDemoFixture`.
  - Source rows are upserted by sourceId, and unchanged rows are not rewritten.
  - Ledger rows are insert-only by deterministic `entryId`. A second import inserts nothing; this is tested.
- **Investigation context**: for an ERP/demo deposit it carries the deposit, candidate owners (record hint, owners named in linked documents, reference-matched invoices), linked documents and the candidates' agreements, related invoices, candidate owner balances, approved policies, clarifications, existing code checks, and `deterministicChecks.threeWay`.

### Step 2: ledger and three-way check

- [packages/finance-core/src/ledger/index.ts](../packages/finance-core/src/ledger/index.ts): `importLedgerEntries`, `ownerBalances` (posted / cleared / holds / available), `threeWayCheck` with code-found causes and sourceIds, `affectedOwners`, `buildReversalEntries`, `activeAllocations`.
- **Table**: `financeLedgerEntries` is append-only. Corrections go through `financeProposals.reversePosting`.
- **Real ERP data**: bank $301,500.00 − $1,500.00 timing = books $300,000.00 = owners $291,750.00 + unallocated $8,250.00 → **matched**, with one warning: the ERP's timing adjustment has no detail.

### Step 3: the lock

- [packages/finance-core/src/gateway/index.ts](../packages/finance-core/src/gateway/index.ts): L1–L7 as pure functions, each with a reason code, message, sourceIds and facts.
- [convex/lib/money.ts](../convex/lib/money.ts): `submitProposal` and `gatedStep` run every rule at request, approval and posting. Each check writes a `finance.money.lock_checked` event and snapshot. Failures are saved, never thrown away.

### Step 4: approve then post

- [convex/financeProposals.ts](../convex/financeProposals.ts): `requestPayment`, `proposeAllocation`, `approveProposal`, `postProposal`, `rejectProposal`, `reversePosting`, `listTransitions`.
- **Posting**: one mutation re-runs all rules, writes entries, marks the proposal posted, and appends events and snapshots. A second call returns `alreadyDone` and writes nothing.
- **Agent proposals**: `proposal_ready` results from an investigation are queued automatically through the same lock ([convex/financeInvestigations.ts](../convex/financeInvestigations.ts) `queueAgentAllocations`). They are never posted automatically.
- **Rejections**: saved as a task clarification (`questionId` ends in `:rejection`) that the next attempt receives.

### Step 5: UI

- [apps/finance-dev/app/MoneyPanel.tsx](../apps/finance-dev/app/MoneyPanel.tsx), added to the existing page above the original synthetic case, which still works.
- It contains:
  - a dev-only role switcher
  - import buttons
  - the three-numbers panel with causes and warnings
  - the owner balances table
  - the deposits list with Investigate
  - the proposal queue with approve, reject (reason required), post and reverse
  - the payment request form with an immediate lock result
  - posted ledger entries
  - the money event stream
  - DEMO-only bank simulations
- `FinanceInvestigationView` now takes a `subject`, so intake deposits reuse the existing start / answer / resume flow.
- Docs: [docs/finance-money-workflow.md](finance-money-workflow.md).

## 2. Commits (local, `edwin-core-money-flow`)

| Hash | Message |
| --- | --- |
| `c6d639e` | Add money contracts, ERP source adapter, demo fixture and three-way ledger check |
| `6d44518` | Add gateway lock rules L1-L7 and proposal state machine |
| `f645940` | Scope deposit investigation context and make mock propose from source evidence |
| `413fdb0` | Add Convex money tables, idempotent ERP/demo import and account overview |
| `8b638ac` | Enforce lock rules in approve-then-post mutations and queue agent allocations |
| `d31de99` | Add client-money panel to finance-dev: three numbers, balances, deposits, approvals, payments |
| `c4d23bc` | Add reversal corrections and extend L5 to affected funding sources |

A final commit adds this report and `docs/finance-money-workflow.md`.

`413fdb0` does not type-check on its own: its regenerated `api.d.ts` references
`financeProposals.ts`, which arrives in `8b638ac`. Every later commit, and the
tip, passes.

## 3. Commands run and results

All commands were run from the repository root. pnpm was run as `npx.cmd --yes pnpm@10.20.0`.

| Command | Result |
| --- | --- |
| `git merge-base --is-ancestor 52eb0a2 HEAD` | exit 0 (contains it) |
| `git switch -c edwin/core-money-flow` | **failed**: `refs/heads/edwin` exists (see Decisions) |
| `git switch -c edwin-core-money-flow` | ok |
| Baseline `… typecheck` / `… test` / `… build:finance` / `… --filter @mangekyo/demo-erp build` | pass / 6 files, 49 tests pass / pass / pass |
| `node_modules/.bin/tsx <scratchpad>/profile.ts` | read-only profile of `createSeed(42)` for the notes |
| `vitest run --project finance packages/finance-core` (after Steps 1–3) | 7 files, 63 tests pass |
| `node_modules\.bin\convex.cmd codegen --typecheck disable` | ok; regenerated `convex/_generated/api.d.ts` (see note below) |
| `tsc --noEmit -p convex/tsconfig.json` | 3 errors at first (widened return types, a generic loader); fixed; passes |
| `vitest run --project finance convex` | 35/36 at first (duplicate L7 reason); fixed → 36/36 |
| `… typecheck` (mid-step) | failed: widening task snapshot queries broke existing callers' types. I reverted to separate money-stream queries; passes |
| `vitest run --project finance apps/finance-dev` | 1/1 (MoneyPanel server render using real convex-test query results) |
| **Final** `… typecheck` | **exit 0** (convex, tests, all 6 workspace packages) |
| **Final** `… test` | **12 files, 107 tests, all pass** |
| **Final** `… build:finance` | **pass** |
| **Final** `… --filter @mangekyo/demo-erp build` | **pass** |
| Playwright (`tests/e2e`) | **not run**: no browsers are installed, and it covers his app, not mine |

**Codegen note**: `convex codegen` printed "Downloading current deployment state…
Uploading functions to Convex…". With this Convex version, codegen contacts the
configured dev deployment to analyse the app. Its help text says it does not
modify code running on the deployment. I did not run `convex dev`, `deploy` or
`env set`, and changed no deployment settings.

## 4. How to demo A–E

**Setup**

1. Confirm the dev deployment is in mock mode: `npx.cmd --no-install convex env get FINANCE_AGENT_MODE` should print `mock`. If not, set it deliberately yourself; this work did not change it.
2. Run `npx.cmd --yes pnpm@10.20.0 dev:backend`. **This pushes the new functions and schema (10 new tables plus one index on `financeTasks`) to `laudable-sturgeon-5`.**
3. In a second terminal, run `npx.cmd --yes pnpm@10.20.0 dev:finance` and open http://localhost:3001. Do not run his demo-erp at the same time: it also uses port 3001.
4. Click **Import ERP sandbox (seed 42)**, then **Load DEMO fixture**. Clicking either again changes nothing ("0 inserted").

**Follow-up (auto-investigation):** in mock mode with `AUTO_INVESTIGATE` unset, importing now starts one investigation per new cleared, unallocated deposit (TX-001, TX-002, A-001, B-001). In A and B below, **Investigate** then opens a task that already has its result, so you don't need to click Run investigation. In creao mode this is off unless `AUTO_INVESTIGATE=true`. See [finance-money-workflow.md](finance-money-workflow.md#auto-investigation).

Role switcher: requester `riley`, approver `sam`. Using the same name in both roles counts as the same person.

**A. Clear deposit → proposal → approve → posted (ERP)**

1. Choose the account "Sandbox ERP pooled trust accounts". The panel is green at $300,000.00, with a timing-item warning.
2. On deposit `bank:txn:TX-001` ($3,250.00, unallocated), click **Investigate**, then **Run investigation**. The mock returns `proposal_ready` and cites `bank:txn:TX-001` and `erp:document:DOC-PAY-001:v1`.
3. Under Proposals, a `pending_approval` allocation to Client A appears, with nothing posted yet.
4. Switch to approver and click **Approve**, then **Post to ledger**.
5. TX-001 shows "posted → Client A — Alder Trust". Client A's balance is +$3,250.00, unallocated is −$3,250.00, and the three numbers stay matched.
6. The Post button disappears once a proposal is posted. Idempotent re-posting (a second call returns `alreadyDone` and writes nothing) is covered by a convex-test test, not the UI.
7. Optional: Reject (with a reason) on a fresh proposal, then rerun the investigation. The next attempt receives the reason and asks a question instead of proposing.
8. The DEMO deposit `demo:bank:txn:A-001` works the same way.

**B. Unclear deposit → question → answer → resume (DEMO)**

1. On the DEMO account, find deposit `demo:bank:txn:B-001` ($980.00, "TRANSFER 4471").
2. Click **Investigate**, then **Run investigation**. The result is `needs_information`, with a question about who sent the $980.00 deposit.
3. Type an answer and click **Save answer and resume**. Attempt 2 is linked to attempt 1, and no allocation is made.

**C. The money shot: L1 (DEMO)**

1. As requester, in the Payment request form choose Owner **DEMO Owner X — Xavier Trust**.
2. Enter amount `5000.00`, purpose "annual property tax", and evidence "DEMO payment instruction from DEMO Owner X".
3. Click **Submit payment request**. The result is blocked with `L1 OWNER_INSUFFICIENT_FUNDS`: "has $120.00 available … The pooled account holds $268,100.00 cleared, but other owners' money cannot fund this payment."
4. The proposal is saved as `blocked`.

**D. Uncleared funds: L2 (DEMO)**

1. Request a payment for **DEMO Owner D — Delta Trust**: `2000.00`, evidence "DEMO payment instruction from DEMO Owner D".
2. It is blocked with `L2 FUNDS_NOT_CLEARED`: "$3,000.00 posted but only $500.00 available; $2,500.00 has not cleared", citing `demo:bank:txn:D-001`.
3. Alternatively, choose "Funded by deposit: demo:bank:txn:D-001 · pending".

**E. Mismatch → L5 (DEMO)**

1. Request `1000.00` for **DEMO Owner Y — Yankee Trust**, with Yankee's instruction as evidence. The request is allowed.
2. As approver, click Approve, then Post. The panel turns **red**: `LEDGER_ENTRY_WITHOUT_BANK_TXN`, "affects DEMO Owner Y".
3. As requester, request another payment for Owner Y. It is blocked with `L5 RECONCILIATION_MISMATCH`.
4. A request for DEMO Alpha is still allowed.
5. On the posted payment, click **DEV: simulate bank settlement**. The panel goes green.
6. Alternatively, click **DEV: simulate unrecorded bank outflow (scenario E)**. The panel turns red with `BANK_TXN_WITHOUT_LEDGER_ENTRY demo:bank:txn:E-001`, affecting Owner Y.

## 5. Decisions to review

1. **Branch name**
   - What: `edwin-core-money-flow`, not `edwin/core-money-flow`.
   - Why: Windows refs are case-insensitive, so the existing `Edwin` branch occupies `refs/heads/edwin`. Renaming or deleting branches was off-limits.
2. **One pooled ERP account**
   - What: `erp:account:trust-pool` covers TRUST-01 and TRUST-02.
   - Why: his bank, cash-book and suspense figures exist only in total. The sub-account is kept on every record.
3. **Cutover snapshot**
   - What: ERP owner closings are opening balances at the "Seeded" activity time (2026-10-23T09:00Z). Pre-cutover bank transactions count as reflected in those balances; only post-cutover activity is matched 1:1.
   - Why: his ledger aggregates do not tie to individual transactions, so rebuilding history would mean fabricating entries.
4. **Suspense deposits**
   - What: TX-001 and TX-002.
   - Why: this comes from his hard-coded check in `financial-controls.ts` `post()`. The import verifies that they sum to `suspenseBalance` and refuses otherwise.
5. **Timing adjustment**
   - What: −$1,500 is applied to the bank side as a reconciling item, with a non-blocking warning (`RECONCILING_ITEM_WITHOUT_DETAIL`).
   - Why: his own reconciliation uses it.
   - The strict alternative: make it a mismatch. That would turn the ERP account red and block all of its outflows under L5.
6. **Bank balance includes pending items**
   - What: the bank ledger balance includes pending items; cleared and pending are reported separately.
   - Why: a pending deposit that clears later then doesn't change the matched total.
7. **Opening balances use kind `adjustment`**
   - Why: the spec's kind list has no `opening_balance`. Adding one would be a small, reversible change.
8. **Auto-recorded deposits**
   - What: post-cutover inflows are recorded at import as `deposit_received` in unallocated.
   - Why: the books record what the bank shows, and ownership is decided later. Unrecorded *outflows* are not auto-recorded; they are flagged.
9. **Allocating pending deposits**
   - What: the gateway allows it, because money moves between buckets and availability already excludes uncleared funds. The three-way check warns `UNCLEARED_DEPOSIT_ALLOCATED`.
   - The agent validator is unchanged and still rejects proposals for uncleared deposits.
10. **`blocked` is terminal**
    - What: a temporary L5 mismatch at posting time blocks an approved proposal, and a new request is needed.
    - Why: this is the safe choice. Keeping it `approved` would be friendlier but leaves an approved payment waiting.
11. **Posted payments show a mismatch until settlement**
    - What: a posted payment shows `LEDGER_ENTRY_WITHOUT_BANK_TXN` until the bank feed shows `PAY:<id>`.
    - Why: this is real reconciliation behaviour.
    - Consequence: settlement can only be simulated on the DEMO account, because I don't fabricate bank-feed rows on his ERP data. **A payment posted on the ERP account stays red.**
12. **Dev identity**
    - What: the identity is `dev-unverified:<name>` from a client argument when no auth is configured, and the role is not part of the identity. This deliberately departs from the Convex guideline against identity arguments.
    - Why: it is dev-only, labelled in the UI, and `ctx.auth` takes precedence when present. It is not authorization.
13. **Allocation history**
    - What: `allocationHistoryComplete = true` for intake deposits recorded in our ledger.
    - Why: after import the ledger is the system of record for those deposits, so duplicate checking is possible. The legacy synthetic case still reports `false`.
14. **Mock proposal rule**
    - What: the mock proposes only when the linked documents name exactly one known owner and state the exact deposit amount, and there was no prior rejection. Otherwise it asks questions.
    - The validator was not weakened. Its citation set now includes the new frozen record kinds (`bankTransactions`, `obligations`, `ownerLedgerBalances`), and citations must still exist in the frozen input.
15. **Import source**
    - What: the ERP import reads `createSeed(42)` directly (a read-only import of his file from Convex), not his runtime `state.json`.
    - Why: deterministic, and independent of what his app last did.
16. **New shared contract file**
    - What: `packages/contracts/money.ts`, plus one additive line in `index.ts` and one in `package.json`. No renames or removals.
17. **Task event queries**
    - What: `listTaskEvents`/`listTaskSnapshots` filter out money-stream rows, and the new `listMoneyEvents`/`listMoneySnapshots` serve them.
    - Why: widening the existing return types broke callers' type checks.
18. **No task-created event for intake tasks**
    - Why: the existing `TaskCreatedEvent` actor is fixed to `finance-dev.synthetic-seed`. Investigation events start at sequence 1.
19. **Query cutoff**
    - What: an omitted `cutoff` on `getAccountOverview` means latest records.
    - Why: Convex queries can't read the clock. Mutations use the server time.
20. **Pending deposits can't be investigated**
    - Why: v1 `transactions` are typed `bankStatus: "cleared"`. Widening that would change the contract.
21. **Shared and style changes**
    - `vitest.config.ts` got an additive include for `apps/finance-dev/tests/**/*.test.tsx`.
    - `packages/finance-core/package.json` was reformatted when rewritten as JSON; it is the same keys plus new exports.

## 6. CREAO agent instruction changes (exact text)

Replace this sentence in the instructions in `docs/finance-investigation.md`:

> The current sample lacks that history, so do not propose an allocation.

with:

```text
records.allocationHistoryComplete tells you whether complete allocation history
was supplied. If it is false, do not propose an allocation. If it is true,
records.existingAllocations lists every allocation already posted for the
deposit; do not propose an allocation for a deposit that already has one.
```

Then add this block after the paragraph that starts "Use only source identifiers":

```text
Inputs from the money source adapter may also contain these optional fields:
- records.sourceAdapter: which system (erp or demo) and dataset version the records come from.
- records.bankTransactions: the bank-feed view of the deposit and any duplicate or
  same-reference transactions. ownerHintSourceId is the owner the bank/ERP record names;
  it is a hint, not proof. duplicateOfSourceId marks a suspected duplicate; never propose
  an allocation for a suspected duplicate.
- records.obligations: invoices for candidate owners or matching the deposit reference.
  An invoice amount that differs from the deposit is a finding, not a reason to adjust
  the deposit amount.
- records.ownerLedgerBalances: code-computed posted, cleared and available balances for
  candidate owners at the cutoff.
- deterministicChecks.threeWay: code-computed bank = books = owners result. If its
  status is not "matched", report the listed causes as findings by their code and
  sourceIds. Do not compute, repair or explain away totals yourself.
All of these sourceId values may be cited.

A human clarification whose questionId ends in ":rejection" is a reviewer's rejection
of an earlier proposed allocation. Do not propose the same allocation again. Explain
which independent evidence would resolve the reviewer's concern, and ask for it.

Propose an allocation only when a supplied source document links the deposit to one
specific owner in records.owners and states the deposit amount, and
records.allocationHistoryComplete is true. A proposed allocation is queued for human
approval; it is never posted by you or automatically.
```

The vague-note paragraph ("For the vague sample remittance note, ask who sent
the $1,250 deposit…") can stay. It still applies to the original synthetic case.

## 7. Requests for jweng121 (nothing of his was edited)

1. **Port**: `demo-erp` and `finance-dev` both use port 3001 (`dev` scripts, `.env.example`, `playwright.config.ts`). Could the demo ERP move to 3002?
2. **`timingAdjustments`**: please give the −1,500 a source and line items (what it is, and which transactions). With that, the finance check can treat it as fully documented.
3. **Stable IDs and dates**: owner ledgers need a stable owner ID instead of only a display name, plus an as-of date. Bank and book balances per trust account (TRUST-01, TRUST-02), not only pooled, would also help.
4. **Suspense**: please list the deposits in `suspenseBalance` in the data instead of hard-coding `["TX-001","TX-002"]` in `post()`.
5. **Pending items**: please say whether `TX-014`/`TX-015` (Pending) are inside `bankBalance`, and add clearing dates.
6. **Locale formatting**: payment-confirmation amounts use `toLocaleString()` without a locale, so the text depends on the machine. Please use a fixed `en-US` format.
7. **Duplicate pair**: `TX-012`/`TX-013` are flagged as duplicates but have different amounts (2,900 vs 2,500). Is that intended?
8. **Invoice amounts**: invoice amounts rarely match the deposits that reference them (for example `INV-001` 5,000 vs `TX-001` 3,250). If deliberate (partial payments), a note in the data would help.
9. **Agreements**: there are agreements only for clients A and B; C–F have none.
10. **pnpm config**: `pnpm-workspace.yaml` `allowBuilds:` isn't read by pnpm 10, so install warns "Ignored build scripts: esbuild". pnpm 10 uses `onlyBuiltDependencies`.

## 8. Known gaps and what is not verified

- **No real CREAO run.** Real-agent behaviour with the new input fields is unverified; it needs the instruction changes in section 6 first.
- **No browser check.** The UI was not exercised in a browser against a live backend. Here is what was checked instead:
  - type checks and the production build
  - a server-render smoke test of `MoneyPanel` using real query results from convex-test (mocked hooks)
  - convex-test coverage of every mutation and scenario A–E

  Click-through behaviour (forms, buttons, live updates) is untested.
- **Not deployed.** The new Convex functions and tables are not on the dev deployment yet. The first `dev:backend` will push them. The deployment's `FINANCE_AGENT_MODE` is unknown to me.
- **ERP payment settlement.** Posted payments on the ERP account cannot be settled (decision 11), so they stay red.
- **Reversals are ledger-only.** Reversing a payment does not create a bank-side refund; if the payment had settled, the three-way check flags the reversal.
- **Approval and posting by one person.** One approver can both approve and post. Only requester ≠ approver/poster is enforced.
- **Development limits.** Accounts are capped at 2,000 rows per table, and reads are full-account scans. They need aggregates or pagination before real volumes. Proposal IDs count existing rows; Convex transactions serialise this, but concurrent creates will retry.
- **Single currency.** Holds come only from payment proposals that are pending approval or approved.
- **Not run.** Playwright e2e was not run. The visual-audit handoff is still `not_connected`.
- **Uncommitted files left as found.** The teammate's generated `packages/visual-audit/playground/next-env.d.ts` change and the untracked `apps/finance-dev/.env.example` were left untouched and uncommitted. The earlier stash `stash@{0}` is still present.
