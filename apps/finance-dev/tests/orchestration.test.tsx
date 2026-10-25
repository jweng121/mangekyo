/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";
import { eventTitle, type TimelineEvent } from "../app/lib/orchestrator";

const results: Record<string, unknown> = {};
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => args === "skip" ? undefined : results[getFunctionName(ref)],
  usePaginatedQuery: (ref: Parameters<typeof getFunctionName>[0]) => ({ results: (results[getFunctionName(ref)] as { page: unknown[] } | undefined)?.page ?? [], status: "Exhausted", loadMore: () => undefined }),
  useMutation: () => async () => { throw new Error("not used in render test"); },
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ runId: encodeURIComponent(String(results.runId)), accountId: encodeURIComponent(String(results.accountId)) }), useRouter: () => ({ push: () => undefined }) }));

const decode = (html: string) => html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">");
const modules = import.meta.glob(["../../../convex/**/*.{ts,js}", "!../../../convex/**/*.test.ts"]);
type T = ReturnType<typeof convexTest>;
async function drain(t: T) { for (let i = 0; i < 12; i++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); } }

describe("orchestration on the desk, inspector and scorecard", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("names every kind of orchestrator event in words", () => {
    const base = { eventId: "e", sequence: 1, trigger: "validated", actor: { type: "code", identity: "code:finance-core" }, reason: { code: "X", message: "m" }, timestamp: 0, snapshotId: "s", runId: null } satisfies Partial<TimelineEvent>;
    expect(eventTitle({ ...base, kind: "transition", from: "validating", to: "checking" })).toBe("Validating the answer → Checking every claim");
    expect(eventTitle({ ...base, kind: "retry", from: "investigating", to: "investigating" })).toBe("Retried once automatically");
    expect(eventTitle({ ...base, kind: "budget_check", from: "received", to: "received", budget: { allowed: false, usedToday: 5, usedForDeposit: 0, needed: 1, limits: { perDay: 5, perDeposit: 2 } } })).toBe("Budget check: refused");
  });

  it("shows the scorecard line and the mismatch agent's fix on the desk, and the scorecard page", async () => {
    const t = convexTest(schema, modules);
    const { accountId } = await t.mutation(api.financeScorecard.runPlanted, {});
    await drain(t);
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    Object.assign(results, {
      accountId,
      "financeIntake:listAccounts": await t.query(api.financeIntake.listAccounts, {}), "financeIntake:getAccountOverview": await t.query(api.financeIntake.getAccountOverview, { accountId }),
      "financeDesk:getDeskData": await t.query(api.financeDesk.getDeskData, { accountId }), "financeInvestigations:getProviderConfiguration": await t.query(api.financeInvestigations.getProviderConfiguration, {}),
      "financeDesk:getActivity": await t.query(api.financeDesk.getActivity, { accountId, paginationOpts: { numItems: 50, cursor: null } }),
      "financeOrchestrator:getConfiguration": await t.query(api.financeOrchestrator.getConfiguration, { now }), "financeOrchestrator:getPipeline": await t.query(api.financeOrchestrator.getPipeline, { accountId }),
      "financeReconciliation:listCorrections": await t.query(api.financeReconciliation.listCorrections, { accountId }), "financeScorecard:getScorecard": await t.query(api.financeScorecard.getScorecard, { accountId }),
    });
    const { default: Desk } = await import("../app/desk/page");
    const html = decode(renderToString(<Desk />));
    for (const text of ["Caught 6 of 6 · wrong 0 · asked a person 2", "Open scorecard", "Mismatch agent · proposes a fix", "Record $2,500.00 against Daniel Okafor", "bank returned D OKAFOR's $2,500.00 check",
      "Approve entry", "ready for approval", "rejected by the checker", "Measure…", "real runs today 0 of 5", "checker mock"]) expect(html).toContain(text);
    // The old code-only card for the same bank item is replaced by the agent's fix.
    expect(html).not.toContain("Code · fixes the gap");
    const { default: Scorecard } = await import("../app/scorecard/[accountId]/page");
    const page = decode(renderToString(<Scorecard />));
    for (const text of ["Each planted mistake and its right answer", "Wrong client", "Duplicate", "Uncleared payout", "Overdraw", "Unsupported claim", "Bounced check", "Caught · asked a person", "Agent 2 · checker", "The lock", "Mismatch agent"]) expect(page).toContain(text);
  });

  it("shows the orchestrator timeline in the run inspector and the mismatch run page", async () => {
    const t = convexTest(schema, modules);
    const { accountId } = await t.mutation(api.financeScorecard.runPlanted, {});
    await drain(t);
    const card = await t.query(api.financeScorecard.getScorecard, { accountId });
    if (card?.kind !== "planted") throw new Error("expected planted");
    const wrongClient = decodeURIComponent(card.plants.find(p => p.key === "wrong-client")!.link!.replace("/runs/", ""));
    const run = (await t.query(api.financeDesk.getRunView, { runId: wrongClient }))!;
    Object.assign(results, { runId: wrongClient, "financeDesk:getRunView": run, "financeOrchestrator:getTimeline": await t.query(api.financeOrchestrator.getTimeline, { taskId: run.run.taskId }) });
    const { default: Inspector } = await import("../app/runs/[runId]/page");
    const inspector = decode(renderToString(<Inspector />));
    for (const text of ["Orchestrator", "Now: Rejected by the checker", "Budget check: mock, doesn't count", "Received → Investigating", "Checking every claim → Rejected by the checker", "Not supported", "Chen & Park Holdings", "CHECKER_MODE=mock"]) expect(inspector).toContain(text);
    const bounced = decodeURIComponent(card.plants.find(p => p.key === "bounced-check")!.link!.replace("/reconciliation/", ""));
    Object.assign(results, { runId: bounced, "financeReconciliation:getRunView": await t.query(api.financeReconciliation.getRunView, { runId: bounced }) });
    const { default: Recon } = await import("../app/reconciliation/[runId]/page");
    const recon = decode(renderToString(<Recon />));
    for (const text of ["Found by code · three-way check", "What the agent was given", "Explanation", "Proposed correcting entry", "R1 · clears the mismatch", "passed in the dry run", "Now: Needs a person"]) expect(recon).toContain(text);
  });
});
