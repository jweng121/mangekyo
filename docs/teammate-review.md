# Teammate review: what jweng121 built, and how it meets the trust-agents backend

Read-only review on 2026-10-24 after `git fetch origin`. Nothing was changed, merged or pushed. Branch under review: `edwin-trust-agents` (`ee71c6c`).

## 1. Branches and commits not on `edwin-trust-agents`

| Branch | Head | Commits not on `edwin-trust-agents` | Author |
| --- | --- | --- | --- |
| `origin/main` | `23f418a` | 2: `23f418a` Merge pull request #2 from jweng121/edwin-desk-ui · `a0750a4` Merge pull request #1 from jweng121/Edwin | Edwin Lin (merge commits only; they merge branches we already contain, so their file diff against our merge base `3346f85` is empty) |
| `main` (local, stale) | `3d510d5` | 0 | — |
| `origin/Edwin`, `Edwin` | `92ccecc` | 0 | — |
| `origin/edwin-desk-ui` | `3346f85` | 0 | — |
| `origin/edwin-lawfirm-demo` | `ff6c500` | 0 | — |
| `origin/edwin-orchestration` | `6a08864` | 0 | — |
| `edwin-core-money-flow` (local only) | `6ce6b99` | 0 | — |

**By author.** jweng121 (James Weng) has four commits in the whole history, all already ancestors of `edwin-trust-agents`; he has no branch of his own on origin:

| Commit | Date | Subject | What it added |
| --- | --- | --- | --- |
| `c862ec5` | 2026-10-23 | Initial commit | repo skeleton |
| `111a360` | 2026-10-23 | Revise README with skeleton points | README |
| `3d510d5` | 2026-10-23 | initialized folder architecture | `apps/web/.gitkeep`, `packages/visual-audit` (placeholder components + playground), `packages/contracts` package, workspace config |
| `52eb0a2` | 2026-10-24 | temporary sandbox data | `apps/demo-erp` (synthetic ERP), `scripts/monitored-agent`, `packages/contracts/agent.ts`, `tests/controls.test.ts`, `tests/e2e/capture.spec.ts`, `playwright.config.ts`, `scripts/dev-visual-audit.mjs`, `docs/DEMO_ERP_SETUP.md` |

Edwin Lin: everything else (48 commits across the `edwin-*` branches, all on `edwin-trust-agents`). So as of this fetch there is no unmerged teammate work; the comparison below is against his code as it sits in our history.

## 2. What the teammate built

### Frontend apps and pages

- **`apps/web`**: empty (`.gitkeep` only), reserved for the integrated platform.
- **`apps/demo-erp`** (Next 16, port **3001**, Tailwind): a standalone synthetic trust ERP, server-rendered from a local JSON file, with these routes in one catch-all page: `/` (overview cards), `/companies` and `/companies/[id]`, `/transactions` and `/transactions/[id]` (with an allocation proposal form), `/invoices` and `/invoices/[id]`, `/documents` and `/documents/[id]` (each section and field has a `data-testid`, so a browser agent can read one field of a multi-entity document), `/trust-accounts` (owner ledgers), `/reconciliation` (bank, timing adjustment, cash book, owner sum, suspense), `/allocations` (proposal history with "Simulated approve" / "Simulated post"), `/activity`. APIs: `POST /api/allocations` (propose, approve, post), `POST /api/reads` (log a browser read), `GET /api/state`.
- **`packages/visual-audit`**: four placeholder React components (`AgentChat`, `SnapshotGraph`, `ScreenshotViewer`, `AuditPanel`) that render headings only, plus a playground Next app on port 3000. No data fetching, no Convex client, no props yet.

### ERP and bank-feed data

- **Generator**: `apps/demo-erp/data/seed.ts`, `createSeed(seed = 42)`, pure and deterministic. **Runtime state**: `apps/demo-erp/.data/state.json` (git-ignored), mutated by his app through a promise queue in `lib/store.ts`; `pnpm demo:reset` restores the seed.
- **Record types** (`State`): `Company` (6; id, name, client display name, account TRUST-01/02, status), `Transaction` (15; id, date, signed whole-dollar `amount`, currency, account, free-text `reference`, `sender`, `recipient`, `clearing` Cleared/Pending, `reconciliation` Matched/Unreconciled, one `documentId`, optional `duplicateOf`), `Invoice` (12; companyId, client, amount, reference `BILL-2026-NNN`, status Paid/Open), `Document` (16; version, type, title, `sections[]` by company with `fields[] {id,label,value}` as free text), `Ledger` (6; keyed by owner display name: opening, debits, credits, closing, cleared), `Proposal` (ALLOC-NNNN, one owner per transaction, status Proposed/Pending Review/Approved/Rejected/Posted, idempotency key), `Activity`, and four account totals (`bankBalance` 301,500, `timingAdjustments` −1,500, `cashBook` 300,000, `suspenseBalance` 8,250).
- **Scenarios** (`data/scenarios.ts`): A correct allocation (TX-001), B conflicting ownership (TX-002: invoice says Client A, remittance says Client B), C multi-company document (`DOC-MULTI-001`), D duplicate payment (TX-013 duplicates TX-012), E blocked write, F steering and rerun. `expected-results.ts` holds the answers for tests only.
- **Controls** (`lib/financial-controls.ts`): `evaluate` (deposits only, duplicate refused, owner must have a ledger on the account, TX-002 hard-coded to Client B), `propose`, `approve` (role `simulated-reviewer`), `post` (idempotent, only TX-001/TX-002 may leave suspense, moves the whole amount into one ledger), `reconciliation` (adjusted bank = cash book; book minus owners = suspense; `ownershipVerified: false`).
- **How messy it is**: moderately messy on purpose and tidy where it matters. Messy: amounts are whole-dollar JavaScript numbers (no cents anywhere), owners are display names (no owner ID; the company ID is the only stable key), ledgers are aggregates that do not tie to the transactions, the timing adjustment has no detail, there are no cleared-at dates, no as-of date on balances, no outflow requests or payees, payment-confirmation amounts are locale-formatted strings, only clients A and B have an agreement, and `evaluate` hard-codes the TX-002 answer. Tidy: the seed is deterministic and self-balancing (owner closings 291,750 + suspense 8,250 = 300,000 = bank 301,500 − 1,500), IDs are stable, documents are versioned, duplicates are explicit (`duplicateOf`), and a multi-entity document has independently addressable fields. Our adapter (`packages/finance-core/src/intake/erp.ts`) already imports it read-only as `demo-erp-seed-42`; the gaps are listed in `docs/erp-data-notes.md`.

### Visual audit and capture

- **`scripts/monitored-agent/runner.ts`**: a deterministic Playwright "agent" that walks the ERP for scenarios A–F, reads fields, proposes an allocation, and records an escalation when the server rejects it. Steering reruns (`MANGEKYO_PARENT_RUN_ID`, `MANGEKYO_STEERING_INSTRUCTION`) create a new run and branch ID.
- **`scripts/monitored-agent/capture.ts`**: `record()` takes a viewport screenshot per read/write, stores the element's bounding box and a normalized `region`, and builds one `AgentEvent` plus one `Snapshot` (his `packages/contracts/agent.ts` shapes). Bundles go to `artifacts/monitored-agent/<runId>.json` and, when `MANGEKYO_INGEST_URL` is set, are `POST`ed as `{runId, taskId, parentRunId, branchId, events, snapshots, scenario, escalation, steeringInstruction}`.
- **Tests**: `tests/controls.test.ts` (vitest "demo-erp" project) and `tests/e2e/capture.spec.ts` (Playwright against port 3001).

### What his code expects from Convex or our data shapes

- **No Convex at all.** His tree never imports `convex`, the generated `api`, or any of the agreed names (`getRunSteps`, `getSnapshot`, `getClaims`, `submitCorrection`, `listPolicies`, `getAuditReport`, `getScorecard`, `listTaskEvents`). The only shared code he consumes is `@mangekyo/contracts/agent` (`AgentEvent`, `Snapshot`, `ActionType`, `EvidenceReference`).
- **He expects an ingestion endpoint** (`MANGEKYO_INGEST_URL`, HTTP POST of the bundle above). We have no `convex/http.ts` and no ingestion function, so today his runner always prints "local bundle only".
- **His snapshot shape** (`Snapshot` in `agent.ts`): `id`, `eventId`, `runId`, `taskId`, `parentSnapshotId`, `agentId`, `agentRole`, `sequence`, `actionType` (READ/PROPOSE/…), `screenshot {url, provenance, alt}`, `observation {kind, fields[] with bounds}`, `evidence[]`, `annotations[] with region`, `instructionVersion`, `policyVersion`, `executionStatus`, `auditStatus`, `memoryRefs`. His audit shape (`AuditFinding` in `agent.ts`): `category` ownership_conflict | missing_evidence | risky_write, `severity` low/medium/high, `reviewStatus`, `reviewedThroughSequence`. His correction shape (`CorrectionRequest`): `steeringId`, `parentRunId`, `newRunId`, `restartFromSnapshotId`, `replayPayments: false`.

## 3. Mismatches with `docs/agent-api.md` and `packages/contracts`

### Name clashes inside `packages/contracts` (confirmed by a type probe)

`packages/contracts/index.ts` re-exports his `agent.ts` names explicitly and our `orchestration.ts` with `export *`. TypeScript lets the explicit export win silently, so from the barrel `@mangekyo/contracts`:

| Name | What `import { X } from "@mangekyo/contracts"` gives you | Ours (same name) lives in |
| --- | --- | --- |
| `AuditFinding` | his `{ category, severity low/medium/high, explanation, evidence, reviewStatus… }` | `@mangekyo/contracts/orchestration` (`{ ruleId, severity violation/warning, entryIds, sourceIds, ownerId, amountCents, foundBy }`) |
| `CorrectionRequest` | his `{ steeringId, parentRunId, newRunId, restartFromSnapshotId, replayPayments }` | `@mangekyo/contracts/orchestration` (`{ runId, stepIndex, kind, payload, reason, actor }`) |
| `Snapshot` vs `StepSnapshot` | no clash, but two unrelated "snapshot" types exist | — |
| `EvidenceReference` | the finance shape `{ sourceId, documentId, excerpt }` (his `{ id, label, source, field, value, href }` is deliberately not re-exported) | — |

Anyone importing `AuditFinding` or `CorrectionRequest` from the barrel gets the wrong type without an error. Fix later (not now): import ours from `@mangekyo/contracts/orchestration`, or rename ours (`TrustAuditFinding`, `RunCorrectionRequest`) in a follow-up; `agent-api.md` should say which subpath to import from.

### Field and shape differences between his capture model and our run model

| His (agent.ts / capture.ts) | Ours (orchestration.ts / agent-api.md) | Note |
| --- | --- | --- |
| `Snapshot.id`, `eventId`, `sequence` | `StepSnapshot.snapshotId`, `stepIndex`; the event is `finance.snapshot.captured` with `payload.snapshotId` | different key names; our steps have no `parentSnapshotId` or `branchId` (attempts link by `parentRunId` on the run) |
| `actionType` READ/PROPOSE/DECISION/WRITE_ATTEMPT/… | `kind` input_frozen/output_validated/claims_checked/lock_evaluated/failed | different vocabulary; his is browser-action-centric, ours is agent-step-centric |
| `screenshot {url, provenance, alt}`, `observation.fields[].bounds`, `annotations[].region` | none; our `input`/`output` are the frozen JSON, with no image | the "What the agent saw" frame needs a screenshot source; ours has none because the agents never use a browser |
| `agentId`, `agentRole` strings | `actor {type, identity}`, `agent` (one of five names), `model`, `mode` | ours carries model and mode; his carries role |
| `executionStatus`, `auditStatus` per snapshot | orchestrator `state` per run; `claimCheck.status` per run | review status is not on our snapshot |
| `AuditFinding.category/severity/reviewStatus` | `ruleId` A1–A8, `severity` violation/warning, `entryIds` | his findings are about one snapshot; ours are about posted ledger entries over a period |
| `CorrectionRequest {steeringId, restartFromSnapshotId, replayPayments:false}` | `submitCorrection {runId, stepIndex, kind, payload, reason, actor}` → `{correctionId, newRunId, created}` | same idea (new linked attempt, nothing replayed), different names; `stepIndex` ≈ `restartFromSnapshotId` |
| amounts: dollars as numbers (`amount: 3250`, `"$5,000.00"` strings in documents) | integer cents everywhere | our ERP adapter converts; his UI shows dollars |
| owners by display name (`"Client B — Brookstone Trust"`) | `ownerId` (`erp:owner:CMP-002`) and `sourceId` | our adapter derives IDs from the company |
| ingestion over HTTP (`MANGEKYO_INGEST_URL`) | Convex queries/mutations only; no HTTP route | missing piece on our side if his bundles are to land in Convex |
| ports: demo-erp and finance-dev both use **3001**; `playwright.config.ts` starts `dev:demo-erp` on 3001 | — | the two apps cannot run at once; our click-through today drove whichever desk was already on 3001 |

### Likely merge conflicts with `edwin-trust-agents`

There are none today: his four commits are ancestors, and `origin/main` adds only merge commits of branches we contain. Conflicts would appear only if he commits new work on top of `main`/`3346f85` in these places, which both sides touch:

- `packages/contracts/index.ts` and `packages/contracts/package.json` (he adds agent exports; we added `orchestration` and its export).
- `package.json` (root scripts: `demo:*`, `dev:monitored-agent` are his; `dev:finance`, `build:finance` are ours), `vitest.config.ts` (his `demo-erp` project vs our `finance` project), `.gitignore`.
- `playwright.config.ts` (his, points at 3001 and `dev:demo-erp`) if we add a finance Playwright config.
- `convex/_generated/*` would conflict if he ever adds Convex functions; he has none yet.
- Content, not git, conflicts: the `AuditFinding` / `CorrectionRequest` names above, and the port 3001 collision.

## 4. Can his ERP data express a $125,000 check settling three clients with different fee terms, shared costs and liens?

**No.** His `Transaction` has one `recipient`, one `documentId`, and a whole-dollar `amount`; `evaluate`/`propose` allow exactly one owner per transaction; `post` moves the whole amount into one ledger. There is no matter, no fee agreement, no settlement statement, no cost or lien record, and no payee other than a client ledger. The free-text `Document.sections[].fields[]` could carry three client sections with "Attorney fee" / "Costs" / "Lien" lines as label–value strings, but nothing would be typed, signed, or checkable, and his controls could not act on it.

What his data would need:

- **Matter** (case) records, with the clients on the matter (one deposit can belong to several).
- **Multi-beneficiary allocation**: shares per transaction (`[{owner, amount}]` summing to the deposit) instead of one `recipient`/`owner`; `post` must split suspense into several ledgers.
- **Fee agreements per client**: kind (contingency basis points, hourly, flat), signed flag and date, the matter it covers.
- **Settlement statement** as a typed document: gross amount, lines with kind (attorney_fee, costs, lien, client_share), amount, the client each line belongs to, payee, a `signed` flag; totals that must add up to the deposit.
- **Costs** with a sharing rule (equal, pro rata to recovery, or itemized per client) and the firm as payee.
- **Liens**: lienholder as a payee record, amount, which client it attaches to, priority, release/payoff evidence.
- **Payees beyond clients**: the firm's operating account and lienholders, so a payout can leave trust to someone other than a client.
- **Disbursement/payment records** with clearing status and bank reference, so a payout can be matched to the bank feed.
- **Integer cents**, owner IDs, as-of dates and cleared-at dates (the gaps already listed in `erp-data-notes.md`).

Our side is closer but also not complete for three clients on one deposit: `AllocationShare[]` already splits one deposit across owners, `SettlementLine` has a payee but no `clientOwnerSourceId`, a statement is tied to one `matterId` and the Disbursement agent is built around one client per matter, and L9 matches one fee agreement per client. To express the three-client case we would add a client reference on each settlement line, allow several fee agreements per matter keyed by client, add a cost-sharing rule, and run Disbursement once per matter with lines grouped by client. Liens already fit as `kind: "lien"` lines with a lienholder owner as payee.

## Summary

- Nothing from jweng121 is outstanding: his four commits (ERP sandbox, monitored-agent capture, visual-audit placeholders, `contracts/agent.ts`) are all in `edwin-trust-agents`; `origin/main` adds only two merge commits of branches we already have. No merge conflicts exist today.
- His code does not call Convex or any of the agreed query names; it only consumes `@mangekyo/contracts/agent` and expects an HTTP ingestion endpoint (`MANGEKYO_INGEST_URL`) that we do not have.
- Two real contract mismatches: the barrel `@mangekyo/contracts` silently resolves `AuditFinding` and `CorrectionRequest` to his older shapes, not ours; and his snapshot model (screenshots, regions, action types, review status) is a different thing from our step snapshots (frozen input/output, verdicts, lock results, model and mode). Both apps also claim port 3001.
- His ERP cannot express a $125,000 check split across three clients with fee terms, shared costs and liens: it has one owner per transaction, no matters, fee agreements, settlement statements, costs, liens or non-client payees, and no cents. Our contract is closer (multi-owner allocation, typed settlement lines, lien payees) but still assumes one client per matter.
