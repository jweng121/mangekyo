# Verification record — document realism pass

Run in the isolated `mangekyo-hartwell-data` worktree on `edwin-hartwell-data`,
with Python 3.11 and the pinned `requirements.txt` dependencies. No application,
Convex deployment, external model, or payment was run.

```powershell
packages/finance-core/fixtures/hartwell/.venv/Scripts/python.exe packages/finance-core/fixtures/hartwell/verify.py --check-determinism
```

Result: **PASS** before and after complete regeneration.

- 40 clients, 25 matters, 160 bank transactions and balanced journal entries.
- All six monthly three-way reconciliations match.
- 227 PDFs / 233 pages rendered, including six two-page monthly bank statements.
- 108 scanned PDFs (47.6%): seeded tilt, grain, edge shadow, colored angled
  RECEIVED stamps and a few neutral review notes.
- All 227 text sidecars match the monetary inventory; page markers have one
  harmless simulated OCR substitution per page.
- All ten answer-key cases pass; Cho's minimum is still -420000 cents and the
  October closing bank/book/subsidiary total is still 24373149 cents.
- Lien itemization reconciles billed charges minus adjustments to the existing
  payoff. Invoice line extensions and dated services match their existing totals.
- Statement PDFs cover every bank transaction, running balance and monthly total.
- All 487 artifact hashes remain identical after full regeneration.
- All six requested screenshot pages were opened and visually reviewed; the
  agency form, title confirmation and expert invoice were reviewed as well.
- All exported text and raw email were checked for unmasked synthetic bank
  numbers and the removed enclosure footer.

Preservation checks against commit `0d92070`:

- All six bank CSVs are byte-for-byte unchanged.
- Nine core ERP exports are byte-for-byte unchanged: clients, matters, fee
  agreements, settlement statements, allocation agreements, trust ledger,
  reconciliations, incoming items and policies.
- The answer key, bank transactions, disbursements, payees and communications
  differ only by bank account masking / routing withholding.
- Invoice and lien identities, totals, original dates, versions and approvals
  are unchanged. Invoice service details and lien charge breakdowns are additive
  descriptions supporting the existing totals.
- The verifier fingerprints the original answer-key facts after the requested
  masking so unrelated case changes fail verification.

The email remains from `billing@baysidemedlcal.com`; its account `****5521`
differs from the on-file `****1264`. Handwritten-style notes say only that a
payoff should be reviewed or copied to the file, not that the email was verified.
Corrected settlement v2 remains unsigned.

These checks establish fixture integrity. They do not claim that existing
Mangekyo agents have consumed the fixture; integration remains a later task.
