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
| `bank/bay-commerce-4417-2026-<MM>.csv` | 6 monthly exports, 175 posted transactions |
| `erp/clients.json`, `matters.json` | 44 clients, 29 matters, explicit client membership |
| `erp/fee-agreements.json` | 44 signed agreements: gross, net-after-costs, tiers, hourly, flat |
| `erp/invoices.json`, `cost-receipts.json` | 49 approved invoices, 41 receipts |
| `erp/lien-letters.json` | 10 payoff letters: Bayside revisions for Delgado, Ames, Vasquez and Castillo, plus Park and Reyes |
| `erp/allocation-agreements.json` | Signed global recovery and supplemental allocation |
| `erp/settlement-statements.json` | Ridgeway signed v1 and unsigned corrected v2; 5 past and 1 November single-client statements |
| `erp/payees.json` | 52 payees with synthetic bank details; Bayside includes verification sources |
| `erp/trust-ledger-entries.json` | 175 balanced journal entries; the Harborline deposit has one leg per client |
| `erp/disbursements.json` | 112 posted outflows, 1 unapproved live request, 4 November drafts |
| `erp/bank-statements.json` | 6 bank statement PDFs with opening/closing summaries and transaction tables |
| `erp/reconciliations.json` | 6 signed month-end three-way reconciliations and every client balance |
| `erp/incoming-items.json` | Deposited global check; November supplemental and Castillo checks, not posted |
| `erp/policies.json`, `communications.json` | Approved claim-scoped allocation policy; suspicious email request |
| `erp/documents.json` | Document index with PDF and text paths, dates, kinds, scan flags, monetary inventory |
| `documents/` | 257 PDFs (263 pages), 257 OCR-style text sidecars, 1 raw `.eml` |
| `answer-key.json` | 10 cases including correct behavior / noise controls, plus the `learning` demo key |
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

The $125,000 Harborline draft 902174 is deposited October 22 and appears in the
bank feed and October statement. Its one bank line posts to three client ledgers
by the signed 50/30/20 allocation, so the October close rises by $125,000.00 and
still reconciles. Nothing is paid out: the proposed October 23 payment remains
unapproved and never posts. The endorsed complaint (`complaint-filed`, clerk
stamped 03/03/2026) and the $450.00 filing fee receipt (`global-filing`, also
03/03/2026) prove Reyes's tier. For a chronological demonstration, do not treat
later October rows as facts already available on October 22.

**D: November follow-up.** A November 6 supplemental $5,000 check uses the
October 23 approved policy to allocate $2,500 / $1,500 / $1,000. This is ownership
allocation only, not permission to disburse or reuse unsigned v2. It is not in
the May-October bank history.

## Learning demo

Onboarding reads May to September; a person corrects one October case; the
correction becomes a policy that is backtested on history; a November case then
passes every check with no person. The `learning` section of `answer-key.json`
holds the expected results, and `verify.py` recomputes each one from the exports.

**History.** Three Bayside payoffs were wired to Cedar Inlet Bank ****1264: Park
(June, one letter) and two settlements where Bayside revised the payoff after
the client signed. In both, the client re-signed a version 2 statement and the
firm paid the latest payoff. Ames (July, 33% of gross) went up from $8,200.00
to $8,975.00; Vasquez (August, 25% after costs) went down from $5,400.00 to
$5,150.00. Ford (September, 33% of gross, no lien) is the third settlement.
Each settlement is deposited, paid exactly as signed and fully disbursed within
its month, so May to September month-end balances are unchanged.

**Onboarding proposes** L1 (pay Bayside only at ****1264; any other account is
held for a phone check at (510) 555-0186) and L2 (pay the latest Bayside revision,
only after the client signs a statement showing it). It should not propose
"fees are charged on gross": Vasquez contradicts it, so it disagrees 1 of 3.

**Correction.** Case B1 triggers it: settlement v1 charges Bello $6,250.00, but
her agreement charges 25% of ($25,000.00 - $900.00) = $6,025.00. The resulting
policy L3 checks each fee against the client's own agreement basis. Backtest:
3 of 3 past settlements agree with what the firm paid, 0 disagree. In October
it accepts Delgado and Reyes and flags only Bello.

**November.** Castillo (one client) settles for $40,000.00 on a 30% after-costs
agreement; Bayside revises $6,800.00 to $7,350.00 before the only statement is
signed on November 12. Intake allocation, the $11,640.00 fee (L3), the $7,350.00
payoff (L2), the wire to ****1264 (L1), $1,200.00 costs and the $19,810.00 net
all clear with no person. Posting the four draft payments still needs Sam as
approver. The check is not in the May to October bank history.

All people, addresses, organizations, account numbers and signatures are
invented demo records. The requested Medicare label denotes a fictional
conditional-payment case, not a real agency record. The two requested domain
strings are inert document content: no DNS lookups or email were performed.
Phones use 555-01xx; account numbers are masked and routing numbers are withheld. Checks
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
the named fixture outputs and six sample images. Generated text is LF; the
raw email is CRLF. Byte reproducibility was checked with the pinned Windows
Python 3.11 environment; other PDF/image library versions can change bytes.

130 of 257 PDFs (50.6%) are rasterized scans with seeded 0.8-1.7 degree
rotation, visible paper grain, a shaded edge, JPEG artifacts and angled colored
RECEIVED stamps. A few pages carry portable pen-style review notes; none assert
that the suspicious email was verified. Digital firm and bank records remain
clean. Every page has the small light-grey fictional-record footer.

`document_layouts.py` supplies separate issuer layouts: Harborline claims
forms/checks, Bayside medical letterhead with a drawn mark, a clearly fictional
government-style conditional-payment form, Estuary escrow confirmations,
Bay Commerce statements and firm stationery. Lien charges include service dates,
billed amounts, adjustments and payoff totals. Time invoices have dated service
lines. Settlement tables retain v1's planted figures and show each client's fee
basis and signatures; corrected v2 remains unsigned. Fee agreements spell out
gross/net calculations and the Reyes filing-triggered tier.

Text sidecars are extracted from each actual typeset PDF before rasterization,
including tables, stamps and notes, then receive one harmless page-marker OCR
substitution (`Page` to `Paqe`) per page. Form feeds separate pages. No external
OCR engine is used. Monetary figures are checked before rasterization and in
the independent verifier. The obsolete enclosure footer is gone.

Account identifiers are masked consistently in PDFs, sidecars, raw email and
ERP exports. The answer key's only changes are `****1264` and `****5521` in
place of the full synthetic account strings; all last-four distinctions,
amounts, dates, expected actions, domains and other case facts are preserved.
The verifier fingerprints the original answer key with that masking applied.
The fake agency wording is deliberately distinct from an actual agency notice.

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
- [Reyes fee agreement](../../../../docs/screenshots/hartwell-data/fee-agreement.png)
- [October bank statement, page 1](../../../../docs/screenshots/hartwell-data/bank-statement.png)

All other task files stay in this fixture directory. The six screenshots are
the requested exception. There is no ERP wiring, Convex deployment, real agent
execution, or actual payment in this change.
