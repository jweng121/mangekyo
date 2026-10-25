import { expect, it } from "vitest";
import { lawFirmBundle } from "../fixtures/lawFirm";
import { demoMoneyBundle } from "../fixtures/demoMoney";
import { threeWayCheck } from "../src/ledger";
import { NOW, stateFrom } from "./money";

it("opens the fictional law firm at exactly $32,872,700, fully cleared and matched", () => {
  const bundle = lawFirmBundle("demo:account:pool-020");
  // Six clients plus the firm's own-money owner (opens at zero); five documents plus Delgado's signed statement and fee agreement.
  expect(bundle.owners).toHaveLength(7);
  expect(bundle.owners.filter(o => o.ownerKind === "firm")).toHaveLength(1);
  expect(bundle.documents).toHaveLength(7);
  expect(bundle.documents.filter(d => d.signed)).toHaveLength(3);
  expect(bundle.openingBalances.reduce((sum, b) => sum + b.amountCents, 0)).toBe(3_287_270_000);
  expect(bundle.openingBalances.every(b => b.amountCents === b.clearedCents && Number.isSafeInteger(b.amountCents))).toBe(true);
  expect(threeWayCheck(stateFrom(bundle), NOW)).toMatchObject({ status: "matched", bookCents: 3_287_270_000, ownersTotalCents: 3_287_270_000, bank: { adjustedCents: 3_287_270_000, clearedCents: 3_287_270_000 } });
});

it("namespaces new law-firm records without changing the original fixture", () => {
  const old = demoMoneyBundle();
  const a = lawFirmBundle("demo:account:pool-020");
  const b = lawFirmBundle("demo:account:pool-021");
  const ids = new Set(a.documents.map(d => d.sourceId));
  expect(b.documents.every(d => !ids.has(d.sourceId) && d.sourceId.startsWith("demo:"))).toBe(true);
  expect(demoMoneyBundle()).toEqual(old);
});
