# Client-money workflow

How deposits become owner money, how the three numbers are checked, and how the
lock decides payments. All data is synthetic: the sandbox ERP (`demo-erp-seed-42`)
and a `demo:`-prefixed fixture. Data mapping is in [erp-data-notes.md](erp-data-notes.md).

## Pieces

| Concern | Pure code (finance-core) | Convex |
| --- | --- | --- |
| Source adapter | `src/intake/` (`normalizeErpState`, `dollarsToCents`), `fixtures/demoMoney.ts` | `financeIntake.importErpSandbox`, `loadDemoFixture` |
| Ledger + three-way | `src/ledger/` (`importLedgerEntries`, `ownerBalances`, `threeWayCheck`, `buildReversalEntries`) | `financeIntake.getAccountOverview` |
| Lock | `src/gateway/` (`evaluatePayment`, `evaluateAllocation`, `TRANSITIONS`, `buildPostingEntries`) | enforced in `convex/lib/money.ts` (`submitProposal`, `gatedStep`) |
| Approve then post | — | `financeProposals.*` |
| Investigation context | `src/intake/context.ts` (`buildDepositRecordSet`) | `financeIntake.ensureDepositTask`, existing `financeInvestigations.*` |

## Ledger

`financeLedgerEntries` is insert-only. Kinds: `deposit_received`, `allocation`,
`disbursement`, `reversal`, `fee`, `adjustment` (opening balances). `ownerId: null`
is the unallocated bucket. An allocation is a pair: −X unallocated, +X owner.
Corrections are `reversal` entries with `reversesEntryId`.

Availability: an entry with `fundsSourceId` counts as cleared only while that
bank transaction is cleared. Opening balances carry a fixed `clearedCents`.
Available = cleared − holds, where holds are payment proposals that are
pending approval or approved.

## Three numbers

- **Bank**: the statement balance at cutover, plus bank-feed activity after it, plus reconciling items. Pending items are included and also reported separately.
- **Books**: the sum of ledger entries.
- **Owners**: every owner's posted balance plus unallocated.

`matched` requires all three to be equal and no mismatch-severity cause. Causes
found by code: `BANK_TXN_WITHOUT_LEDGER_ENTRY`, `LEDGER_ENTRY_WITHOUT_BANK_TXN`,
`AMOUNT_MISMATCH`, `DUPLICATE_POSTING`, `UNKNOWN_OWNER_ENTRY`, `CURRENCY_MISMATCH`
and `NO_OPENING_BALANCE` are mismatches. `UNCLEARED_DEPOSIT_ALLOCATED` and
`RECONCILING_ITEM_WITHOUT_DETAIL` are warnings. Each cause lists sourceIds and
the owners whose outflows it affects. A payment posts a disbursement tagged
`PAY:<proposalId>`. Until the bank feed shows that reference, the account
correctly shows `LEDGER_ENTRY_WITHOUT_BANK_TXN` for that owner.

## Lock rules

| Rule | Code | Applies to |
| --- | --- | --- |
| L1 | `OWNER_INSUFFICIENT_FUNDS` | Payment exceeds the owner's posted balance minus holds. Pool cash never counts. |
| L2 | `FUNDS_NOT_CLEARED` | Payment fits posted but not available funds, or names a pending funding deposit |
| L3 | `MISSING_EVIDENCE` | No cited sourceId, a cited sourceId not in our records, or an unknown owner |
| L4 | `SELF_APPROVAL` | Requester approves, posts or reverses their own request |
| L5 | `RECONCILIATION_MISMATCH` | Payment for an owner or funding source named by a mismatch cause, or any payment when a cause is unattributed or there is no opening balance. Allocations are allowed. |
| L6 | `AMOUNT_INTEGRITY` | Non-positive or non-integer cents; currency; shares ≠ deposit; duplicate owners; deposit not recorded, already allocated, or with an open competing proposal |
| L7 | `STATE` | Transition not in the state machine |

State machine: `proposed → pending_approval | blocked`,
`pending_approval → approved | rejected | blocked`, `approved → posted | blocked`.
`posted`, `rejected` and `blocked` are terminal.

Every rule runs at request, again at approval, and again at posting. Each check,
pass or fail, appends a `finance.money.lock_checked` event and snapshot to the
account stream `money:<accountId>`. A failure never throws, so the blocked
attempt is saved rather than rolled back.

## Auto-investigation

An import can make a deposit newly investigable in two ways: by inserting a new
`deposit_received` entry, or by changing a recorded deposit from pending to cleared
on re-import. The import then checks `AUTO_INVESTIGATE` together with
`FINANCE_AGENT_MODE`:

| Mode | `AUTO_INVESTIGATE` unset | `true` | `false` |
| --- | --- | --- | --- |
| `mock` | on | on | off |
| `creao` | **off**, so no paid run starts without a person | on (explicit opt-in) | off |
| unset / invalid provider config | off | off | off |

Any value other than `true`/`false` turns it off (`AUTO_SETTING_INVALID`).

- **When on**: the import schedules `financeIntake.autoInvestigateDeposit`. When that runs, it rechecks the setting and the deposit's eligibility, and starts the investigation through the existing `financeInvestigations.startInvestigation`.
- **One investigation per deposit**: if the deposit's task already has any run, it is skipped with `ALREADY_INVESTIGATED`.
- **Events**: every start or skip appends a `finance.money.auto_investigation` event with `allowed` and the reason code in the snapshot's lock facts. Codes: `AUTO_STARTED`, `ALREADY_INVESTIGATED`, `AUTO_OFF_IN_CREAO`, `AUTO_DISABLED_SETTING`, `AUTO_SETTING_INVALID`, `MODE_NOT_CONFIGURED`, `PROVIDER_NOT_CONFIGURED`, `AWAITING_CLEARANCE`, `NOT_RECORDED`, `ALREADY_ALLOCATED`, `START_FAILED`.
- **Approval**: resulting allocation proposals still wait for a person to approve.
- **Checking the setting**: `financeInvestigations.getAutoInvestigationSetting` reports it, and the money panel shows it.

## API

| Function | Purpose |
| --- | --- |
| `financeIntake.importErpSandbox()` / `loadDemoFixture()` | Idempotent upserts by sourceId; ledger entries insert-only |
| `financeIntake.listAccounts()` / `getAccountOverview({accountId, cutoff?})` | Three-way result, balances, deposits with status, proposals, latest entries |
| `financeIntake.ensureDepositTask({accountId, bankSourceId})` | Investigation task for a cleared, recorded, unallocated deposit |
| `financeIntake.getDepositSubject({taskId})` | Task and readable evidence for the investigation view |
| `financeIntake.simulateUnrecordedOutflow()` / `simulateSettlement({proposalId})` | DEV ONLY, DEMO account only |
| `financeProposals.requestPayment` / `proposeAllocation` | Create a proposal; the lock result is returned and saved |
| `financeProposals.approveProposal` / `postProposal` / `rejectProposal` / `reversePosting` | Gated steps; posting is atomic and idempotent |
| `financeProposals.listTransitions({proposalId})` | Append-only transition history with lock results |
| `finance.listMoneyEvents` / `listMoneySnapshots({accountId, afterSequence?})` | Account money stream |

Identity: when `ctx.auth` has a user, its `tokenIdentifier` is used. Otherwise
the dev role switcher's name is recorded as `dev-unverified:<name>`. This is
**not** authorization; it is dev-only labelling. Production authentication is
required before using these endpoints with real data.

## Investigation input additions (still finance-investigation-input/v1)

These fields are optional and absent on legacy inputs:

- `records.sourceAdapter`
- `records.bankTransactions` (the deposit plus its duplicate and same-reference partners)
- `records.obligations` (invoices)
- `records.ownerLedgerBalances` (candidate owners; sourceId `ledger:balance:<ownerId>@<cutoff>`)
- `deterministicChecks.threeWay`

For intake deposits, `existingAllocations` comes from the ledger, and
`allocationHistoryComplete` is true when the deposit is recorded there. A
reviewer rejection is saved as a clarification whose `questionId` ends in
`:rejection`. When the investigator returns `proposal_ready`, the validated
allocations are queued through the same lock as a person's proposal. They are
never posted automatically.
