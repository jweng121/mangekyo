"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { Snapshot } from "@mangekyo/contracts";

const shortTitle = (snapshot: Snapshot) => {
  const titles: Record<string, string> = { "Bank payment reference": "Bank", "Invoice payer": "Invoice", "Trust funding instruction": "Funding", "Payment code owner": "Client read", "Owner allocation proposal": "Proposal", "Draft proposal result": "Draft saved", "Conflicting evidence": "Audit" };
  return titles[snapshot.title] ?? (snapshot.actionType === "ESCALATE" ? "Human review" : snapshot.title);
};

export function SnapshotBranchGraph({ original, corrected, selectedId, conflictId, onSelect, branchControl }: {
  original: Snapshot[]; corrected: Snapshot[]; selectedId?: string; conflictId?: string; onSelect: (snapshot: Snapshot) => void; branchControl?: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const gap = 88;
  // Reserve half the widest label plus breathing room at both scroll edges.
  const inset = 48;
  const conflictIndex = Math.max(0, original.findIndex(item => item.id === conflictId));
  const fork = inset + conflictIndex * gap;
  const branchStart = fork + 44;
  const width = Math.max(480, inset * 2 + (original.length - 1) * gap, branchStart + Math.max(0, corrected.length - 1) * gap + inset);
  useEffect(() => {
    if (!selected.current || !scroll.current) return;
    const node = selected.current;
    const viewport = scroll.current;
    if (node.offsetLeft < viewport.scrollLeft || node.offsetLeft + node.offsetWidth > viewport.scrollLeft + viewport.clientWidth) viewport.scrollTo({ left: Math.max(0, node.offsetLeft - viewport.clientWidth / 2), behavior: "smooth" });
  }, [selectedId]);
  const node = (snapshot: Snapshot, index: number, isCorrected: boolean) => {
    const active = snapshot.id === selectedId;
    const flagged = snapshot.id === conflictId || snapshot.auditStatus === "flagged" || snapshot.auditStatus === "needs_review" || snapshot.actionType === "ESCALATE";
    const completed = !flagged && snapshot.executionStatus === "completed";
    return <button key={snapshot.id} ref={active ? selected : undefined} className={`history-node ${active ? "selected" : ""} ${flagged ? "conflict" : completed ? "completed" : "pending"} ${isCorrected ? "corrected" : ""}`} style={{ left: (isCorrected ? branchStart : inset) + index * gap - 36, top: isCorrected ? 51 : 19 }} onClick={() => onSelect(snapshot)} aria-label={`${isCorrected ? "Corrected " : ""}Snapshot ${snapshot.sequence}: ${snapshot.title}`} aria-current={active ? "true" : undefined} title={`${flagged ? "Flagged checkpoint" : completed ? "Completed checkpoint" : "Pending checkpoint"}: ${isCorrected ? "Corrected branch · " : ""}Snapshot ${snapshot.sequence}: ${snapshot.title}`}><span className="history-dot" aria-hidden="true">{flagged ? <svg viewBox="0 0 16 16"><path d="M8 4v5"/><circle cx="8" cy="12" r=".7" fill="currentColor" stroke="none"/></svg> : completed ? <svg viewBox="0 0 16 16"><path d="m4 8 3 3 5-6"/></svg> : null}</span><span className="history-node-label">{shortTitle(snapshot)}</span></button>;
  };
  return <section className={`snapshot-history ${corrected.length ? "has-branch" : ""}`} aria-label="Snapshot history">
    {branchControl && <div className="history-branch-picker">{branchControl}</div>}
    <div className="history-scroll" ref={scroll}><div className="history-track" style={{ width, height: corrected.length ? 96 : 52 }}>
      <svg width={width} height={corrected.length ? 96 : 52} aria-hidden="true">
        <path className="history-trunk" d={`M${inset} 30 H${inset + Math.max(0, original.length - 1) * gap}`}/>
        {corrected.length > 0 && <path className="history-fork" d={`M${fork} 30 C${fork} 48 ${branchStart} 44 ${branchStart} 62 H${branchStart + (corrected.length - 1) * gap}`}/>} 
      </svg>
      {original.map((item, index) => node(item, index, false))}{corrected.map((item, index) => node(item, index, true))}
    </div></div>
  </section>;
}
