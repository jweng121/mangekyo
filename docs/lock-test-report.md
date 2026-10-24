# Lock rules — UI click-through test

- **Date**: 2026-10-24
- **Setup**: the real finance-dev UI at http://localhost:3001 (already running), against the dev deployment `laudable-sturgeon-5` (provider mode `creao`) with `dev:backend` running.
- **Driver**: Playwright Chromium, headless. The script cannot click any button whose text mentions an investigation, and it aborts if an investigation mutation is ever sent. No investigation was started.
- **Account**: DEMO pooled client account (`demo:account:pool-001`). Auto-investigation showed `off · AUTO_OFF_IN_CREAO`.
- **Screenshots**: `docs/screenshots/lock-tests/`. `run*-*.png` are full-page captures at the moment of each action; `crop-*.png` are readable crops of the final state.

## Starting state

From `00-initial-state.png`:

- **Three-way**: mismatched.
  - Bank $268,600.00, Books $270,600.00, Owners $270,600.00.
  - Bank − books = −$2,000.00.
  - Cause: `BANK_TXN_WITHOUT_LEDGER_ENTRY demo:bank:txn:E-001` (the simulated unrecorded outflow), which affects only DEMO Owner Y.
- **Alpha**: posted $250,000.00, available $250,000.00.

## Results

| # | Action | Expected | Actual | Result |
| --- | --- | --- | --- | --- |
| 1 | Requester riley: Owner Y, $1,000.00, Y's payment instruction | Blocked, L5 | `pay:0002` **blocked**: `L5 RECONCILIATION_MISMATCH … BANK_TXN_WITHOUT_LEDGER_ENTRY` citing `demo:bank:txn:E-001`. Rules checked L7, L6, L3, L2, L1, L5. | **Pass** |
| 2 | Requester riley: Owner D, $1,000.00, D's instruction, funded by D-001 | Blocked, L2 | `pay:0003` **blocked** by two L2 reasons: "Funding deposit demo:bank:txn:D-001 has not cleared" and "$3,000.00 posted but only $500.00 available; $2,500.00 has not cleared". No L5, because the mismatch doesn't touch Owner D or D-001. | **Pass** |
| 3 | Requester riley: DEMO Alpha, $1,000.00, Alpha agreement | Allowed, pending approval, no L5 | `pay:0004` (first run) and `pay:0005` (rerun) are both **pending_approval**; "Allowed at request". L5 correctly ignored the Owner Y mismatch. | **Pass** |
| 4 | Approve that request as approver "riley" | Blocked, L4 | Refused with `L4 SELF_APPROVAL`, **but** in the first run the refusal moved `pay:0004` to terminal `blocked` (events #15–#16). | **Bug** (fixed below) |
| 4 (rerun) | Same, after the fix | L4 refusal; request stays usable | `pay:0005`: "action refused; it stays pending_approval". L4 is logged (event #20) and no transition is recorded. | **Pass** |
| 5 (first run) | Approver sam: approve, then post | New ledger entry | Impossible: `pay:0004` was already `blocked`, so no Approve button was shown. | **Fail**, caused by the bug in step 4 |
| 5 (rerun) | Approver sam: approve, then post `pay:0005` | One new ledger entry; Alpha −$1,000; three-way changes only by that payment | "approved" → "posted". New entry `pay:0005:entry:1`, disbursement, Alpha, −$1,000.00, by `dev-unverified:sam`. Alpha posted $250,000.00 → **$249,000.00**. Books and owners $270,600.00 → **$269,600.00**; bank unchanged at $268,600.00. Bank − books −$2,000.00 → −$1,000.00. | **Pass** (see note) |
| 5b | Post `pay:0005` again | Nothing changes | The UI hides Post once posted, so I sent the identical `postProposal` call (as sam) to the live backend. It returned `alreadyDone: true`, status `posted`. Ledger entries stayed 8, the proposal's entries stayed 1, and books, bank and Alpha's balance were unchanged. | **Pass** |

**Note on step 5:** a new cause `LEDGER_ENTRY_WITHOUT_BANK_TXN` (for `PAY:demo:account:pool-001:pay:0005`, affecting Alpha) appeared after posting. This is by design: the books show the payment and the bank feed doesn't yet. So Alpha's further payments are now blocked by L5 until the settlement arrives (**DEV: simulate bank settlement**). The −$1,000 payment also happens to offset half of the E-001 −$2,000 gap. That is why bank − books moved to −$1,000 rather than staying at −$2,000.

## Bug found and fixed

**What happened:** any refused approve or post moved the proposal to terminal `blocked`, including refusals caused by *who* was acting (L4) or by an invalid action (L7, e.g. posting a still-pending proposal). The requester, or anyone using the role switcher, could therefore permanently kill a valid request by attempting to approve or post it.

**Fix:** in `convex/lib/money.ts` `gatedStep`, an L4 or L7 refusal is still evaluated, logged as `finance.money.lock_checked` with its full lock result and snapshot, and returned to the caller. The proposal's status is left unchanged. Failures about the money itself (L1, L2, L3, L5, L6) still block the proposal as before. **No rule was relaxed: every refused action is still refused.**

The UI now reports "action refused; it stays pending_approval" instead of "is now pending_approval".

**Tests** in `convex/financeMoney.test.ts`:

- **Updated**:
  - Posting a pending proposal is refused with `STATE`, the proposal stays `pending_approval`, and no entries are written.
  - The L4 test now expects a refused self-approval to leave the proposal `pending_approval` with a `SELF_APPROVAL` lock event.
- **New**: "a refused self-approval does not end the request…" reproduces this click-through with E-001 present.
  - riley's approve and post are refused.
  - sam approves and posts.
  - There is exactly one −$1,000 Alpha disbursement, and Alpha and books drop by $1,000 while the bank is unchanged.
  - A second post returns `alreadyDone` and adds no entries.
  - Transitions are `proposed → pending_approval → approved → posted`.
- **Checked against the old code**: with the fix reverted, these 3 tests fail; with it restored, they pass. While the fix was reverted for that check, `dev:backend` (watching files) briefly pushed the reverted file. The final rerun above used the restored, fixed code.

**Live data left behind** (nothing is deleted, by design): `pay:0002` and `pay:0003` are blocked as intended. `pay:0004` stays `blocked` from the bug. `pay:0005` is posted and unsettled. You can settle it with **DEV: simulate bank settlement** or correct it with **Reverse posting**.

## Other observations

- In step 2, L2 is reported twice because both independent reasons apply: the named funding deposit is pending, and the amount exceeds Owner D's cleared balance.
- The idempotent re-post (5b) writes no event, because nothing was checked or changed. Every lock check that ran wrote one.

## Checks run

- `vitest run --project finance convex`: 45 passed.
- With the fix reverted: 3 failed (the tests above).
- `npx.cmd --yes pnpm@10.20.0 typecheck`: exit 0.
- `npx.cmd --yes pnpm@10.20.0 test`: 13 files, 115 tests, all pass.
- `npx.cmd --yes pnpm@10.20.0 build:finance`: pass.
