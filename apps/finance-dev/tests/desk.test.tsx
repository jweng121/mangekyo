/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";
import { causeLine, describeEvent, money, ownerStatus, personName, progressText, reasonWords, type Names } from "../app/lib/desk";

const results: Record<string, unknown> = {};
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => args === "skip" ? undefined : results[getFunctionName(ref)],
  useMutation: () => async () => { throw new Error("not used in render test"); },
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ runId: encodeURIComponent(String(results.runId)) }) }));

const decode = (html: string) => html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const modules = import.meta.glob(["../../../convex/**/*.{ts,js}", "!../../../convex/**/*.test.ts"]);
const DEMO = "demo:account:pool-001";
const requester = { role: "requester" as const, name: "riley" };
const approver = { role: "approver" as const, name: "sam" };

describe("desk helpers", () => {
  it("formats money with a real minus sign and hides internal identity prefixes", () => {
    expect(money(-123_456)).toBe("−$1,234.56");
    expect(money(null)).toBe("—");
    expect(personName("dev-unverified:sam")).toBe("sam");
    expect(personName("agent:finance-investigator:run-1")).toBe("Agent");
    expect(reasonWords(["OWNER_INSUFFICIENT_FUNDS", "OWNER_INSUFFICIENT_FUNDS"])).toBe("the owner doesn't have enough money");
  });

  it("gives specific progress text for every active run state and none for finished ones", () => {
    for (const status of ["queued", "retrieving_evidence", "checking", "provider_starting", "provider_pending", "validating"]) {
      const text = progressText(status, "$980.00 from DEMO J SMITH", null);
      expect(text).toContain("$980.00 from DEMO J SMITH");
      expect(text).not.toMatch(/processing/i);
    }
    expect(progressText("needs_information", "x", null)).toBeNull();
  });
});

describe("desk render with real backend query results", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); vi.stubEnv("FINANCE_AGENT_MODE", "mock"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("shows the equation, cause, queue cards, plain-English activity and owners in words", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    for (let round = 0; round < 5; round++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); }
    await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:xavier", amountCents: 500_000, purpose: "tax", evidenceSourceIds: ["demo:document:instruction-x-001:v1"], dev: requester });
    const y = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:yankee", amountCents: 100_000, purpose: "relocation", evidenceSourceIds: ["demo:document:instruction-y-001:v1"], dev: requester });
    await t.mutation(api.financeProposals.approveProposal, { proposalId: y.proposal.proposalId, dev: approver });
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, {});
    await t.mutation(api.financeProposals.postProposal, { proposalId: y.proposal.proposalId, dev: approver });
    const overview = await t.query(api.financeIntake.getAccountOverview, { accountId: DEMO });
    const desk = await t.query(api.financeDesk.getDeskData, { accountId: DEMO });
    Object.assign(results, {
      "financeIntake:listAccounts": await t.query(api.financeIntake.listAccounts, {}), "financeIntake:getAccountOverview": overview,
      "financeDesk:getDeskData": desk, "financeInvestigations:getProviderConfiguration": await t.query(api.financeInvestigations.getProviderConfiguration, {}),
    });

    const names: Names = { owner: id => overview.owners.find(o => o.ownerId === id)?.name ?? "Not yet assigned", deposit: () => "a deposit", proposal: id => overview.proposals.find(p => p.proposalId === id) };
    const rows = desk.activity.map(e => describeEvent(e, names));
    expect(rows.every(r => r.text.length > 0 && !/demo:account|intake:/.test(r.text))).toBe(true);
    expect(rows.some(r => r.who === "Agent" && r.tone === "agent")).toBe(true);
    expect(rows.some(r => r.who === "sam" && r.tone === "person")).toBe(true);
    expect(causeLine(overview.threeWay, names.owner)).toBe("Found by code: $2,000.00 moved at the bank with no ledger entry. Payments for DEMO Owner Y — Yankee Trust are on hold until it's fixed.");
    expect(ownerStatus(overview.balances.find(b => b.ownerId === "demo:owner:yankee")!, overview.threeWay).text).toBe("Payments on hold: books don't reconcile");

    const { default: Desk } = await import("../app/desk/page");
    const html = decode(renderToString(<Desk />));
    for (const text of ["Doesn't reconcile: $2,000.00 gap", "Bank, adjusted", "Every owner, added up", "Found by code:", "Needs a person", "On hold · needs a person",
      "Approve entry", "AI proposal · needs sign-off", "The agent stopped to ask", "Blocked by the lock · rule L1", "Pooled account, cleared", "AI · proposed policy",
      "started automatically", "posted after sign-off", "Acting as (dev only)", "Break it…", "New payment", "Not yet assigned"]) expect(html).toContain(text);
    expect(html).not.toMatch(/Processing/);
  });

  it("renders the run inspector and what the agent saw from a frozen input", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    for (let round = 0; round < 5; round++) { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); }
    const desk = await t.query(api.financeDesk.getDeskData, { accountId: DEMO });
    const runId = desk.tasks.find(task => task.bankSourceId === "demo:bank:txn:A-001")!.latestRun!.runId;
    results.runId = runId;
    results["financeDesk:getRunView"] = await t.query(api.financeDesk.getRunView, { runId });
    const { default: Inspector } = await import("../app/runs/[runId]/page");
    const inspector = decode(renderToString(<Inspector />));
    for (const text of ["Every run is kept", "Ready for approval", "Claim by claim", "Not checked yet", "Gathered and froze the evidence", "What the agent saw"]) expect(inspector).toContain(text);
    const { default: AgentView } = await import("../app/runs/[runId]/view/page");
    const seen = decode(renderToString(<AgentView />));
    for (const text of ["PLACEHOLDER · VISUAL AUDIT", "Exactly what it was given", "demo:bank:txn:A-001", "demo:document:remit-a-001:v1", "finance-investigator/v1", "context as of"]) expect(seen).toContain(text);
  });
});
