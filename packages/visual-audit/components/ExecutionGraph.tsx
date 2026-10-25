"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, Snapshot } from "@mangekyo/contracts";
import { buildExecutionGraph } from "../graph/execution-graph";

type View = "execution" | "workflow";
type Node = { id: string; label: string; subtitle: string; summary: string; agent: string; branch: string; flagged: boolean; screenshot: boolean; x: number; y: number; count?: number };
type Edge = { source: string; target: string };

function layout(events: AgentEvent[], snapshots: Snapshot[], view: View): { nodes: Node[]; edges: Edge[]; width: number; height: number } {
  const graph = buildExecutionGraph(events);
  if (view === "workflow") {
    const groups = new Map<string, AgentEvent[]>();
    for (const event of events) {
      const key = `${event.branchId}:${event.agentRole}`;
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    const entries = [...groups.entries()];
    const nodes = entries.map(([key, group], index) => ({ id: group[0].id, label: group[0].agentRole, subtitle: `${group.length} checkpoint${group.length === 1 ? "" : "s"} · ${group[group.length - 1].actionType}`, summary: group[group.length - 1].summary, agent: group[0].agentRole, branch: group[0].branchId, flagged: group.some(event => snapshots.find(snapshot => snapshot.id === event.snapshotId)?.auditStatus === "flagged"), screenshot: false, x: 30 + (index % 3) * 240, y: 30 + Math.floor(index / 3) * 130, count: group.length }));
    const groupFor = new Map(events.map(event => [event.id, `${event.branchId}:${event.agentRole}`]));
    const nodeFor = new Map(entries.map(([key, group]) => [key, group[0].id]));
    const seen = new Set<string>();
    const edges = graph.edges.flatMap(edge => {
      const source = nodeFor.get(groupFor.get(edge.source) ?? "");
      const target = nodeFor.get(groupFor.get(edge.target) ?? "");
      if (!source || !target || source === target || seen.has(`${source}:${target}`)) return [];
      seen.add(`${source}:${target}`);
      return [{ source, target }];
    });
    return { nodes, edges, width: 750, height: Math.max(340, Math.ceil(nodes.length / 3) * 130 + 60) };
  }
  const byId = new Map(events.map(event => [event.id, event]));
  const depthCache = new Map<string, number>();
  const depth = (event: AgentEvent): number => {
    if (depthCache.has(event.id)) return depthCache.get(event.id)!;
    const value = event.parentEventIds.length ? 1 + Math.max(...event.parentEventIds.map(parent => byId.has(parent) ? depth(byId.get(parent)!) : 0)) : 0;
    depthCache.set(event.id, value);
    return value;
  };
  const rows = new Map<number, number>();
  const nodes = events.map(event => {
    const level = depth(event);
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    const snapshot = snapshots.find(item => item.id === event.snapshotId);
    return { id: event.id, label: event.title, subtitle: `${event.actionType.replaceAll("_", " ").toLowerCase()} · ${event.agentRole}`, summary: event.summary, agent: event.agentRole, branch: event.branchId, flagged: snapshot?.auditStatus === "flagged" || snapshot?.auditStatus === "needs_review", screenshot: !!snapshot?.screenshot, x: 30 + level * 238, y: 34 + row * 140 };
  });
  return { nodes, edges: graph.edges, width: Math.max(750, 120 + (Math.max(0, ...nodes.map(node => Math.floor((node.x - 30) / 238))) + 1) * 238), height: Math.max(360, 160 + Math.max(0, ...nodes.map(node => node.y))) };
}

export function ExecutionGraph({ events, snapshots, selectedId, onSelect, view, onViewChange }: { events: AgentEvent[]; snapshots: Snapshot[]; selectedId?: string; onSelect: (eventId: string) => void; view: View; onViewChange: (view: View) => void }) {
  const [zoom, setZoom] = useState(1);
  const scroll = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const { nodes, edges, width, height } = useMemo(() => layout(events, snapshots, view), [events, snapshots, view]);
  const positions = new Map(nodes.map(node => [node.id, node]));
  useEffect(() => {
    const node = positions.get(selectedId ?? "");
    if (!node || !scroll.current) return;
    scroll.current.scrollTo({ left: Math.max(0, node.x * zoom - scroll.current.clientWidth / 3), top: Math.max(0, node.y * zoom - scroll.current.clientHeight / 3), behavior: "smooth" });
  }, [selectedId, nodes, zoom]);
  return <section className="panel graph-panel" aria-label="Execution graph">
    <div className="panel-head"><div><div className="eyebrow"></div><h2>Execution graph</h2></div><span className="count">{events.length} events</span></div>
    <div className="graph-toolbar"><div className="segmented"><button className={view === "execution" ? "active" : ""} onClick={() => onViewChange("execution")}>Execution</button><button className={view === "workflow" ? "active" : ""} onClick={() => onViewChange("workflow")}>Workflow</button></div><div className="zoom"><button onClick={() => setZoom(value => Math.max(.65, +(value - .15).toFixed(2)))} aria-label="Zoom out">−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(value => Math.min(1.75, +(value + .15).toFixed(2)))} aria-label="Zoom in">+</button></div></div>
    <div className="graph-viewport" ref={scroll} onPointerDown={event => { if ((event.target as HTMLElement).closest("button")) return; dragging.current = { x: event.clientX, y: event.clientY, left: scroll.current?.scrollLeft ?? 0, top: scroll.current?.scrollTop ?? 0 }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!dragging.current || !scroll.current) return; scroll.current.scrollLeft = dragging.current.left - (event.clientX - dragging.current.x); scroll.current.scrollTop = dragging.current.top - (event.clientY - dragging.current.y); }} onPointerUp={() => { dragging.current = null; }}>
      <div className="graph-canvas" style={{ width: width * zoom, height: height * zoom }}>
        <div className="graph-content" style={{ width, height, transform: `scale(${zoom})` }}>
          <svg className="graph-lines" width={width} height={height} aria-hidden="true"><defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" fill="none" stroke="#657890" /></marker></defs>{edges.map(edge => { const a = positions.get(edge.source); const b = positions.get(edge.target); return a && b ? <path key={`${edge.source}-${edge.target}`} d={`M ${a.x + 190} ${a.y + 41} C ${a.x + 213} ${a.y + 41}, ${b.x - 24} ${b.y + 41}, ${b.x - 5} ${b.y + 41}`} fill="none" stroke="#52657d" strokeWidth="1.5" markerEnd="url(#arrow)" /> : null; })}</svg>
          {nodes.map(node => <button key={node.id} className={`graph-node ${node.flagged ? "flagged" : ""} ${selectedId === node.id ? "selected" : ""}`} style={{ left: node.x, top: node.y }} onClick={() => onSelect(node.id)} title={`${node.agent}: ${node.summary}`}><span className="node-top"><span className={`node-dot ${node.branch}`} />{node.branch === "original" ? "Original" : node.branch === "future" ? "Future run" : "Corrected"}{node.flagged && <span className="node-alert">!</span>}</span><strong>{node.label}</strong><small>{node.subtitle}</small><span className="node-summary">{node.summary}</span><span className="node-foot">{node.screenshot ? "Screenshot" : "Recorded observation"} ↗</span></button>)}
        </div>
      </div>
    </div>
    <div className="graph-legend"><span><i className="legend-dot cyan" /> Original</span><span><i className="legend-dot violet" /> Corrected</span><span><i className="legend-dot green" /> Future</span><span><i className="legend-dot amber" /> Flagged</span></div>
  </section>;
}
