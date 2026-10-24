"use client";

import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "./MotionRoot";

/** Vanta DOTS (three r134). Loaded only on the landing page via next/dynamic with ssr: false; destroyed on unmount. */
export default function VantaDots() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (prefersReducedMotion() || !ref.current) return;
    let effect: { destroy(): void } | null = null;
    let cancelled = false;
    (async () => {
      const three = await import("three");
      // three r134 is a CommonJS build: its classes may sit on the namespace or on .default.
      const THREE = three.PerspectiveCamera ? three : three.default;
      // Vanta's bundle reads window.THREE when it loads, so expose r134 before importing it.
      (window as unknown as { THREE: unknown }).THREE = THREE;
      const DOTS = (await import("vanta/dist/vanta.dots.min")).default;
      if (cancelled || !ref.current) return;
      effect = DOTS({ el: ref.current, THREE, mouseControls: true, touchControls: true, gyroControls: false, color: 0xffffff, color2: 0xffffff, backgroundColor: 0x050505, size: 2.2, spacing: 26, showLines: false });
    })().catch(() => { effect = null; });
    // A failed or partial init must never break unmounting.
    return () => { cancelled = true; try { effect?.destroy(); } catch { /* already gone */ } };
  }, []);
  return <div ref={ref} className="vanta" aria-hidden="true" />;
}
