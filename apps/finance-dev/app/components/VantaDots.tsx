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
      const THREE = await import("three");
      const DOTS = (await import("vanta/dist/vanta.dots.min")).default;
      if (cancelled || !ref.current) return;
      effect = DOTS({ el: ref.current, THREE, mouseControls: true, touchControls: true, gyroControls: false, color: 0xffffff, color2: 0xffffff, backgroundColor: 0x050505, size: 2.2, spacing: 26, showLines: false });
    })().catch(() => { effect = null; });
    return () => { cancelled = true; effect?.destroy(); };
  }, []);
  return <div ref={ref} className="vanta" aria-hidden="true" />;
}
