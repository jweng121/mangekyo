"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Minus, Plus, Scan, FileText } from "lucide-react";
import type { Snapshot } from "../../../packages/contracts";
import { resolveAnnotation } from "@mangekyo/visual-audit";
import { RecordEvidenceView } from "./RecordEvidenceView";
import { EvidenceCallout } from "./EvidenceCallout";
import { IconButton } from "./ReviewControls";

export function EvidenceCanvas({ snapshot, focusedAnnotationId, focusRequestId = 0, highlightIds, annotationNumbers = {}, zoomOnFocus = true, showCallout = false, onEvidence }: { showCallout?: boolean; zoomOnFocus?: boolean; snapshot?: Snapshot; focusedAnnotationId?: string; focusRequestId?: number; highlightIds: string[]; annotationNumbers?: Record<string, number>; onEvidence: (id: string) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 800, height: 600 });
  const [natural, setNatural] = useState({ width: 1280, height: 900 });
  const [windowHeight, setWindowHeight] = useState(900);
  const [fitMode, setFitMode] = useState<"width" | "page">("width");
  const [scaleOverride, setScaleOverride] = useState<number>();
  const [fullscreen, setFullscreen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const annotations = (snapshot?.annotations ?? []).filter(item => snapshot && resolveAnnotation(snapshot, item));
  const focused = annotations.find(item => item.id === focusedAnnotationId) ?? annotations.find(item => highlightIds.includes(item.id));
  const fitWidth = Math.max(.1, (bounds.width - 24) / natural.width);
  const fit = fitMode === "width" ? fitWidth : Math.min(fitWidth, Math.max(.1, (windowHeight - 180) / natural.height));
  const scale = Math.min(fitWidth, scaleOverride ?? fit);
  const imageWidth = natural.width * scale;
  const imageHeight = natural.height * scale;
  const planeWidth = Math.max(bounds.width, imageWidth + 24);
  const planeHeight = imageHeight + 24;
  const left = (planeWidth - imageWidth) / 2;
  const top = 12;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resizeWindow = () => setWindowHeight(window.innerHeight);
    resizeWindow(); window.addEventListener("resize", resizeWindow);
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(viewport);
    return () => { observer.disconnect(); window.removeEventListener("resize", resizeWindow); };
  }, []);
  useEffect(() => { setScaleOverride(undefined); setFitMode("width"); setNatural(snapshot?.screenshotDimensions ?? snapshot?.viewport ?? { width: 1280, height: 900 }); viewportRef.current?.scrollTo(0, 0); }, [snapshot?.id]);
  useEffect(() => {
    if (!focusedAnnotationId || !focused?.region) return;
    if (zoomOnFocus) setScaleOverride(Math.max(fit, Math.min(1.2, 300 / (focused.region.width * natural.width))));
    setFocusRequest(value => value + 1);
  }, [focusedAnnotationId, focusRequestId]);
  useEffect(() => {
    if (!focusRequest || !focused?.region || !viewportRef.current) return;
    const region = focused.region;
    const frame = requestAnimationFrame(() => {
      const target = viewportRef.current?.querySelector(`[data-evidence-region="${CSS.escape(focused.id)}"]`);
      target?.scrollIntoView({ block: "center", inline: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, scale, bounds.width]);
  useEffect(() => {
    if (!showCallout || !snapshot || snapshot.screenshot) return;
    const target = viewportRef.current?.querySelector(".record-focused, .evidence-structured");
    target?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [snapshot?.id, focusedAnnotationId, focusRequestId, showCallout]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setFullscreen(false); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);

  return <div className={`evidence-canvas ${fullscreen ? "fullscreen" : ""}`}>
    {snapshot?.sourceDocument && <div className="pdf-source-bar"><span>PDF / Page {snapshot.sourceDocument.pageNumber} of {snapshot.sourceDocument.pageCount}</span><a href={snapshot.sourceDocument.url} target="_blank" rel="noopener noreferrer">Open original PDF</a></div>}
    <div className="evidence-stage"><div className="evidence-viewport" ref={viewportRef}>
      {snapshot?.screenshot ? <div className="evidence-plane" style={{ width: planeWidth, height: planeHeight }}><div className="evidence-image" style={{ width: imageWidth, height: imageHeight, left, top }}>
        <img src={snapshot.screenshot.url} alt={snapshot.screenshot.alt} draggable={false} onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}/>
        <svg className="evidence-overlays" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Evidence regions">{annotations.filter(item => item.region).map(item => <rect data-evidence-region={item.id} key={`${item.id}-${focusedAnnotationId === item.id ? focusRequestId : 0}`} x={item.region!.x * 1000} y={item.region!.y * 1000} width={item.region!.width * 1000} height={item.region!.height * 1000} rx={6 * 1000 / imageWidth} ry={6 * 1000 / imageHeight} className={`evidence-region ${focusedAnnotationId === item.id ? "active" : ""}`} tabIndex={0} role="button" aria-label={`View annotation: ${item.label}`} onClick={() => onEvidence(item.evidenceRef)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onEvidence(item.evidenceRef); } }}><title>{item.label}</title></rect>)}</svg>
        {annotations.filter(item => item.region).map((item, index) => <button key={item.id} data-annotation-id={item.id} className={`evidence-pin ${focusedAnnotationId === item.id ? "active" : ""}`} style={{ left: `${Math.min(.99, item.region!.x + item.region!.width) * 100}%`, top: `${item.region!.y * 100}%` }} aria-label={`Annotation ${annotationNumbers[item.id] ?? index + 1}: ${item.label}`} onClick={() => onEvidence(item.evidenceRef)}>{annotationNumbers[item.id] ?? index + 1}</button>)}
      </div></div> : snapshot ? <RecordEvidenceView key={`${snapshot.id}-${focusRequestId}`} snapshot={snapshot} onEvidence={onEvidence} focused={focusedAnnotationId}/> : <div className="evidence-placeholder"><FileText size={28}/><p>Select a snapshot</p></div>}
    </div>
    {showCallout && snapshot && focused && <EvidenceCallout key={`${focused.id}-${focusRequestId}`} snapshot={snapshot} annotation={focused} number={annotationNumbers[focused.id]}/> }
    </div>
    {snapshot?.screenshot && <div className="canvas-tools" aria-label="Screenshot controls">
      <IconButton label="Zoom out" disabled={scale <= .15} onClick={() => setScaleOverride(Math.max(.1, scale - .15))}><Minus size={15}/></IconButton>
      <button className="canvas-scale" onClick={() => { setScaleOverride(undefined); setFitMode(fitMode === "width" ? "page" : "width"); setFocusRequest(0); viewportRef.current?.scrollTo(0, 0); }} title={fitMode === "width" ? "Fit entire screenshot" : "Fill available width"}>{scaleOverride === undefined ? fitMode === "width" ? "Width" : "Fit" : `${Math.round(scale * 100)}%`}</button>
      <IconButton label="Zoom in" disabled={scale >= fitWidth} onClick={() => setScaleOverride(Math.min(fitWidth, scale + .15))}><Plus size={15}/></IconButton><span className="tool-divider"/>
      <IconButton label="Focus evidence" disabled={!focused?.region} onClick={() => { setScaleOverride(Math.max(fit, 1)); setFocusRequest(value => value + 1); }}><Scan size={16}/></IconButton>
      <IconButton label={fullscreen ? "Exit full screen" : "Full screen"} onClick={() => setFullscreen(value => !value)}>{fullscreen ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</IconButton>
    </div>}
  </div>;
}
