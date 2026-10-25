"use client";

import { type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";


gsap.registerPlugin(ScrollTrigger);

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const usePrefersReducedMotion = prefersReducedMotion;

/** Lenis smooth scroll driven from gsap.ticker, feeding ScrollTrigger. Off under reduced motion. */
export function MotionRoot({ className, children }: { className: string; children: ReactNode }) {
  return <div className={`mk ${className}`}>{children}</div>;
}
