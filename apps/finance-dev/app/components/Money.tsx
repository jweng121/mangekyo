"use client";

import CountUp from "./reactbits/CountUp";
import { usePrefersReducedMotion } from "./MotionRoot";

/** Integer cents shown as dollars; animates from the previous value whenever the value changes. */
export function Money({ cents, className }: { cents: number | null; className?: string }) {
  const reduced = usePrefersReducedMotion();
  if (cents === null) return <span className={className}>—</span>;
  return <span className={className}>
    <span className="sr">{(cents < 0 ? "−$" : "$") + (Math.abs(cents) / 100).toFixed(2)}</span>
    <span aria-hidden="true"><CountUp to={Math.abs(cents) / 100} decimals={2} separator="," prefix={cents < 0 ? "−$" : "$"} duration={reduced ? 0 : 0.8} trigger="load" /></span>
  </span>;
}
