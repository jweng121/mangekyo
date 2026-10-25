# ERP and bank-feed data notes

Read-only inspection of jweng121's sandbox ERP (merged from `52eb0a2`). Nothing in
`apps/demo-erp/**` is modified by the finance work.

## Where it lives

| What | Where |
| --- | --- |
| Generator (pure, deterministic) | `apps/demo-erp/data/seed.ts` → `createSeed(seed = 42): State` |
| Runtime state (mutated by his app) | `apps/demo-erp/.data/state.json` (git-ignored, absent until his app runs) |
| His controls | `apps/demo-erp/lib/financial-controls.ts` (`reconciliation`, `evaluate`, `propose`, `approve`, `post`) |
| Expected answers (test only) | `apps/demo-erp/data/expected-results.ts` (`TX-001` → Client A, `TX-002` → Client B, duplicate pair `TX-012`/`TX-013`) |

The finance import reads **`createSeed(42)`** only. It never reads or writes his
runtime `state.json`, so the import is deterministic and does not depend on
whatever his app last did. Dataset version label: `demo-erp-seed-42`.

## What it represents

A synthetic trust/fiduciary company holding six clients' money in two pooled
trust bank accounts (`TRUST-01`: clients A–C, `TRUST-02`: clients D–F). All
amounts are USD. Everything is synthetic.

## Record types (counts are for seed 42)

| Type | Count | Stable ID | Key fields |
| --- | --- | --- | --- |
| Company | 6 | `CMP-001`…`CMP-006` | `name`, `client` (owner display name), `account`, `status` |
| Bank transaction | 15 | `TX-001`…`TX-015` | `date` (YYYY-MM-DD), `amount` (whole dollars, signed), `currency`, `account`, `reference`, `sender`, `recipient`, `clearing` (Cleared/Pending), `reconciliation` (Matched/Unreconciled), `documentId`, `duplicateOf?` |
| Invoice | 12 | `INV-001`…`INV-012` | `companyId`, `client`, `amount` (dollars), `reference` (`BILL-2026-NNN`), `status` (Paid/Open) |
| Document | 16 | `DOC-OWN-002`, `DOC-MULTI-001`, `DOC-AGREE-001`, `DOC-PAY-NNN` | `version` (int), `type`, `title`, `sections[].fields[] {id,label,value}` |
| Owner ledger | 6 | none (keyed by owner display name) | `owner`, `account`, `opening`, `debits`, `credits`, `closing`, `cleared` (dollars) |
| Account totals | 1 | none | `bankBalance` 301,500, `timingAdjustments` −1,500, `cashBook` 300,000, `suspenseBalance` 8,250 |
| Proposals / activity | 0 / 1 | `ALLOC-NNNN` / `ACT-NNN` | his app's runtime workflow; activity `ACT-001` "Seeded" at `2026-10-23T09:00:00.000Z` |

Two real examples each:

- Company: `CMP-001` Alder Fiduciary Services → "Client A — Alder Trust", TRUST-01;
  `CMP-002` Brookstone Property Group → "Client B — Brookstone Trust", TRUST-01.
- Bank transaction: `TX-001` 2026-10-02, 3250, TRUST-01, Cleared, ref `BILL-2026-001`,
  recipient Client A, doc `DOC-PAY-001`; `TX-013` 2026-10-14, 2500, TRUST-02, Cleared,
  ref `PMT-DUP-77 / Dunlin settlement`, `duplicateOf: TX-012`.
- Invoice: `INV-001` CMP-001, 5000, `BILL-2026-001`, Paid; `INV-009` CMP-003, 6250, `BILL-2026-009`, Open.
- Document: `DOC-OWN-002` v1 "Brookstone remittance instruction" (beneficial owner Client B,
  reference BKT-5000, $5,000.00); `DOC-AGREE-001` v1 client agreement covering clients A and B.
- Owner ledger: Client A closing 40,000, cleared 39,500; Client F closing 51,750, cleared 51,250.

Amounts are JavaScript numbers in **whole dollars** (no cents appear in seed 42).
`TX-009` is the only outflow (−900). `TX-014` and `TX-015` are Pending. Sum of
owner closings is 291,750; plus suspense 8,250 = 300,000 = `cashBook` =
`bankBalance` + `timingAdjustments`. His own reconciliation therefore balances.

## Gaps for client-money operations

- **Owner IDs**: owners exist only as display names. Companies map 1:1 to owners, so the company ID is the stable key.
- **Balance dates**: no ledger or statement carries an as-of date. The only timestamp is the "Seeded" activity (`2026-10-23T09:00:00Z`).
- **Ledger history**: `debits`/`credits` are aggregates (1,000/3,000 for every owner) and do not tie to the 15 bank transactions. There are no per-entry postings.
- **Timing adjustment**: −1,500 has no line-item detail, description, or source.
- **Clearing**: no cleared-at dates. Pending transactions have no expected clearing date.
- **Agreements**: only clients A and B have one (`DOC-AGREE-001`). C–F have none.
- **Outflows**: no payment requests, holds, or payees. Only the historical `TX-009` outflow exists.
- **Pending feed items**: whether `TX-014`/`TX-015` (pending) are inside `bankBalance` is not stated.
- **Locale**: payment-confirmation amounts are rendered with `toLocaleString()` (e.g. "$3,250"), so their text is locale-formatted.

## Mapping (decided before coding)

All normalized records carry `raw: { system, recordType, rawId, datasetVersion }`
pointing back to the original record. Source IDs are pure functions of the raw ID.

| Normalized | From | sourceId |
| --- | --- | --- |
| Account | ERP pooled totals | `erp:account:trust-pool` (sub-accounts TRUST-01/TRUST-02 kept per record) |
| Owner | Company + `client` | `erp:company:CMP-001`; ownerId `erp:owner:CMP-001` |
| BankTransaction | Transaction | `bank:txn:TX-001`; `direction` from sign, `amountCents` positive |
| Obligation (invoice) | Invoice | `erp:invoice:INV-001`, owner via `companyId` |
| SupportingDocument | Document | `erp:document:DOC-OWN-002:v1` (version is part of the ID) |
| Agreement view | Documents of type "Client agreement" | same document sourceId, listed in `records.agreements` |
| Bank statement anchor | `bankBalance` | `erp:bank-statement:trust-pool` as of 2026-10-23T09:00:00Z |
| Reconciling item | `timingAdjustments` | `erp:timing-adjustment:trust-pool`, applies to bank, flagged "no detail" |
| Opening owner balance | Owner ledger `closing`/`cleared` | `erp:ledger:CMP-001`, ledger entry kind `adjustment` at the anchor |
| Unallocated deposits | `suspenseBalance` = TX-001 + TX-002 | `deposit_received` entries for `bank:txn:TX-001` and `bank:txn:TX-002` |

Rules:

- **Money**: whole-dollar numbers become integer cents by exact decimal parsing, never `x * 100` on floats. Anything with more than two decimals, NaN, infinity, exponent form, or outside safe-integer cents is rejected with an import issue.
- **Dates**: YYYY-MM-DD becomes UTC midnight in epoch ms.
- **Cutover**: the ERP balances are treated as an opening snapshot at the anchor time. Bank transactions dated before the anchor are reflected in the statement balance and the opening owner balances. Only `TX-001`/`TX-002` are tied to explicit ledger entries, because `suspenseBalance` names them. One-to-one bank ↔ ledger matching applies to activity after the anchor.
- **Suspense check**: the import checks that suspense equals the sum of its named deposits and records an issue if not.
- **Investigations**: only cleared, unallocated, recorded deposits can be investigated. On seed 42 that is `TX-001` and `TX-002`. Pending deposits wait for clearance, because finance-investigation-input/v1 transactions are `bankStatus: "cleared"`.

## What the ERP cannot show, and the demo fixture

The ERP has no outflow requests, no owner whose available balance is too low
for a payment while the pool is rich, no pending deposit in an owner's balance,
and no post-cutover feed activity. Scenarios C, D and E therefore also use a
small fixture in `packages/finance-core/fixtures/demoMoney.ts`. Every ID starts
with `demo:` and every name with `DEMO`, on its own account
`demo:account:pool-001`. Scenario A runs on real ERP deposit `TX-001`. Scenario
B uses the fixture's vague deposit, because every cleared ERP suspense deposit
has a document naming its beneficiary.
