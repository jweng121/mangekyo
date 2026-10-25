# Lock rules — UI click-through test

Latest continuation: [law-firm demo verification](lawfirm-progress.md) records
the completed mock walkthrough, refund and bounced-check checks, and current
validation results. Historical lock checks below are retained unchanged.

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

---

# Follow-up: three fixes (2026-10-24)

The fixes were clicked through in the real UI on a fresh DEMO run, `demo:account:pool-004`, using the same never-investigate guard. Screenshots are in `docs/screenshots/fixes/`. No lock rule was relaxed.

## Fix 1: outstanding payments are reconciling items, not mismatches

**Change**: a posted disbursement the bank feed hasn't shown yet is an *outstanding payment*. A recorded deposit the bank hasn't shown is a *deposit in transit*. Both now count in the adjusted bank balance: statement + feed + reconciling items + outstanding items = books. They are listed under **Reconciling items** with their entry and source IDs, age and expected bank reference. They are not mismatch causes, so they don't trigger L5.

**Ageing**: once an item is older than `OUTSTANDING_MAX_DAYS` (Convex env, default 5; invalid values use 5), it becomes the mismatch `OUTSTANDING_ITEM_AGED`. L5 then blocks the affected owner. Queries can't read the clock, so the panel passes its own time rounded to the minute.

**Files**: `packages/finance-core/src/ledger/index.ts` (`threeWayCheck` options), `convex/lib/money.ts` (`checkAccount`, `outstandingMaxDays`), `convex/financeIntake.ts`, `MoneyPanel.tsx`.

| Clicked | Expected | Actual | Screenshot |
| --- | --- | --- | --- |
| Fresh run | Matched | Bank = Books = Owners = $270,600.00, matched, no reconciling items | `1a-fresh-run-matched.png` |
| riley requests Alpha $1,000; sam approves, then posts | Still matched, one outstanding item | Bank $269,600.00 (statement + feed − $1,000.00 outstanding) = Books = Owners $269,600.00, **matched**. Reconciling items: "Outstanding payment −$1,000.00 · DEMO Alpha · 0 days old · awaiting bank reference PAY:…pay:0001". No causes, no L5 | `1b-posted-outstanding-still-matched.png` |
| DEV: simulate bank settlement | Item gone, still matched | Bank still $269,600.00, now as feed −$1,000 instead of outstanding −$1,000. Matched, no reconciling items | `1c-settled-item-gone-matched.png` |
| Aged past the limit | Mismatch | **Not clicked** (it needs 5 real days). Tested in `ledger.test.ts` and `financeMoney.test.ts` with `OUTSTANDING_MAX_DAYS=3`: matched at day 3, `OUTSTANDING_ITEM_AGED` at day 4, L5 blocks that owner only | — |

## Fix 2: hold instead of kill

**Change**: at approval or posting, if the only failures are temporary (L2 funds not cleared, L5 reconciliation mismatch), the proposal moves to `on_hold` with its reason codes and a plain-English reason. It does not move to `blocked`.

**Unchanged**:
- Permanent failures (L1, L3, L6) still block.
- Any failure at request time still blocks.
- L4/L7 refusals change nothing, as in the first fix.

**A person decides**: held proposals appear under **Needs a person** with four choices:
- **Re-check now**
- **Keep waiting**
- **Cancel with reason** (moves to the new terminal status `cancelled`)
- **Continue**: appears once the hold is ready. It needs the approver role and re-runs every rule, including L4.

Each choice records who made it and emits a `finance.money.hold_updated` event, or a transition for cancel and continue.

**Automatic re-checks**: holds are re-checked after anything that could clear them: bank-feed items, deposit clearing, recorded bank items, postings, reversals and imports. When every rule passes, the hold is marked **ready to continue** and stays in the list. Money never moves without a person continuing it. Held payments keep reserving the owner's funds.

**New fix action**: to resolve the demo mismatch I added **Record in ledger** (approver only). It records an unrecorded bank-feed item as a ledger entry citing that bank transaction. I also added **DEV: simulate clearing** for pending DEMO deposits.

| Clicked | Expected | Actual | Screenshot |
| --- | --- | --- | --- |
| riley requests Yankee $1,000 (`pay:0002`) and $500 (`pay:0003`); sam approves both; DEV simulate unrecorded outflow | — | Three-way red: `BANK_TXN_WITHOUT_LEDGER_ENTRY demo:run-004:bank:txn:E-001`, affecting Owner Y | — |
| sam posts both | Hold, not block | Both **on_hold**: "On hold: the bank and the books don't agree yet (Bank outflow $2,000.00 (DEMO-WIRE-Y-9001) has no ledger entry)." | `2b-held-plain-reason.png` |
| riley: Re-check now; sam: Keep waiting | Recorded with who | Events #28 "Re-check by dev-unverified:riley: On hold…" and #29 "dev-unverified:sam chose to keep waiting…" | `2c-after-recheck-and-keep-waiting.png` |
| sam cancels `pay:0003` with "Client asked to drop the smaller transfer" | Cancelled with reason | `on_hold → cancelled` (event #30) with that reason; the card shows it | `2d-cancelled-with-reason.png` |
| sam: Record in ledger on the E-001 cause | Re-check runs automatically, ready to continue, no money moved | Event #31 records E-001. Event #32 "Automatic re-check: Ready to continue…". `pay:0002` is still on hold with no ledger entry | `2e-ready-to-continue.png` |
| sam: Continue (post to ledger) | Posted | `on_hold → posted` (event #35). Ledger rows 10 → 11. Bank = Books = Owners $266,600.00, matched, with the new payment shown as an outstanding item | `2f-continued-posted.png`, `2f-three-numbers-after-continue.png`, `2g-money-event-stream.png` |

**Covered by tests only, not clicked**:
- An L2 hold at approval, with the exact reason "On hold: $2,500.00 from DEMO Delta Tenant hasn't cleared yet."
  - Simulating D-001 clearing makes it ready; Continue then approves.
  - Producing it needs an owner's cleared funds to drop between request and approval. The tests set that up by recording a DEMO bank fee.
- An L1 failure at approval still blocks.
- An L2 failure at request time still blocks.
- A requester continuing their own hold is refused.

## Fix 3: Start fresh DEMO run

**Change**: **Start fresh DEMO run** creates the next `demo:account:pool-NNN` and loads the fixture clean. Every fixture ID in run N is namespaced `demo:run-NNN:…` (e.g. `demo:run-004:bank:txn:E-001`), so the sourceId upserts can't touch an earlier run's rows. Nothing old is deleted or edited. Run names get "(run NNN)", and the selector defaults to the newest run.

**Clicked**: the button created `pool-002`, `pool-003` and `pool-004` (`3-fresh-run-selector.png`). `pool-002` and `pool-003` come from two script attempts that stopped on screenshot errors:
- `pool-002` is untouched.
- `pool-003` has one posted, unsettled $1,000 Alpha payment.

**Tested**: every pool-001 row (bank, owners, documents, entries, proposals, events, snapshots) is identical before and after a fresh run. The new run is matched with no proposals, and the L1 and E scenarios work on its own IDs.

**Also changed during these UI checks**: the lock result box now says "Did not pass at post" instead of "Blocked at post", because a failed check can now end in a hold.

## Checks run

- `npx.cmd --yes pnpm@10.20.0 typecheck`: exit 0.
- `npx.cmd --yes pnpm@10.20.0 test`: 15 files, 127 tests, all pass.
- `npx.cmd --yes pnpm@10.20.0 build:finance`: pass.
- `node_modules\.bin\convex.cmd codegen --typecheck disable`: run once, for the `OUTSTANDING_MAX_DAYS` env type. Like before, it contacted the dev deployment.
- `dev:backend` was running and pushed each saved change to `laudable-sturgeon-5` automatically.
