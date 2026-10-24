/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const results: Record<string, unknown> = {};
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => args === "skip" ? undefined : results[getFunctionName(ref)],
  useMutation: () => async () => { throw new Error("not used in render test"); },
}));

const modules = import.meta.glob(["../../../convex/**/*.{ts,js}", "!../../../convex/**/*.test.ts"]);
const DEMO = "demo:account:pool-001";
const requester = { role: "requester" as const, name: "riley" };
const approver = { role: "approver" as const, name: "sam" };

describe("MoneyPanel render smoke test with real backend query results", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 24, 12)); });
  afterEach(() => vi.useRealTimers());

  it("renders three numbers, causes, balances, deposits, proposals and lock outcomes", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.financeIntake.importErpSandbox, {});
    await t.mutation(api.financeIntake.loadDemoFixture, {});
    await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:xavier", amountCents: 500_000, purpose: "tax", evidenceSourceIds: ["demo:document:instruction-x-001:v1"], dev: requester });
    const pay = await t.mutation(api.financeProposals.requestPayment, { accountId: DEMO, ownerId: "demo:owner:yankee", amountCents: 100_000, purpose: "relocation", evidenceSourceIds: ["demo:document:instruction-y-001:v1"], dev: requester });
    await t.mutation(api.financeProposals.approveProposal, { proposalId: pay.proposal.proposalId, dev: approver });
    await t.mutation(api.financeProposals.postProposal, { proposalId: pay.proposal.proposalId, dev: approver });
    await t.mutation(api.financeIntake.simulateUnrecordedOutflow, {});
    results["financeIntake:listAccounts"] = await t.query(api.financeIntake.listAccounts, {});
    results["financeIntake:getAccountOverview"] = await t.query(api.financeIntake.getAccountOverview, { accountId: DEMO });
    results["finance:listMoneyEvents"] = await t.query(api.finance.listMoneyEvents, { accountId: DEMO });

    const { MoneyPanel } = await import("../app/MoneyPanel");
    const html = renderToString(<MoneyPanel connected />).replace(/<!-- -->/g, "");
    expect(html).toContain("DEV ONLY role switcher");
    expect(html).toContain("three-numbers mismatched");
    expect(html).toContain("BANK_TXN_WITHOUT_LEDGER_ENTRY");
    expect(html).toContain("Reconciling items");
    expect(html).toContain(`Outstanding payment -$1,000.00`);
    expect(html).toContain(`PAY:${pay.proposal.proposalId}`);
    expect(html).toContain("DEMO Owner X — Xavier Trust");
    expect(html).toContain("OWNER_INSUFFICIENT_FUNDS");
    expect(html).toContain("demo:bank:txn:B-001");
    expect(html).toContain("DEV: simulate bank settlement");
    expect(html).toContain("finance.money.ledger_posted");
  });
});
