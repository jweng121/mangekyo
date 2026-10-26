import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateHayesRequest } from "../apps/visual-audit-dev/lib/hayes-lock";

const root = new URL("../packages/finance-core/fixtures/hartwell/erp/", import.meta.url);
const source = <T>(name: string): T => JSON.parse(readFileSync(new URL(`${name}.json`, root), "utf8"));

describe("Hayes ownership lock replay", () => {
  it("blocks the $630,000 cross-client shortfall even with matched pooled cash", () => {
    const { poolCents, ownerCents, amountCents, shortageCents, result, threeWay } = evaluateHayesRequest(
      source("bank-transactions"), source("clients"),
    );
    expect(threeWay.status).toBe("matched");
    expect(poolCents).toBe(3_295_679_250);
    expect(ownerCents).toBe(27_000_000);
    expect(amountCents).toBe(90_000_000);
    expect(shortageCents).toBe(63_000_000);
    expect(result.allowed).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ rule: "L1", code: "OWNER_INSUFFICIENT_FUNDS" })]);
  });
});
