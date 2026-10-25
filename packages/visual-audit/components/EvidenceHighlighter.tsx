"use client";
import { useEffect, useState } from "react";
import type { EvidenceAnnotation, Snapshot } from "@mangekyo/contracts";
import { resolveHighlights } from "../annotations/highlight-resolver";

function DocumentText({ text, annotations }: { text: string; annotations: EvidenceAnnotation[] }) {
  const positions = annotations.flatMap(annotation => {
    if (!annotation.textQuote) return [];
    const start = text.indexOf(annotation.textQuote);
    return start < 0 ? [] : [{ start, end: start + annotation.textQuote.length, annotation }];
  }).sort((a, b) => a.start - b.start);
  const content: React.ReactNode[] = [];
  let cursor = 0;
  for (const position of positions) {
    if (position.start < cursor) continue;
    content.push(text.slice(cursor, position.start));
    content.push(<mark key={position.annotation.id} id={`highlight-${position.annotation.id}`} className="evidence-mark">{text.slice(position.start, position.end)}</mark>);
    cursor = position.end;
  }
  content.push(text.slice(cursor));
  return <div className="document-text">{content}</div>;
}

export function EvidenceHighlighter({ snapshot, activeHighlightIds }: { snapshot: Snapshot; activeHighlightIds: string[] }) {
  const active = resolveHighlights(snapshot, activeHighlightIds);
  const [zoomed, setZoomed] = useState(false);
  const firstRegion = active.find(annotation => annotation.region)?.region;
  useEffect(() => { setZoomed(false); }, [snapshot.id]);
  useEffect(() => {
    const id = active[0]?.id;
    if (id) document.getElementById(`highlight-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [snapshot.id, activeHighlightIds.join("|")]);
  return <div className="observation"><div className="observation-head"><span className="live-dot" /> {snapshot.screenshot ? `${snapshot.screenshot.provenance} screenshot` : "STRUCTURED OBSERVATION · SYNTHETIC"}<span>{snapshot.source}</span></div>
    {snapshot.screenshot && <><div className="screenshot-stage"><div className="screenshot-image-layer" style={{ transform: zoomed && firstRegion ? "scale(2)" : undefined, transformOrigin: firstRegion ? `${(firstRegion.x + firstRegion.width / 2) * 100}% ${(firstRegion.y + firstRegion.height / 2) * 100}%` : undefined }}><img src={snapshot.screenshot.url} alt={snapshot.screenshot.alt} /><svg className="screenshot-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Recorded evidence regions">{active.filter(annotation => annotation.region).map(annotation => <rect key={annotation.id} id={`highlight-${annotation.id}`} x={annotation.region!.x * 1000} y={annotation.region!.y * 1000} width={annotation.region!.width * 1000} height={annotation.region!.height * 1000} fill="#f2d97344" stroke="#f1d565" strokeWidth="5" vectorEffect="non-scaling-stroke"><title>{annotation.label}</title></rect>)}</svg></div></div><div className="screenshot-actions"><button type="button" disabled={!firstRegion} onClick={() => setZoomed(value => !value)}>{zoomed ? "Fit screenshot" : "Zoom to evidence"}</button><a href={snapshot.screenshot.url} target="_blank" rel="noreferrer">Open original capture</a></div></>}
    {snapshot.observation.documentText && <DocumentText text={snapshot.observation.documentText} annotations={active} />}
    {snapshot.observation.fields.length > 0 && <div className="observation-fields">{snapshot.observation.fields.map(field => {
      const annotation = active.find(item => item.fieldPath === `observation.fields.${field.id}`);
      return <div key={field.id} id={annotation ? `highlight-${annotation.id}` : undefined} className={`observation-field ${field.emphasis ?? ""} ${annotation ? "voice-highlight" : ""}`}><div><small>{field.label}</small><strong>{field.value}</strong></div>{field.sourceRef && <a href={`#evidence-${field.sourceRef}`}>↗ {field.sourceRef}</a>}</div>;
    })}</div>}
  </div>;
}
