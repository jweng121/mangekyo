# Law-firm demo verification — 2026-10-24

The law-firm fixture and nine-step mock feed are connected. The browser
walkthrough is complete on `demo:account:pool-011`, using the local desk at
`http://localhost:3001/desk` and dev deployment `laudable-sturgeon-5` in mock mode.
This continuation resumed after step 3; the opening and first two steps have
screenshots from the earlier session. No paid CREAO investigation was started.

The existing money gates remain in force: a pending check can receive an
evidence-only review, but cannot produce an allocation. The initial payment
request is blocked by L2 (and insufficient available funds), not held. After
clearing and allocation, Riley makes a separate request for Sam to approve.

## Browser results

Screenshots are in `docs/screenshots/lawfirm/`.

| Flow | Observed result | Screenshot |
| --- | --- | --- |
| Delgado after clearing | New $56,000 payment posted; $29,000 remains; original blocked request preserved | `03-cleared-delgado-payment.png` |
| Okafor partial retainer | Answer recorded; $2,500 allocation approved and posted | `04-okafor-question.png`, `04b-okafor-posted.png` |
| Nguyen clarification | “James” triggers the intentional citation rejection; citing the saved answer permits a new reviewed attempt and $1,200 posting | `05-checker-stopped.png`, `05b-corrected-and-posted.png` |
| Bayview duplicate | Riley confirms duplicate; Sam posts refund-payable allocation; Riley requests $40,000 refund; Sam approves/posts payment | `06-duplicate-refund-posted.png` |
| Cho payment | $6,000 blocked by L1 against $1,800 available | `07-cho-blocked.png` |
| Insurance policy | Approved policy cited by Westbrook's $18,000 allocation; bulk approval selects it; Sam posts manually | `08-policy-approved.png`, `09-policy-used.png` |
| Bounced check | Riley simulates Okafor's $2,500 return; mismatch appears; Sam records return and restores matching totals | `10-client-check-bounced.png`, `10b-return-recorded.png` |
| Activity | Loaded all 180 saved rows through three additional pages | `13-full-activity.png` |
| Responsive header | All header buttons/selects fit at 320, 390 and 1440 pixels after CSS fix | `11-mobile.png`, `12-header-320.png`, `12-header-1440.png` |

Screenshot review found the long account selector pushed header buttons outside
the mobile viewport, even though root overflow was clipped. The control group
and labels now shrink within the header. Playwright checked each control's
actual bounds; the owners table retains its horizontal scroll.

## State left behind

- Adjusted bank = books = owners: **$427,700.00**, matched.
- Cleared bank cash: **$523,700.00**. Delgado's $56,000 payment and Bayview's
  $40,000 refund are outstanding reconciling items, not yet bank-settled.
- Okafor has $0 after the return; James Nguyen has $5,400; Westbrook has
  $228,000; Delgado has $29,000.
- The first Bayview wire's $40,000 Chen & Park allocation remains pending
  individual approval. Bulk approval correctly left it alone.
- Both blocked requests remain in history. Earlier demo accounts are retained.

## Validation

- Installed Vitest: **22 files, 158 tests passed**.
- Workspace `pnpm typecheck`: passed.
- Finance production build: passed before the CSS adjustment; the adjustment
  was verified in the running UI at three viewport widths.
- Automated tests also cover the unapproved-policy branch, Nguyen bounce
  fallback, refund self-approval refusal, return-entry separation of duties,
  idempotent bounce, and complete ordered activity pagination.

See [the current walkthrough](ui-report.md#current-law-firm-demo-walkthrough)
for presenter instructions. Earlier preparation blockers are resolved by
preserving the existing allocation and request gates.
