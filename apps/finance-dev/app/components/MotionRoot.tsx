"use client";

import { useEffect, type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const usePrefersReducedMotion = prefersReducedMotion;

/** Lenis smooth scroll driven from gsap.ticker, feeding ScrollTrigger. Off under reduced motion. */
export function MotionRoot({ className, children }: { className: string; children: ReactNode }) {
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const lenis = new Lenis({ duration: 1.0 });
    const raf = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);
    lenis.on("scroll", ScrollTrigger.update);
    return () => { gsap.ticker.remove(raf); lenis.destroy(); };
  }, []);
  return <div className={`mk ${className}`}>{children}</div>;
}
