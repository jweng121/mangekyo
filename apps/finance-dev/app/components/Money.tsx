"use client";

import CountUp from "./reactbits/CountUp";
import { usePrefersReducedMotion } from "./MotionRoot";
import { money } from "../lib/desk";

/** Integer cents shown as dollars; animates from the previous value whenever the value changes. */
export function Money({ cents, className }: { cents: number | null; className?: string }) {
  const reduced = usePrefersReducedMotion();
  if (cents === null) return <span className={className}>—</span>;
  return <span className={className} role="img" aria-label={money(cents)}>
    <span aria-hidden="true"><CountUp to={Math.abs(cents) / 100} decimals={2} separator="," prefix={cents < 0 ? "−$" : "$"} duration={reduced ? 0 : 0.8} trigger="load" /></span>
  </span>;
}
