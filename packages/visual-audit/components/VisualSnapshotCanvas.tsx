"use client";

import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "@mangekyo/contracts";
import { resolveAnnotation, resolveHighlights } from "../annotations/highlight-resolver";

export function VisualSnapshotCanvas({ snapshot, highlightIds, focusedAnnotationId, onEvidence }: { snapshot?: Snapshot; highlightIds: string[]; focusedAnnotationId?: string; onEvidence?: (evidenceId: string) => void }) {
  const [zoom, setZoom] = useState(1);
  const [focus, setFocus] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const visible = snapshot ? (snapshot.annotations ?? []).filter(item => resolveAnnotation(snapshot, item)) : [];
  const active = snapshot ? resolveHighlights(snapshot, highlightIds) : [];
  const region = (visible.find(item => item.id === focusedAnnotationId) ?? active.find(item => item.region))?.region;
  useEffect(() => { setZoom(1); setFocus(false); if (scrollRef.current) scrollRef.current.scrollTo(0, 0); }, [snapshot?.id]);
  useEffect(() => { if (focusedAnnotationId && region) { setZoom(value => Math.max(value, 1.35)); setFocus(true); } }, [focusedAnnotationId, region?.x, region?.y]);
  useEffect(() => { if (!fullscreen) return; const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setFullscreen(false); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [fullscreen]);
  const zoomToEvidence = () => { if (!region) return; setZoom(2); setFocus(true); };
  useEffect(() => {
    if (!focus || !region || !scrollRef.current) return;
    const viewport = scrollRef.current;
    requestAnimationFrame(() => viewport.scrollTo({ left: Math.max(0, viewport.scrollWidth * (region.x + region.width / 2) - viewport.clientWidth / 2), top: Math.max(0, viewport.scrollHeight * (region.y + region.height / 2) - viewport.clientHeight / 2), behavior: "smooth" }));
  }, [focus, zoom, snapshot?.id, region?.x, region?.y]);
  if (!snapshot) return <div className="mc-empty-canvas">Select a task to see what its agent observed.</div>;
  return <div className={`mc-viewer ${fullscreen ? "is-fullscreen" : ""}`}><div className="mc-viewer-tools"><span className="mc-capture-type">{snapshot.screenshot?.provenance === "actual" ? "Captured view" : "Structured evidence"}</span><div><button type="button" onClick={() => { setZoom(value => Math.max(1, value - .25)); setFocus(false); }} disabled={!snapshot.screenshot || zoom <= 1} aria-label="Zoom out">−</button><button type="button" onClick={() => { setZoom(value => Math.min(3, value + .25)); setFocus(false); }} disabled={!snapshot.screenshot} aria-label="Zoom in">+</button><button type="button" onClick={zoomToEvidence} disabled={!region} aria-label="Focus on evidence">Focus</button><button type="button" onClick={() => { setZoom(1); setFocus(false); }} disabled={!snapshot.screenshot}>Fit</button><button type="button" onClick={() => setFullscreen(value => !value)} disabled={!snapshot.screenshot}>{fullscreen ? "Exit full screen" : "Full screen"}</button></div></div>
    <div className="mc-image-scroll" ref={scrollRef}>{snapshot.screenshot ? <div className="mc-image-wrap" style={{ width: `${zoom * 100}%` }}><img src={snapshot.screenshot.url} alt={snapshot.screenshot.alt} /><svg className="mc-annotations" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Recorded evidence regions">{visible.filter(item => item.region).map(item => <g key={item.id}><rect x={item.region!.x * 1000} y={item.region!.y * 1000} width={item.region!.width * 1000} height={item.region!.height * 1000} rx="5" className={item.id === focusedAnnotationId ? "mc-annotation-glow focused" : "mc-annotation-glow"}/><rect x={item.region!.x * 1000} y={item.region!.y * 1000} width={item.region!.width * 1000} height={item.region!.height * 1000} rx="4" className={item.id === focusedAnnotationId ? "mc-annotation-line focused" : "mc-annotation-line"} onClick={() => onEvidence?.(item.evidenceRef)}><title>{item.label}</title></rect></g>)}</svg></div> : <div className="mc-structured"><span>Source observation</span><h3>{snapshot.observation.label}</h3>{snapshot.observation.fields.map(field => <div key={field.id}><small>{field.label}</small><strong>{field.value}</strong></div>)}<p>This document was read through an API. No browser screenshot was captured.</p></div>}</div>
    {active.length > 0 && <div className="mc-evidence-label"><span className="mc-evidence-spark"/> {active[0].label}{snapshot.evidence.find(item => item.id === active[0].evidenceRef)?.value ? <strong>{snapshot.evidence.find(item => item.id === active[0].evidenceRef)?.value}</strong> : null}</div>}
  </div>;
}
