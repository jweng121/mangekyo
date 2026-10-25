# Law-firm demo verification — 2026-10-24 (trust agents)

Branch `edwin-trust-agents` (from `edwin-orchestration`). The law-firm fixture
and the ten-step mock feed are connected. The ten-step flow was verified end to
end in mock mode by the Convex test suite (`convex/financeLawFirm.test.ts`, run
twice: with and without the insurance policy approved), plus the trust-rule,
disbursement, memory, correction, snapshot, audit and monthly-report tests in
`convex/financeTrust.test.ts`. No CREAO or external model run was started. The
earlier browser walkthrough of the nine-step feed (dev run 011, screenshots in
`docs/screenshots/lawfirm/`) still describes steps 4–9, which did not change.

What changed in the feed:

| Step | Before | Now |
| --- | --- | --- |
| 2 | Riley's direct $56,000.00 request, blocked by L2 | The Disbursement agent prepares the three payout lines from the signed settlement statement; the Evidence Checker verifies each; the lock blocks each line by L2 ("has not cleared") |
| 3 | Check clears; a person approves the allocation and Riley requests the payment again | Check clears; a person approves the allocation; Disbursement runs again on its own; a person approves and posts three lines; L9 passes via the 33% contingency fee, L11 passes because every line matches the statement |
| 10 | — | A paralegal moves $3,000.00 of Chen & Park fees to the firm with no invoice; blocked by L9 |

## Observed results (mock mode, convex-test)

| Flow | Observed result |
| --- | --- |
| Delgado pending | Trust Intake: "Waiting for the check to clear"; no allocation; run `provenance` = intake · mock · model mock |
| Disbursement before clearing | Three lines (attorney_fee 2,805,000 · costs 95,000 · client_share 5,600,000), Evidence Checker passed, every proposal `blocked` with L2 "has not cleared" (and L1/L9 on the empty balance) |
| Disbursement after clearing and allocation | Attempt 2 `ready_for_approval`; each line's lock passed at request; every claim supported; the fee line cites the statement and the fee agreement |
| Approving and posting the lines | Lock evaluated L9 and L11 at approval and posting; all three posted; Delgado's posted balance $0; the step-2 blocked lines unchanged |
| Okafor partial retainer | Question asked; answer saved with `accountId` (memory); allocation posted; partial-retainer candidate policy offered later |
| Nguyen clarification | "James" → checker stops the memo citation; cite-the-answer rerun passes; `submitCorrection` at a step creates a linked attempt; `correct_input_field` changes only the new attempt's input |
| Bayview duplicate, Cho L1, insurance policy, Westbrook approve-all | Unchanged from the nine-step flow |
| Paralegal fee (step 10) | `blocked`, L9 "no approved invoice for Chen & Park Holdings … and no signed settlement statement with a matching fee line"; Chen & Park still $120,000.00 |
| Bounced check | Three-way mismatched; reconciler proposes recording the return; a different person records it; matched again |
| Unexplained outflow | Reconciler asks "The bank is $2,500.00 short. Did Daniel Okafor's check bounce, or is this a bank fee?" and proposes nothing |
| Disputed funds | A $200,000.00 dispute on Westbrook holds a $50,000.00 payout at approval (L10); resolution by a different approver re-checks it; a person continues it |
| Memory | Priya Raman's partial retainer is proposed from Okafor's earlier answer; the pattern becomes policy P-1 (backtest 1 agree, 0 disagree); Kemi Adeyemi's deposit says "Used policy P-1, approved by dev-unverified:sam" |
| Snapshots | Every run has `input_frozen`, `output_validated`, `claims_checked` and `lock_evaluated` steps with actor, model, mode, frozen input, output, verdicts and lock results; `finance.snapshot.captured` events |
| Auditor drill | "Caught 4 of 4 · missed 0 · false alarms 0"; the audit changed no ledger entry |
| Monthly report | October 2026 report matched at $339,500.00; signed off once by sam; a second sign-off refused; the next audit has no A7 warning |

## State left behind (after the ten steps, policy approved)

- Adjusted bank = books = owners, matched.
- Delgado: $0 (three payouts outstanding until bank settlement). Okafor: $0
  after the bounce is recorded. James Nguyen: $5,400. Westbrook: $228,000
  pending posting of the approve-all allocation. Chen & Park: $120,000 (the
  paralegal's fee never moved). The firm's own-money owner: $0.
- The step-2 blocked lines, Cho's blocked request and the paralegal's blocked
  fee stay in history. Earlier demo accounts are untouched.

## Validation

- `npx --yes pnpm@10.20.0 typecheck`: exit 0.
- `npx --yes pnpm@10.20.0 test`: 36 files, 260 tests, all pass (was 31 files,
  228).
- `npx --yes pnpm@10.20.0 build:finance`: exit 0.

## Not done here

- No browser click-through of the ten-step feed on this branch yet; the desk
  shows the three payout lines as ordinary payment proposals (approve/post),
  but has no card for the Disbursement run, disputes, audits, monthly reports
  or step snapshots. Those are backend-only, reachable through
  [agent-api.md](agent-api.md).
- No real CREAO or external model call. The external adapter and the per-agent
  CREAO adapters are verified only with fake HTTP.

See [the current walkthrough](ui-report.md#current-law-firm-demo-walkthrough)
for presenter instructions and [orchestration.md](orchestration.md) for the
system as built.
