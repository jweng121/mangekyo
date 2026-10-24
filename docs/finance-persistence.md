# Finance persistence milestone

This describes the initial persistence milestone. The current
[investigation workflow](finance-investigation.md) extends these records and APIs
with provider execution, questions, and clarification attempts.

All records in this milestone are synthetic. The cleared $1,250.00 deposit is
unallocated. The candidate owner and unverified remittance note are investigation
inputs, not proof of ownership. No allocation, approval, reasoning, or execution
occurs. All amounts are integer cents; timestamps are Unix milliseconds.

## Local development

Use Node.js 22.12+ and pnpm 10.20.0. From the repository root:

```powershell
pnpm install
Copy-Item .env.example .env.local
Copy-Item apps/finance-dev/.env.example apps/finance-dev/.env.local
pnpm dev:backend
```

Copy the environment examples only on first setup; preserve existing local values.
The root `CONVEX_DEPLOYMENT` targets **dev:laudable-sturgeon-5**, in the existing
**mangekyo** project. The root `CONVEX_URL` and app `NEXT_PUBLIC_CONVEX_URL` point
to its public cloud URL. Local environment files are ignored by Git. Never place
a deploy key or access token in a `NEXT_PUBLIC_` variable.

The deployment spelling was confirmed against the existing project and by the
project owner during setup: **sturgeon**, including the `t`.

If the CLI needs authentication, run `pnpm exec convex login` and complete the
browser sign-in using an account with access to that development deployment.
Do not select a new project, local replacement deployment, or production. Before
the first backend push, inspect any existing remote functions/schema and merge
their source into this checkout if it is not already present: a Convex push
synchronizes the backend, including removal of functions absent locally.

In a second terminal at the repository root:

```powershell
pnpm dev:finance
```

Open http://localhost:3001. Load the synthetic case; reload to read it from Convex.
Open a second tab before the first load to observe the reactive insertion there.
Loading the case again is a no-op. The visual audit playground keeps its existing
`pnpm dev` command and port 3000.

```powershell
pnpm typecheck
pnpm test
pnpm build:finance
pnpm build
```

PowerShell users can use `pnpm.cmd` if execution policy blocks the script launcher.
If pnpm is not installed, `npx.cmd --yes pnpm@10.20.0 <command>` is an equivalent
launcher (including `install`, `dev:backend`, and `dev:finance`).

## Audit integration API

Import `api` from root `convex/_generated/api`; install `convex` in the consuming
workspace and wrap React consumers in a `ConvexProvider` for the same deployment.

| Function | Arguments | Result |
| --- | --- | --- |
| `api.finance.seedSyntheticCase` (mutation) | `{}` | `{ caseId, taskId, runId, created }` |
| `api.finance.getSyntheticCase` (query) | `{}` | `FinanceCaseBundle \| null` |
| `api.finance.listTaskEvents` (query) | `{ taskId: string }` | `FinanceEvent[]` |
| `api.finance.listTaskSnapshots` (query) | `{ taskId: string }` | `FinanceSnapshot[]` |

The query result types are validated server-side and checked against
`@mangekyo/contracts`. The package exports the types at its root and at `/finance`,
`/events`, and `/snapshots`. This checkout had no existing `audit.ts` or
`corrections.ts`; those future interfaces have not been invented for this milestone.

```tsx
const financeCase = useQuery(api.finance.getSyntheticCase, {});
const events = useQuery(
  api.finance.listTaskEvents,
  financeCase ? { taskId: financeCase.task.taskId } : "skip",
);
const snapshots = useQuery(
  api.finance.listTaskSnapshots,
  financeCase ? { taskId: financeCase.task.taskId } : "skip",
);
```

Domain identifiers are stable strings rather than Convex `_id` values. The case
is `synthetic-finance-case-001`; its task is `synthetic-finance-case-001:task:001`.
Each record carries `caseId` and `synthetic: true`. Events/snapshots carry `taskId`,
`runId`, their own identifiers, and monotonically ordered task `sequence` values.
Snapshots refer to their event with `eventId`; their `taskState` captures the state
at that step, and `inputs.evidenceRefs` links to the document's stable `sourceId`,
`documentId`, and verbatim excerpt. The transaction has its own bank-feed `sourceId`.
The output explicitly records zero allocated cents and no approval.

Both streams return the first 100 records in ascending `(taskId, sequence)` index
order. Add pagination before longer runs; no history is discarded in storage.
Unknown tasks yield empty arrays. Queries are reactive; no polling or browser storage is
used. Future writers must allocate the next task sequence transactionally and
append records rather than updating or deleting history. No general-purpose
event update/delete API is exposed. Convex administrators still have direct data
access; this is application-level append-only history, not tamper-proof storage.

One indexed idempotency lookup and all seven inserts occur in one mutation.
Convex transaction conflict detection handles simultaneous first loads; a repeat
returns the original identifiers and does not alter timestamps or append history.
The sample seed accepts no arbitrary data and the public queries expose only
these synthetic records. Authentication/authorization for real client data is a
later milestone and must precede adding that data to these public endpoints.

The snapshot is structured data only. There is no screenshot or model-generated
explanation. Future workers must explicitly query and select saved evidence as
context; persistence does not insert it into a model prompt.

## Next step

The controlled investigation transition is now implemented in the
[investigation milestone](finance-investigation.md), with allocation and approval
kept separate from investigation results.

## Verification performed on October 23, 2026

- Inspected the existing `laudable-sturgeon-5` deployment before syncing: no
  functions or tables were present. Synced successfully with `convex dev --once`.
- All workspace type checks passed, including the existing visual audit package
  and playground. Backend test source and configuration also type-check.
- All four Convex tests passed: empty queries, complete/idempotent persistence,
  evidence/state correlation with no allocation or approval, and ordered,
  task-scoped event/snapshot streams.
- Both the finance Next.js build and the existing visual audit build passed.
- Two headless Chrome tabs connected before seeding. Loading the case in the
  first tab updated the second tab's case, event, and snapshot without reloading.
- Reloading the first tab displayed the same saved case. Seeding again through
  the second tab and two concurrent API calls preserved the original records.
- The shared backend queries returned one correlated event and snapshot.
  A read-only backend count confirmed one row in each of the seven finance tables.
- `git diff --check` passed; no teammate visual audit files were changed.

The supplied `laudable-surgeon-5` spelling returned HTTP 404 and could not be
resolved by the CLI. The owner confirmed the existing `laudable-sturgeon-5`
deployment, which is the configured and tested target. Local CLI credentials
were saved by the device login flow outside the repository; no credentials were
printed or added to source control. Some read-only CLI commands printed a
Windows/Node 24 shutdown assertion after returning their results; deployment,
application builds, tests, and browser verification completed successfully.

## Files added or changed

- `apps/finance-dev/`: workspace manifest, Next.js/TypeScript setup, local env
  example, Convex provider, page, error boundary, and styles.
- `packages/finance-core/`: package setup and reusable `FinanceCaseView`.
- `packages/contracts/`: package setup and `finance.ts`, `events.ts`,
  `snapshots.ts`, and root type exports.
- `convex/`: schema, validators, finance mutation/queries, tests, generated API
  and data model/server bindings, TypeScript configuration, and AI guidance.
- Root `package.json`, `pnpm-lock.yaml`, `convex.json`, `.env.example`,
  `.gitignore`, `vitest.config.ts`, `tsconfig.tests.json`, `AGENTS.md`,
  `CLAUDE.md`, and `README.md`; this integration document.

The AI installer also installs local agent skills; those machine-local skill
directories and its skill lockfile are ignored. Convex API bindings and AI
guidance are included in the repository sources.

## Official setup references

- [Convex AI guidance](https://docs.convex.dev/ai)
- [Convex Next.js quickstart](https://docs.convex.dev/quickstart/nextjs)
- [Convex hackathon resources](https://www.convex.dev/hackathons/resources)
