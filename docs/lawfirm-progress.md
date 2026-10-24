# Law-firm demo preparation

Work is on `edwin-lawfirm-demo`, created from `edwin-desk-ui`.
No push, merge, deployment-setting change, or live investigation was performed.

Prepared independently:

- Placeholder-only finance environment template.
- Fictional six-client opening fixture and five source documents; existing
  reconciliation code confirms $339,500 bank = books = owners, all cleared.
- Removed duplicate money text; accessible label uses the same formatted amount.
- Activity renders without waiting for an entrance animation. A read-only
  Playwright check at 1440px found all 60 returned activity rows visible.
- Fixed the over-escaped internal-ID scrubber found during screenshot review.
- Added mock-only Next step, disabled during playback or an in-flight feed request.

The law-firm fixture is not yet connected as the default. The existing fixture
and feed remain unchanged pending a required decision about the requested script:

1. `financeIntake.ineligibility` rejects pending deposits because the existing
   investigation input contract carries only cleared deposits. Step 1 asks to
   investigate a pending check while forbidding contract/validation changes.
2. `submitProposal` blocks any failed request, including L2. Temporary holds are
   supported only at approval/posting. Step 2 asks for an immediate L2 hold at
   request while forbidding lock/workflow changes.

Options presented: preserve these gates and revise the sequence, or authorize
narrow changes that permit pending-deposit investigation and request-time holds
while retaining all posting safeguards. No gate has been bypassed.

Remaining after that decision: law-firm feed/default wiring, mock narratives,
policy and duplicate/refund/bounce flows, full activity history, nine-step browser
walkthrough and screenshots, and replacement walkthrough in ui-report.md.
The requested frontend-guide.md is absent, as already recorded in ui-report.md.
