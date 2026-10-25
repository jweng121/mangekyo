# Hartwell & Moreno trust-account fixture

Fictional data and source documents for the Mangekyo demo. No app integration,
backend changes, deployment, external model calls, or real financial records.
The firm has 12 attorneys in Oakland practicing personal injury, real estate,
and family law. Diane Hartwell and Luis Moreno are partners, Priya Raman is an
associate, Riley Okoro prepares payments, and Sam Whitfield approves them.
The Bay Commerce Bank IOLTA ends in 4417; operating ends in 2290.

## Contents

| Export | Count / purpose |
| --- | --- |
| `bank/bay-commerce-4417-2026-<MM>.csv` | 6 monthly exports, 160 posted transactions |
| `erp/clients.json`, `matters.json` | 40 clients, 25 matters, explicit client membership |
| `erp/fee-agreements.json` | 40 signed agreements: gross, net-after-costs, tiers, hourly, flat |
| `erp/invoices.json`, `cost-receipts.json` | 49 approved invoices, 33 receipts |
| `erp/lien-letters.json` | 4 payoff letters, including both Bayside revisions and a prior paid case |
| `erp/allocation-agreements.json` | Signed global recovery and supplemental allocation |
| `erp/settlement-statements.json` | Signed v1 and unsigned corrected v2, each with 11 structured lines |
| `erp/payees.json` | 48 payees with synthetic bank details; Bayside includes verification sources |
| `erp/trust-ledger-entries.json` | 160 balanced two-leg journal entries |
| `erp/disbursements.json` | 101 posted outflows, 1 unapproved live request |
| `erp/reconciliations.json` | 6 signed month-end three-way reconciliations and every client balance |
| `erp/incoming-items.json` | Unposted global check and separate November supplemental check |
| `erp/policies.json`, `communications.json` | Approved claim-scoped allocation policy; suspicious email request |
| `erp/documents.json` | Document index with PDF and text paths, dates, kinds, scan flags, monetary inventory |
| `documents/` | 221 PDFs, 221 OCR-style text sidecars, 1 raw `.eml` |
| `answer-key.json` | 10 cases including correct behavior / noise controls, evidence and responsible agents |
| `manifest.json` | Seed, counts, SHA-256 hashes for every generated artifact and screenshot |

All monetary values are integer cents. CSV debit/credit/balance columns are
fixed two-decimal dollars. Bank descriptions are uppercase and at most 32
characters. IDs are stable; document paths are relative to this directory.
References such as `documentId` resolve through `erp/documents.json`.
The exports are a standalone practice-management shape, not a claim of
compatibility with the existing application's import API.

## Story and replay boundaries

The posted history runs May 1 through October 31, 2026, starting at zero.
Routine advances, partial payments, fee transfers backed by approved invoices,
refunds, costs, lien payments, and a property-damage settlement create the
background. Similar Nguyen names, vague Zelle memos, claim-number variants,
Delgado's name variants, and a misspelled retainer memo require source review.
Two Estuary Title wires have the same reference; both actually arrived and
one was returned. A $25 bank charge hits the firm's charge-clearing ledger
and is replaced from operating the next day; no client is charged.

**A: matched month-end, negative client during the month.** Cho starts with
$1,800. Riley pays a $6,000 expert invoice October 9. Cho is at -$4,200 through
October 29, then pays $5,200 October 30, ending at $1,000. Every bank transaction
has a balanced journal, so all six month ends still reconcile. The Trust
Compliance Auditor must inspect daily client balances. The separate temporary
negative firm charge-clearing balance is the documented bank-fee replacement,
not another client deficit.

**B/C: a separate live review snapshot at October 22.** The unposted $125,000
Harborline check belongs to the three-client Ridgeway crash case. Signed
allocation is 50/30/20. The signed v1 statement balances but charges Bello
25% of gross instead of net after costs ($225 too much), and uses an obsolete
$12,000 Bayside payoff instead of the later $14,500 quote. Reyes's 40% tier is
correct because the complaint was filed March 3. Corrected v2 preserves the
$125,000 total but is unsigned. The email on October 22 requests new bank
details for a planned October 23 payout, using `baysidemedlcal.com` instead of
`baysidemedical.com`. Prior settled payoff records establish the genuine
instructions within this fictional scenario. Hold the request and verify
using the on-file phone number. The email never updates the payee master.

These live records are intentionally not mixed into the historical bank or
ledger exports. The proposed October 23 payment remains unapproved and never
posts. For a chronological demonstration, select the live scenario separately
from the full October close; do not treat the later historical rows as facts
already available on October 22. The check is not represented as cleared cash.

**D: November follow-up.** A November 6 supplemental $5,000 check uses the
October 23 approved policy to allocate $2,500 / $1,500 / $1,000. This is ownership
allocation only, not permission to disburse or reuse unsigned v2. It is not in
the May-October bank history.

All people, addresses, organizations, account numbers and signatures are
invented demo records. The requested Medicare label denotes a fictional
conditional-payment case, not a real agency record. The two requested domain
strings are inert document content: no DNS lookups or email were performed.
Phones use 555-01xx; routing numbers are intentionally non-routable. Checks
are marked non-negotiable. No real company or person was researched or used
as a source; any name resemblance is coincidental.

## Regenerate and verify

Use Python 3.11 and the pinned dependencies. From this worktree's repository
root on Windows PowerShell:

```powershell
py -3.11 -m venv packages/finance-core/fixtures/hartwell/.venv
packages/finance-core/fixtures/hartwell/.venv/Scripts/python.exe -m pip install -r packages/finance-core/fixtures/hartwell/requirements.txt
packages/finance-core/fixtures/hartwell/.venv/Scripts/python.exe packages/finance-core/fixtures/hartwell/generate.py
packages/finance-core/fixtures/hartwell/.venv/Scripts/python.exe packages/finance-core/fixtures/hartwell/verify.py --check-determinism
```

On Unix use `python3.11 -m venv` and `.venv/bin/python` at the equivalent paths.
No network is used after dependency installation. The generator always uses
seed **44172026**, fixed dates, invariant ReportLab metadata, deterministic
per-document rotation/noise, and JPEG compression. Repeat runs overwrite only
the named fixture outputs and four sample images. Generated text is LF; the
raw email is CRLF. Byte reproducibility was checked with the pinned Windows
Python 3.11 environment; other PDF/image library versions can change bytes.

108 of 221 PDFs (48.9%) are rasterized grayscale scans with seeded 0.3-1.2
degree rotation, grain, JPEG artifacts, and occasional fax headers or a
received stamp. Firm statements and bank letters remain digital. The `.txt`
files simulate extracted OCR, with two harmless boilerplate substitutions per
page (`Teleph0ne`, `Encl0sure`); monetary values are never altered. They are
synthetic sidecars, not output from an external OCR engine. Before rasterizing,
the generator extracts text from the clean PDF and checks every registered
monetary amount is actually printed.

`verify.py` independently reads the exported JSON, CSV, PDF and text files.
It recomputes bank running balances and journal debit/credit totals, reconciles
all client subsidiary ledgers each month, reconstructs Cho's daily balance,
checks all answer-key arithmetic, signed/unsigned versions, policy allocation,
email headers and account mismatch, invoice line extensions, evidence links,
PDF rendering, PDF/text amounts, and artifact hashes. `--check-determinism`
then reruns the generator and demands the same manifest and all artifact hashes.
The verifier never calls a model or any application backend.

## Sample PDF pages

These PNGs are rendered from the actual final PDFs, not illustrative mockups:

- [Scanned Bayside lien letter](../../../../docs/screenshots/hartwell-data/scanned-lien-letter.png)
- [Signed settlement statement v1](../../../../docs/screenshots/hartwell-data/settlement-statement-v1.png)
- [Harborline settlement check](../../../../docs/screenshots/hartwell-data/settlement-check.png)
- [Fraud email print](../../../../docs/screenshots/hartwell-data/fraud-email.png)

All other task files stay in this fixture directory. The four screenshots are
the requested exception. There is no ERP wiring, Convex deployment, real agent
execution, or actual payment in this change.
