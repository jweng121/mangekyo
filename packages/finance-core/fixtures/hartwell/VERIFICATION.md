# Verification record — learning demo pass

Run on `main` with Python 3.11 and the pinned `requirements.txt` dependencies.
No application, Convex deployment, external model, or payment was run.

```powershell
packages/finance-core/fixtures/hartwell/.venv/Scripts/python.exe packages/finance-core/fixtures/hartwell/verify.py --check-determinism
```

Result: **PASS** before and after complete regeneration (547 artifact hashes).

- 44 clients, 29 matters, 175 bank transactions and balanced journal entries;
  all six month ends reconcile. October closes at $368,731.49 (was $243,731.49)
  because Harborline draft 902174 now deposits October 22.
- Cho's minimum is still -420000 cents; May to September closing balances are
  unchanged because each new settlement is fully disbursed in its own month.
- 257 PDFs / 263 pages; 130 scanned. Every page has the fictional-record footer.
- The original ten-case answer key still matches its fingerprint; the new
  `learning` section is checked separately against the exports: L1 and L2
  onboarding patterns, the rejected gross-fee rule (1 of 3 disagrees), the L3
  backtest (3 of 3 agree, October flags only Bello), and the November items.
- Mutating one L3 backtest figure in the answer key fails verification.

Changed existing artifacts: the July to October bank CSVs and statements (new
lines), `recon-10` (deposit) and the ERP exports that gained records. Every
other pre-existing PDF and text sidecar is byte-for-byte unchanged. Bello's fee
agreement already stated 25% of net after costs; the complaint and filing fee
receipt already existed, dated 03/03/2026, so neither was regenerated.

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
