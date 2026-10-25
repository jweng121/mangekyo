"use client";

import { useEffect, useRef, useState } from "react";
import type { EvidenceAnnotation, Snapshot } from "../../../packages/contracts";
import { annotationContext } from "./annotation-context";

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const padded = (r: Box, gap: number): Box => ({ x: r.x - gap, y: r.y - gap, w: r.w + gap * 2, h: r.h + gap * 2 });
// Test the connector against every other highlight, including its number badge.
function crosses(a: { x: number; y: number }, b: { x: number; y: number }, box: Box) {
  let lo = 0, hi = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, box.x, box.x + box.w], [a.y, b.y - a.y, box.y, box.y + box.h]]) {
    if (Math.abs(delta) < .001) { if (start < min || start > max) return false; }
    else { const t1 = (min - start) / delta, t2 = (max - start) / delta; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); }
  }
  return lo <= hi;
}

export function EvidenceCallout({ snapshot, annotation, number }: { snapshot: Snapshot; annotation: EvidenceAnnotation; number?: number }) {
  const layer = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ x: number; y: number; path: string }>();
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      const host = layer.current;
      const image = host?.parentElement?.querySelector(".evidence-image");
      const regions = Array.from(image?.querySelectorAll("[data-evidence-region]") ?? []);
      const region = regions.find(item => item.getAttribute("data-evidence-region") === annotation.id);
      let next: typeof placement;
      if (host && image && region && card.current) {
        const view = host.getBoundingClientRect();
        const box = (element: Element): Box => { const r = element.getBoundingClientRect(); return { x: r.left - view.left, y: r.top - view.top, w: r.width, h: r.height }; };
        const bounds = box(image), target = box(region);
        const width = card.current.offsetWidth, height = card.current.offsetHeight;
        const obstacles = regions.map(item => padded(box(item), 11));
        const others = regions.filter(item => item !== region).map(item => padded(box(item), 11));
        const clampX = (x: number) => Math.max(bounds.x + 6, Math.min(bounds.x + bounds.w - width - 6, x));
        const clampY = (y: number) => Math.max(bounds.y + 6, Math.min(bounds.y + bounds.h - height - 6, y));
        const xs = [target.x, target.x + (target.w - width) / 2, target.x + target.w - width, bounds.x + 6, bounds.x + bounds.w - width - 6];
        const ys = [target.y, target.y + (target.h - height) / 2, target.y + target.h - height];
        const candidates: Box[] = [];
        for (const gap of [24, 40, 64]) {
          for (const x of xs) for (const y of [target.y - height - gap, target.y + target.h + gap]) candidates.push({ x: clampX(x), y: clampY(y), w: width, h: height });
          for (const y of ys) for (const x of [target.x - width - gap, target.x + target.w + gap]) candidates.push({ x: clampX(x), y: clampY(y), w: width, h: height });
        }
        // Include gaps beside other regions when the immediate neighbours are occupied.
        for (const obstacle of obstacles) for (const x of xs) for (const y of [obstacle.y - height - 6, obstacle.y + obstacle.h + 6]) candidates.push({ x: clampX(x), y: clampY(y), w: width, h: height });
        let best = Infinity;
        for (const candidate of candidates) {
          if (width > bounds.w - 12 || height > bounds.h - 12 || obstacles.some(item => overlaps(candidate, item))) continue;
          const cx = candidate.x + width / 2, cy = candidate.y + height / 2;
          const start = { x: Math.max(target.x, Math.min(target.x + target.w, cx)), y: Math.max(target.y, Math.min(target.y + target.h, cy)) };
          const end = { x: Math.max(candidate.x, Math.min(candidate.x + width, start.x)), y: Math.max(candidate.y, Math.min(candidate.y + height, start.y)) };
          if (others.some(item => crosses(start, end, item))) continue;
          const distance = Math.hypot(end.x - start.x, end.y - start.y);
          if (distance < best) { best = distance; next = { x: candidate.x, y: candidate.y, path: `M ${start.x} ${start.y} L ${end.x} ${end.y}` }; }
        }
      }
      setPlacement(current => current?.path === next?.path && current?.x === next?.x && current?.y === next?.y ? current : next);
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [annotation.id]);
  return <div className="evidence-callout-layer" ref={layer}>
    {placement && <svg className="evidence-callout-line" aria-hidden="true"><path key={annotation.id} d={placement.path} pathLength="1"/></svg>}
    <div className="evidence-callout-card" title={annotationContext(snapshot, annotation.evidenceRef, annotation.textQuote)} ref={card} style={{ left: placement?.x ?? 0, top: placement?.y ?? 0, visibility: placement ? "visible" : "hidden" }}>
      <strong><span>{number}</span>{annotation.label}</strong>
    </div>
  </div>;
}
