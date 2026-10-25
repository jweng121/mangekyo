import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../app/components/MotionRoot", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("../app/components/reactbits/CountUp", () => ({ default: ({ to, prefix }: { to: number; prefix: string }) => <span>{prefix}{to.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> }));
import { Money } from "../app/components/Money";
import { scrubIds } from "../app/lib/desk";

it("renders one formatted money text with the same accessible label", () => {
  const html = renderToStaticMarkup(<Money cents={27_535_000} />);
  expect(html.replace(/<[^>]*>/g, "")).toBe("$275,350.00");
  expect(html).toContain('aria-label="$275,350.00"');
  expect(html).not.toContain("$275350.00");
});

it("replaces namespaced internal IDs in activity with readable names", () => {
  expect(scrubIds("Received demo:run-010:bank:txn:F-005 for demo:owner:westbrook", {
    deposit: () => "$300.00 from the payer", owner: () => "Westbrook HOA", proposal: () => undefined,
  })).toBe("Received $300.00 from the payer for Westbrook HOA");
});
