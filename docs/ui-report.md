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
- **Claim checking**: runs from before the checker existed (e.g. the synthetic case) show "Not checked yet"; new runs show each claim's verdict (see Part 2 below).
- **Prototype features added in Part 2**: "Start live feed", "Approve all proven items" and the checker/"Fix it" cards (see below).

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

---

# Part 2: agents (checker, rerun, policies, live feed)

## What was added

- **Agent 2, the claim checker** (`packages/finance-core/src/checker`, wired into `financeInvestigations.recordResult`). It runs after an investigation output passes validation and before anything reaches a person.
  - **Code part** (always on): every cited sourceId must exist in the frozen input, and every amount, date, invoice or document number and owner name quoted in a claim must appear in a cited record.
  - **Agent part**: behind a provider interface (`ClaimCheckerAgent`), selected by `CHECKER_AGENT_MODE` (`off` by default, `mock` for a deterministic stand-in, `creao` reserved and not connected). The agent only judges claims code couldn't; a code-found contradiction is final.
  - **Result per claim**: supported, not supported (with what the source actually says) or not checkable. It's stored on the run (`claimCheck`), with `finance.checker.completed` or `finance.checker.rejected` events and snapshots.
  - **Stop rule**: any "not supported" ends the run as `checker_rejected`. Nothing is sent for approval, no questions are raised, and a "Checker stopped a proposal" card appears for a person.
  - Instructions for the future CREAO agent are in `docs/creao-checker-agent.md`.
- **Correct and rerun**: `financeInvestigations.correctAndRerun`.
  - On a stopped run (the latest attempt only), a person picks one of three: cite the saved answer, dispute the checker (reason required), or add a document (text required).
  - The choice is saved as a task clarification recording who made it, and "Rerun from step 3" creates the next attempt through the existing resume path.
  - The stopped run is never changed.
  - A dispute is recorded and visible, but it can't override a code-found contradiction.
- **Learning you can see**:
  - Candidate policies appear in the queue. **Approve policy** is approver only, records who, emits `finance.money.policy_approved`, and only inserts.
  - Approved policies flow into the next investigation's `approvedPolicies`.
  - When a proposal cites one, its card, its activity row and the run inspector say "Used policy P-n, approved by sam".
  - **Approve all proven items** (approver only) approves only allocations that cite an approved policy, had every checker claim supported, and pass every lock rule in a side-effect-free pre-check. Everything else stays one by one.
- **Live feed** (`financeIntake.feedNext`, the **Start live feed** play/pause on the desk): DEMO accounts in mock mode only; it refuses CREAO mode. It adds a scripted, repeatable sequence through the normal import path; auto-investigation investigates each deposit:
  1. a clear deposit
  2. a partial payment, which raises a question
  3. an exact invoice match, which proposes a policy
  4. two deposits sharing a reference
  5. an unclear deposit, whose answered rerun the checker stops
  6. a second invoice match, which uses the approved policy
  7. a payment request the lock blocks
- **Fixed on the way**:
  - Two received deposits sharing a reference were a `DUPLICATE_POSTING` mismatch, which blocked every payment on the account. They're now a warning: both really reached the bank, and whether the payer paid twice is the person's question, which the investigation asks.
  - L3 didn't recognise approved policies as records, so policy-cited proposals were blocked for missing evidence. It now does.
  - Policy cards are de-duplicated by statement.

**Deliberate mock behaviour**: when a person's answer names an owner that the deposit's memo doesn't mention, the mock investigator cites the memo for that claim instead of the answer, unless a correction is on file. That's the citation mistake the checker exists to catch. It's deterministic, and it's the only scripted mistake.

## Provider mode on the dev deployment

You authorised it, so `FINANCE_AGENT_MODE` is now **`mock`** on `laudable-sturgeon-5`. I set it with `npx.cmd --no-install convex env set FINANCE_AGENT_MODE mock` and left it on mock for the live demo. `AUTO_INVESTIGATE` and `CHECKER_AGENT_MODE` are unset, so auto-investigation is on in mock mode and the checker agent part is off.

To switch back to CREAO, from the repository root:

```powershell
npx.cmd --no-install convex env set FINANCE_AGENT_MODE creao
npx.cmd --no-install convex env get FINANCE_AGENT_MODE   # should print: creao
```

In CREAO mode, auto-investigation is off unless `AUTO_INVESTIGATE=true`, and the live feed refuses to run. Answering a question or "Rerun from step 3" starts a real, paid CREAO run, and the buttons say so.

## Checks (Part 2)

- **Tests**: unit tests for the checker (`packages/finance-core/tests/checker.test.ts`) and Convex tests for the flow (`convex/financeAgents.test.ts`) cover:
  - per-claim results, events and snapshots
  - a rejected run never reaches approval
  - a rerun keeps history and links to its parent
  - dispute and add-document
  - policy approval and use
  - approve-all approves only proven items
  - the feed's order and its refusal of CREAO mode and non-DEMO accounts

  Render tests cover the checker card and the Fix it card.
- **Click-through**: Playwright, live, in mock mode on fresh run `demo:account:pool-009`. Screenshots at 1440 and 390 px are in `docs/screenshots/agents/`; no page scrolls sideways at 390. What happened:
  - The fresh run auto-investigated two deposits.
  - Start live feed ran; I paused to approve the proposed policy as sam (P-1), then resumed to the end.
  - The second invoice match showed "Used policy P-1, approved by sam".
  - The feed's $5,000 payment for DEMO Owner X was blocked by L1, with the bars.
  - I answered the partial-payment question, and the run resumed.
  - I answered the unclear $615 deposit with an owner's name. The checker stopped run 2: "The cited records don't contain: DEMO Owner D — Delta Trust", with the memo's actual text shown.
  - Open run and fix, then cite the answer, then Rerun from step 3: run 3 (following run 2) is ready for approval and supported; run 2 is unchanged.
  - What the agent saw for run 3 lists the clarifications.
  - Approve all proven items approved exactly the two policy-cited, fully supported proposals; four stayed for one-by-one review.
  - I approved and posted the $2,200 allocation by hand. Still matched.
- **Gate**: `npx.cmd --yes pnpm@10.20.0 typecheck` exit 0; `… test` 16 files, 151 tests, all pass; `… build:finance` pass.
- **Earlier DEMO runs**: `pool-005` to `pool-008` are left from earlier click-through attempts. Nothing is deleted.

## How to demo the agents (about 4 minutes, mock mode)

1. **Open `/desk` and click Fresh DEMO run.** Activity shows both deposits investigated automatically: one proposal ("AI proposal · needs sign-off", checker confirmed 1 of 1 claim) and one question.
2. **Start live feed.** Deposits arrive every few seconds, and each is investigated automatically. Activity says who did what: Agent, Agent 2 · checker, Code · the lock, Live feed.
3. **Approve the policy.** The proposed policy ("A deposit that quotes an open invoice number for the exact amount goes to that invoice's owner") appears early, from the DEMO invoice match. **Pause**, then as sam click **Approve policy**, then **Resume live feed**.
4. **Learning you can see.** Later invoice matches show **Used policy P-1, approved by sam** on their card, in Activity, and in their run.
5. **The lock still wins.** The feed's last step is a $5,000 payment for DEMO Owner X, blocked by L1. The bars show the pool's cash versus Owner X's $120.
6. **Answer the $750 question** ("partial payment of … DEMO-INV-A-2002?"). The agent reruns with your answer and proposes.
7. **The checker.** Answer the $615 question with "J Smith pays rent for DEMO Owner D — Delta Trust." The rerun is stopped: "Agent 2 · checker stopped a proposal", with what the memo actually says. Nothing reached approval.
8. **Fix it.** Open run and fix, choose "Cite the person's answer", then **Rerun from step 3**. Run 3 links to run 2 and is ready for approval. Run 2 is kept exactly as it was. Then **What the agent saw** shows your answer in the frozen input.
9. **Approve all proven items.** Only the policy-cited, fully supported proposals are approved; the rest stay one by one. Approve and post one more allocation and the equation stays matched.
