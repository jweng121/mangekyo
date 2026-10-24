# Desk UI report

Branch `edwin-desk-ui`, local commits only. The design spec is `docs/prototype/mangekyo-live.html`. Every screen reads real Convex data through the existing backend, plus two read-only queries in `convex/financeDesk.ts`. No lock rule, validator or contract changed.

`docs/frontend-guide.md` was not found anywhere on the machine, so it wasn't moved. The design rules in the request were applied and checked instead (see below).

## What was built (apps/finance-dev)

| Route | What it is |
| --- | --- |
| `/` | Landing page. Black background, Vanta DOTS (white, no lines, client-only, destroyed on unmount, skipped under reduced motion), logo, headline, "Why it matters" facts, the 4-step "How it works", and the Bank = Books = Owners line that assembles on scroll (ScrollTrigger scrub, transform only, visible at rest). "Open the desk" goes to `/desk`. |
| `/desk` | The operator view. See the next section. |
| `/runs/[runId]` | Run inspector: every attempt for the same deposit as cards with parent links, frozen steps from saved events and snapshots, "Claim by claim" from the run's findings and their sourceRefs, the outcome, and "What the agent saw". |
| `/runs/[runId]/view` | What the agent saw: dark screen, the labelled **PLACEHOLDER · VISUAL AUDIT** area with a frame strip per step, and **Exactly what it was given**, built from the frozen input (records with sourceIds, clarifications, approved policies, code checks, contextAsOf, instruction version). The typed handoff is in `docs/visual-audit-handoff.md`. |
| `/dev` | The previous page, unchanged. Its CSS is scoped under `.dev-root` so it can't affect the new pages. |

**The desk (`/desk`)**

- **Top bar** (sticky): logo, "Acting as (dev only)" (sam, approver / riley, requester), account selector (defaults to the newest DEMO run; the ERP account is selectable), "Break it…" (wire with no ledger entry, request more than an owner has, a pending deposit clears), "Fresh DEMO run", "New payment".
- **The equation**: Bank, adjusted = Books = Every owner, added up. React Bits CountUp animates every change. When it stops matching, GSAP slashes the "=" in red; the animation is interruptible (`overwrite: "auto"`), and the panel gives a small shake. Below it:
  - the first code-found cause in one plain line
  - reconciling items (timing adjustment, outstanding payments and deposits in transit, with age)
  - counts: started automatically, waiting on a person, blocked by the lock, posted after sign-off
- **Needs a person**, each card stating its safety facts in words:
  - holds (continue, re-check now, keep waiting, cancel with reason)
  - the code-found fix for an unrecorded bank item ("Approve entry")
  - allocation proposals (approve, then post; reject with a reason; open run)
  - payment requests (approve, then post; reject)
  - agent questions with an inline answer
  - unassigned deposits ("Propose allocation" by hand)
  - blocked payments, with pool vs owner vs requested bars
  - proposed policies
- **Activity**: React Bits AnimatedList of saved events in plain English with who did it (Agent in purple, Code, System, or the person's name). Internal IDs are scrubbed. Active runs show specific progress text, never "Processing…".
- **Owners**: posted, not cleared, available, and status in words.
- **Payment modal**: enters and leaves with the same GSAP motion. It shows the lock result immediately, with the L1 bars.

**Stack**
- `gsap` and `@gsap/react` (`useGSAP` everywhere).
- `lenis` driven from `gsap.ticker`, feeding `ScrollTrigger.update`.
- `vanta` with `three@0.134.0`.
- `next/font/google` for Schibsted Grotesk and Spline Sans Mono.
- React Bits CountUp and AnimatedList: the React Bits CLI (via shadcn) needs an interactive `components.json` init, so both components were copied from GitHub into `app/components/reactbits/` with the MIT + Commons Clause license.
  - Their dependency `motion` was added.
  - The AnimatedList demo icons were removed to drop `@hugeicons`.

## Real vs placeholder

**Real (Convex)**
- three-way numbers, causes, reconciling items
- owner balances
- deposits, proposals, holds, blocked payments
- questions and proposed policies from saved runs
- activity (money stream plus the account's investigation events)
- counts
- runs with every attempt, steps, snapshot IDs, the frozen input
- every button: existing mutations; no new write paths

**Placeholder or not yet built**
- **Captured view**: the "Captured view" area is the visual-audit placeholder.
- **Claim checking**: in the inspector, claims show "Not checked yet" until the claim checker exists (Part 2).
- **Policy approval**: approving policies isn't built; the policy card says so.
- **Prototype features left for Part 2**: "Start live feed", "Approve all proven items" and the checker/"Fix it" cards aren't built yet.

## Checks

- **Click-through**: Playwright Chromium against the running dev server and the live dev deployment, which is in CREAO mode. The script refuses to click anything about investigating, rerunning or answering, and it aborts if a start, answer or task-creation mutation is sent. Screenshots at 1440 and 390 px are in `docs/screenshots/desk/`. No page has horizontal scroll at 390 px. Steps:
  1. landing
  2. desk on a fresh DEMO run
  3. Break it (outflow): red equation with its cause
  4. Approve entry (the fix): matched again
  5. Request more than DEMO Owner X has: blocked by L1 with the bars
  6. riley proposes an allocation for the $1,500 DEMO Alpha deposit; sam approves, then posts: matched, Alpha +$1,500
  7. the run inspector and "What the agent saw" for the saved CREAO attempt 6 of the synthetic case
- **Not clicked live**: mock-mode agent content (agent proposals, questions, progress). The deployment is in CREAO mode and I may not change its settings or start paid runs. It is covered by convex-test in mock mode (`apps/finance-dev/tests/desk.test.tsx` renders `/desk`, the inspector and the agent view from real query results).
- **Fixed after looking at the screenshots**:
  - Vanta crashed navigation, because three r134 exposes its classes on `.default` and Vanta reads `window.THREE`.
  - A hydration warning (an inline body style; now in `base.css`).
  - An internal owner ID in an activity row.
  - AnimatedList chrome and width.
  - Lock rows now say at which step they passed.
  - Long sourceIds are now stacked under their labels.
  - The repeated questions in the Outcome card.
- **Design rules**:
  - One bold element per screen (the equation).
  - Status in words or icons.
  - Buttons press to 0.97.
  - Interruptible animations.
  - Modal symmetry.
  - Reduced motion: no Vanta, no Lenis, no number tweens.
  - Prototype colours (4.5:1).
  - Tabular, right-aligned money.
  - No internal IDs outside the inspector.
- **Gate**: `npx.cmd --yes pnpm@10.20.0 typecheck` exit 0; `… test` 14 files, 133 tests, all pass; `… build:finance` pass (routes /, /desk, /dev, /runs/[runId], /runs/[runId]/view).

## 3-minute demo walkthrough

1. **0:00 Landing.** Open `/`. Read the headline, scroll: the Bank = Books = Owners line assembles. Click **Open the desk**.
2. **0:20 A fresh run.** Click **Fresh DEMO run**. It's green: "Matched · every dollar has an owner". The reconciling items and the owners table show posted vs available in words.
3. **0:45 Break it.** Choose **Break it… → Wire leaves with no ledger entry**. The "=" is slashed red: "Doesn't reconcile: $2,000.00 gap", and one plain line names the cause and the owner whose payments are on hold.
4. **1:10 Fix it.** As sam, approver, click **Approve entry** on "Code · fixes the gap". The equation is matched again, and Activity shows who did it.
5. **1:30 The money shot.** Choose **Break it… → Request more than an owner has**, then **Check and request**. It's blocked by L1: the bars show the pool's cleared cash, Owner X's $120 available, and the $5,000 requested. "The pool has the cash, but it belongs to other owners."
6. **2:00 Approve then post.** Switch to riley and choose an owner on the $1,500 deposit card, then **Propose allocation**. Switch to sam: **Approve allocation**, then **Post to ledger**. It stays matched, and Alpha is up $1,500.
7. **2:30 Inspect a run.** Open a run (from a card, or `/runs/<runId>`): every attempt is kept, with frozen steps and claims. Then **What the agent saw**: the placeholder for the visual audit, beside exactly what the agent was given.
