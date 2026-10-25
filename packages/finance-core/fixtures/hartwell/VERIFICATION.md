# Verification record

Run in the isolated `mangekyo-hartwell-data` worktree with Python 3.11 and
`requirements.txt`. No Convex command, deployment, model call, or app test
was needed for this data-only change.

Command from repository root:

```powershell
packages/finance-core/fixtures/hartwell/.venv/Scripts/python.exe packages/finance-core/fixtures/hartwell/verify.py --check-determinism
```

Result: **PASS** before and after full regeneration.

- 40 clients, 25 matters, 160 bank transactions / balanced journal entries.
- 6 of 6 monthly three-way reconciliations matched.
- All 221 PDF pages rendered; 108 contain scanned image pages.
- All 221 text sidecars exist and match registered monetary amounts.
- All 10 answer-key cases passed, including correct/no-flag cases.
- Cho's minimum balance: -420000 cents; negative October 9-29 inclusive.
- October closing bank / book / subsidiary total: 24373149 cents ($243,731.49).
- 472 generated artifact hashes unchanged after full regeneration.
- All 4 sample screenshots opened and visually inspected. Check layout refined
  into a landscape check form; email print uses a mailbox header.
- `git diff --check` passed.

The verifier was also exercised with six separate in-memory modifications
using an overridden JSON loader (no fixture files changed). Each failed for
the intended accounting or case reason before the final hash checks:

| Mutation | Rejected by |
| --- | --- |
| Add 1 cent to a journal debit | Balanced-journal assertion |
| Mark corrected v2 signed | Version-signature assertion |
| Change Bello agreement to 26% | Net-fee assertion |
| Replace email account with the on-file account | Bank-mismatch assertion |
| Change approved policy to draft | Approved-memory assertion |
| Change answer-key deficit by 1 cent | Daily Cho amount assertion |

This verifies synthetic data integrity and expected answers. It does not
claim that the existing Mangekyo agents have consumed this fixture or caught
these cases. Integration and model execution are later tasks.
