"use client";

import { useEffect, useState } from "react";
import type { MemoryEntry, MemoryProposal } from "@mangekyo/contracts";

interface Props {
  entries: MemoryEntry[];
  proposal?: MemoryProposal;
  hasCorrection: boolean;
  futureRunStarted: boolean;
  onPropose: () => void;
  onEdit: (content: string) => void;
  onRevise: (entry: MemoryEntry) => void;
  onApprove: () => void;
  onReject: () => void;
  onFutureRun: () => void;
}

export function MemoryPanel({ entries, proposal, onPropose, onEdit, onRevise, onApprove, onReject, onFutureRun, hasCorrection, futureRunStarted }: Props) {
  const [draft, setDraft] = useState(proposal?.content ?? "");
  useEffect(() => { setDraft(proposal?.content ?? ""); }, [proposal?.id]);
  const approved = entries.filter(entry => entry.status === "approved");
  return <section className="memory-panel">
    <div className="memory-heading"><div><div className="eyebrow">04 / REMEMBER</div><h2>Agent memory</h2><p>Validated guidance for future runs. Approval is separate from steering.</p></div><span className="count">{approved.length} active</span></div>
    {hasCorrection && !proposal && !entries.some(entry => entry.sourceCorrectionId === "steering-1042") && <button className="primary" onClick={onPropose}>Save Lesson to Memory ↗</button>}
    {proposal && <div className="memory-card pending"><small>PENDING REVIEW · v{proposal.version}</small><h3>{proposal.title}</h3><label className="field-label" htmlFor="memory-draft">Review lesson</label><textarea id="memory-draft" value={draft} onChange={event => { setDraft(event.target.value); onEdit(event.target.value); }} rows={3} /><div className="memory-facts"><span>Agent: {proposal.agentRole}</span><span>Scope: {proposal.organizationId} / {proposal.taskType}</span><span>Source: {proposal.sourceSnapshotId}</span></div><div className="memory-actions"><button className="primary" disabled={!draft.trim()} onClick={onApprove}>Approve lesson</button><button className="secondary" onClick={onReject}>Reject</button></div></div>}
    {entries.map(entry => <div className="memory-card" key={entry.id}><small>{entry.status.toUpperCase()} · v{entry.version} · {entry.type}</small><h3>{entry.title}</h3><p>{entry.content}</p><div className="memory-facts"><span>{entry.agentRole}</span><span>{entry.organizationId} / {entry.taskType}</span><span>Source correction: {entry.sourceCorrectionId}</span><span>Reviewer: {entry.approvedBy ?? "none"}</span>{entry.supersedesId && <span>Previous version: {entry.supersedesId}</span>}</div>{entry.status === "approved" && !proposal && <button className="secondary revise-button" onClick={() => onRevise(entry)}>Propose revision</button>}</div>)}
    {approved.length > 0 && <button className="primary future-button" onClick={onFutureRun} disabled={futureRunStarted}>{futureRunStarted ? "Second run started" : "Start second synthetic run ↗"}</button>}
    {entries.length === 0 && !proposal && <p className="muted">A corrected branch can produce a scoped memory proposal.</p>}
    <p className="memory-note">Approved memory is guidance only. It cannot change policy, permissions, or completed financial actions.</p>
  </section>;
}
