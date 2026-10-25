"use client";
import { useEffect, useState } from "react";
import type { AuditFinding, Snapshot } from "@mangekyo/contracts";
import { resolveHighlights } from "../annotations/highlight-resolver";
import { EvidenceHighlighter } from "./EvidenceHighlighter";

function KeyValues({ values }: { values?: Record<string, string> }) {
  return values && Object.keys(values).length ? <div className="kv-list">{Object.entries(values).map(([key, value]) => <div key={key}><span>{key}</span><strong>{value}</strong></div>)}</div> : <p className="muted">None recorded.</p>;
}

export function SnapshotInspector({ snapshot, finding, activeHighlightIds = [] }: { snapshot?: Snapshot; finding?: AuditFinding; activeHighlightIds?: string[] }) {
  const [localHighlightIds, setLocalHighlightIds] = useState<string[]>([]);
  const [manualOverride, setManualOverride] = useState(false);
  useEffect(() => { setLocalHighlightIds([]); setManualOverride(false); }, [snapshot?.id]);
  useEffect(() => { setManualOverride(false); }, [activeHighlightIds.join("|")]);
  if (!snapshot) return <section className="panel inspector"><div className="panel-head"><div><div className="eyebrow"></div><h2>Snapshot inspector</h2></div></div><div className="empty-state">Start the synthetic workflow to inspect checkpoints.</div></section>;
  const highlightIds = manualOverride ? localHighlightIds : activeHighlightIds.length ? activeHighlightIds : localHighlightIds;
  const activeRefs = new Set(resolveHighlights(snapshot, highlightIds).map(item => item.evidenceRef));
  return <section className="panel inspector" aria-label="Snapshot inspector">
    <div className="panel-head"><div><div className="eyebrow"></div><h2>Snapshot inspector</h2></div><span className={`status-pill ${snapshot.auditStatus}`}>{snapshot.auditStatus.replace("_", " ")}</span></div>
    <div className="snapshot-meta"><span>{snapshot.actionType}</span><span>{snapshot.agentRole}</span><span>#{snapshot.sequence} / {snapshot.runId}</span></div>
    <h3 className="snapshot-title">{snapshot.title}</h3><p className="snapshot-summary">{snapshot.summary}</p>
    <EvidenceHighlighter snapshot={snapshot} activeHighlightIds={highlightIds} />
    {snapshot.recordedJustification && <div className="detail-block"><h4>Agent reasoning</h4><p>{snapshot.recordedJustification}</p></div>}
    {snapshot.browserUrl && <div className="detail-block"><h4>Browser source</h4><p>{snapshot.browserUrl}</p><p>Tool call: {snapshot.toolCall ?? "none recorded"}</p><p>Actual response: {snapshot.toolResponse ?? "none recorded"}</p></div>}
    {finding && <div className="finding-inline"><div className="eyebrow">Audit finding · {finding.severity.toUpperCase()}</div><strong>{finding.explanation}</strong><p>{finding.suggestedAction}</p></div>}
    <div className="inspector-sections"><div><h4>Input</h4><KeyValues values={snapshot.observation.input} /></div><div><h4>Output</h4><KeyValues values={snapshot.observation.output} /></div></div>
    {snapshot.observation.changes?.length ? <div className="detail-block"><h4>Before and after</h4>{snapshot.observation.changes.map(change => <div className="change-row" key={change.field}><span>{change.field}</span><del>{change.before}</del><strong>{change.after}</strong></div>)}</div> : null}
    <div className="detail-block"><h4>Data access</h4><p>Read: {snapshot.readTargets.join(", ") || "none"}</p><p>Write: {snapshot.writeTargets.join(", ") || "none — proposal is not a write"}</p></div>
    {snapshot.observation.toolInteractions?.length ? <div className="detail-block"><h4>Tool interactions</h4>{snapshot.observation.toolInteractions.map((tool, index) => <p key={index}>{tool.tool}: {tool.request} → {tool.response}</p>)}</div> : null}
    <div className="detail-block"><h4>Source evidence</h4>{snapshot.evidence.map(item => <button type="button" id={`evidence-${item.id}`} className={`evidence-row evidence-button ${activeRefs.has(item.id) ? "voice-highlight" : ""}`} key={item.id} onClick={() => { setLocalHighlightIds((snapshot.annotations ?? []).filter(annotation => annotation.evidenceRef === item.id).map(annotation => annotation.id)); setManualOverride(true); }}><span>{item.label}</span><strong>{item.value ?? item.source}</strong><small>{item.source}{item.field ? ` · ${item.field}` : ""}</small></button>)}</div>
    <div className="provenance">Snapshot {snapshot.id} · Instructions {snapshot.instructionVersion} · Policy {snapshot.policyVersion}{snapshot.memoryRefs?.length ? ` · Memory ${snapshot.memoryRefs.join(", ")}` : ""}</div>
  </section>;
}
