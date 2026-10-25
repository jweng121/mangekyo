"use client";

import { MangekyoAvatar } from "./MangekyoAvatar";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, ChatMessage, MemoryEntry, MemoryProposal, NarratedExplanation, NarrationSegment, Snapshot, SteeringRequest } from "@mangekyo/contracts";
import { createDemoStream, DATA_CONTEXT, ORGANIZATION_ID, TASK_TYPE } from "../adapters/mock-events";
import { simulateFutureRun } from "../adapters/future-run";
import { runMockAudit } from "../auditor/mock-auditor";
import { selectSnapshot } from "../chat/chat-context";
import { ingestEvent } from "../graph/execution-graph";
import { approveMemory, proposeMemory, readStoredMemories, readStoredProposal, retrieveApprovedMemory, reviseMemory, writeStoredMemories, writeStoredProposal } from "../memory/memory-store";
import { BrowserTtsProvider } from "../narration/browser-tts";
import { buildIssueExplanation } from "../narration/evidence-segments";
import { NarrationController, type PlaybackUpdate } from "../narration/narration-controller";
import { simulateSteering, type SimulatedCorrection } from "../steering/steering-manager";
import { AgentChat } from "./AgentChat";
import { BranchComparison } from "./BranchComparison";
import { ExecutionGraph } from "./ExecutionGraph";
import { MemoryPanel } from "./MemoryPanel";
import { SnapshotInspector } from "./SnapshotInspector";
import { SteeringPanel } from "./SteeringPanel";

type Queued = { event: AgentEvent; snapshot: Snapshot };

export function MangekyoWorkspace() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [view, setView] = useState<"execution" | "workflow">("execution");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [steeringOpen, setSteeringOpen] = useState(false);
  const [steeringError, setSteeringError] = useState<string>();
  const [correction, setCorrection] = useState<SimulatedCorrection>();
  const [proposal, setProposal] = useState<MemoryProposal>();
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [memoryLoaded, setMemoryLoaded] = useState(false);
  const [futureRunStarted, setFutureRunStarted] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [playback, setPlayback] = useState<PlaybackUpdate>({ status: "idle" });
  const [activeNarration, setActiveNarration] = useState<{ explanationId: string; segmentIndex: number }>();
  const [activeHighlightIds, setActiveHighlightIds] = useState<string[]>([]);
  const narrationIdRef = useRef<string | undefined>(undefined);
  const controllerRef = useRef<NarrationController | null>(null);
  if (!controllerRef.current) controllerRef.current = new NarrationController(new BrowserTtsProvider(), setPlayback, (segment?: NarrationSegment, index?: number) => {
    if (!segment) { setActiveHighlightIds([]); setActiveNarration(undefined); return; }
    if (segment.snapshotId) setSelectedEventId(segment.snapshotId.replace(/^snapshot-/, ""));
    setActiveHighlightIds(segment.highlightIds);
    setActiveNarration({ explanationId: narrationIdRef.current ?? "", segmentIndex: index ?? 0 });
    setView("execution");
  });

  useEffect(() => { setVoiceAvailable(new BrowserTtsProvider().isAvailable()); return () => controllerRef.current?.stop(); }, []);
  useEffect(() => { setMemories(readStoredMemories(window.localStorage)); setProposal(readStoredProposal(window.localStorage)); setMemoryLoaded(true); }, []);
  useEffect(() => { if (memoryLoaded) writeStoredMemories(window.localStorage, memories); }, [memories, memoryLoaded]);
  useEffect(() => { if (memoryLoaded) writeStoredProposal(window.localStorage, proposal); }, [proposal, memoryLoaded]);
  useEffect(() => {
    if (!queue.length) return;
    const timer = window.setTimeout(() => {
      const next = queue[0];
      setEvents(current => ingestEvent(current, next.event));
      setSnapshots(current => current.some(snapshot => snapshot.id === next.snapshot.id) ? current : [...current, next.snapshot]);
      setSelectedEventId(current => current ?? next.event.id);
      setQueue(current => current.slice(1));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [queue]);

  const selected = useMemo(() => selectedEventId ? selectSnapshot(selectedEventId, events, snapshots) : undefined, [selectedEventId, events, snapshots]);
  const audit = useMemo(() => runMockAudit({ runId: "run-original", throughSequence: Math.max(0, ...events.filter(event => event.runId === "run-original").map(event => event.sequence)) }, events, snapshots), [events, snapshots]);
  const finding = audit.findings.find(item => item.snapshotId === selected?.id);
  const escalation = audit.findings[0];
  const start = () => { controllerRef.current?.stop(); const stream = createDemoStream(); setEvents([]); setSnapshots([]); setSelectedEventId(undefined); setMessages([]); setCorrection(undefined); setProposal(undefined); setFutureRunStarted(false); setQueue(stream.events.map((event, index) => ({ event, snapshot: stream.snapshots[index] }))); };
  const openEscalation = () => { if (!escalation) return; setSelectedEventId("original-maker"); setView("execution"); };
  const playExplanation = (explanation: NarratedExplanation) => { narrationIdRef.current = explanation.id; controllerRef.current?.play(explanation); };
  const selectNarrationSegment = (explanation: NarratedExplanation, index: number) => {
    controllerRef.current?.stop();
    const segment = explanation.segments[index];
    if (!segment) return;
    narrationIdRef.current = explanation.id;
    if (segment.snapshotId) setSelectedEventId(segment.snapshotId.replace(/^snapshot-/, ""));
    setActiveHighlightIds(segment.highlightIds);
    setActiveNarration({ explanationId: explanation.id, segmentIndex: index });
    setView("execution");
  };
  const explainIssue = () => {
    if (!escalation) return;
    setSelectedEventId("original-maker");
    setView("execution");
    const prior = messages.find(message => message.narration?.id === `explanation-${escalation.id}`);
    if (prior?.narration) { playExplanation(prior.narration); return; }
    const messageId = crypto.randomUUID();
    const narration = buildIssueExplanation(messageId, escalation, snapshots);
    const message: ChatMessage = { id: messageId, role: "assistant", text: `${escalation.explanation} The following recorded checkpoints show how the conflict arose. No financial write was made.`, snapshotId: escalation.snapshotId, timestamp: new Date().toISOString(), narration };
    setMessages(current => [...current, message]);
    playExplanation(narration);
  };
  const openSteering = () => { if (!escalation) return; setSelectedEventId("original-maker"); setSteeringError(undefined); setSteeringOpen(true); };
  const submitSteering = (instruction: string, scope: SteeringRequest["scope"]) => {
    const checkpoint = snapshots.find(snapshot => snapshot.id === "snapshot-original-maker");
    if (!checkpoint) return;
    try {
      const result = simulateSteering(checkpoint, instruction, "demo-reviewer", scope);
      setCorrection(result);
      setQueue(result.events.map((event, index) => ({ event, snapshot: result.snapshots[index] })));
      setSteeringOpen(false);
      setView("execution");
    } catch (error) { setSteeringError(error instanceof Error ? error.message : "Steering failed."); }
  };
  const propose = () => { const source = snapshots.find(snapshot => snapshot.id === "snapshot-original-maker"); if (correction && source) setProposal(proposeMemory(correction.steering, source)); };
  const approve = () => { if (!proposal) return; setMemories(current => [...current.filter(entry => entry.id !== proposal.id).map(entry => entry.id === proposal.supersedesId ? { ...entry, status: "superseded" as const } : entry), approveMemory(proposal, "demo-reviewer", new Date().toISOString())]); setProposal(undefined); };
  const reject = () => { if (!proposal) return; setMemories(current => [...current.filter(entry => entry.id !== proposal.id), { ...proposal, status: "rejected" }]); setProposal(undefined); };
  const startFuture = () => {
    const applicable = retrieveApprovedMemory(memories, { organizationId: ORGANIZATION_ID, agentRole: "Matching Maker", taskType: TASK_TYPE, dataContext: DATA_CONTEXT });
    if (!applicable.entries.length) return;
    const stream = simulateFutureRun(memories);
    setFutureRunStarted(true);
    setQueue(stream.events.map((event, index) => ({ event, snapshot: stream.snapshots[index] })));
    setView("execution");
  };

  return <div className="workspace"><header className="topbar"><div className="brand"><MangekyoAvatar size={32}/><div><strong>Mangekyo</strong><small>Visual audit</small></div></div><div className="topbar-center"><span className="pulse" /> LOCAL SIMULATION <span className="topbar-sep">/</span> HARBOR TRUST DEMO</div><div className="topbar-right"><span className="run-badge">{events.length ? `RUN · ${events.some(event => event.runId === "run-future") ? "FUTURE" : "ORIGINAL"}` : "No active run"}</span><span className="avatar">DR</span></div></header>
    <main className="main"><div className="intro"><div><div className="eyebrow">WORKSPACE / OBSERVABILITY</div><h1>See every decision.<br /><em>Trace every correction.</em></h1><p>Inspect synthetic agent execution, resolve a conflicting deposit, and test approved memory in a second run.</p></div><button className="primary start-button" onClick={start} disabled={queue.length > 0}>{queue.length ? `Running · ${queue.length} pending` : events.length ? "Replay synthetic workflow ↗" : "Start synthetic workflow ↗"}</button></div>
    <div className="metrics"><div><small>Checkpoints</small><strong>{events.length.toString().padStart(2, "0")}</strong><span>committed in view</span></div><div><small>Agents</small><strong>{new Set(events.map(event => event.agentId)).size.toString().padStart(2, "0")}</strong><span>observed roles</span></div><div><small>Findings</small><strong>{audit.findings.length.toString().padStart(2, "0")}</strong><span>deterministic audit</span></div><div><small>Branches</small><strong>{(correction ? 2 : 1).toString().padStart(2, "0")}</strong><span>original + corrected</span></div></div>
    {escalation && <div className="escalation-bar"><button className="escalation-banner" onClick={openEscalation}><span className="escalation-icon">!</span><span><strong>Human review required · Ownership conflict</strong><small>Maker proposed Client A while independent checker found Client B. Open the flagged checkpoint and evidence.</small></span><span className="escalation-arrow">Inspect finding ↗</span></button><button className="explain-issue-button" onClick={explainIssue}>◈ Explain Issue</button></div>}
    <div className="work-grid"><ExecutionGraph events={events} snapshots={snapshots} selectedId={selectedEventId} onSelect={eventId => { controllerRef.current?.stop(); setSelectedEventId(eventId); }} view={view} onViewChange={setView} /><SnapshotInspector snapshot={selected} finding={finding} activeHighlightIds={activeHighlightIds} /><AgentChat selected={selected} snapshots={snapshots} events={events} findings={audit.findings} messages={messages} onMessages={setMessages} onSteer={openSteering} playback={playback} voiceAvailable={voiceAvailable} activeNarration={activeNarration} onPlay={playExplanation} onPause={() => controllerRef.current?.pause()} onResume={() => controllerRef.current?.resume()} onStop={() => controllerRef.current?.stop()} onReplay={playExplanation} onSelectSegment={selectNarrationSegment} /></div>
    {correction && events.some(event => event.id === "corrected-validated") && <BranchComparison branch={correction.branch} steering={correction.steering} />}
    <MemoryPanel entries={memories} proposal={proposal} onPropose={propose} onEdit={content => setProposal(current => current ? { ...current, content } : current)} onRevise={entry => setProposal(reviseMemory(entry, "demo-reviewer", new Date().toISOString()))} onApprove={approve} onReject={reject} onFutureRun={startFuture} hasCorrection={!!correction && events.some(event => event.id === "corrected-validated")} futureRunStarted={futureRunStarted} />
    <footer className="footer"><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MangekyoAvatar size={18}/> MANGEKYO / PHASE 1</span><span>All events, audits, corrections, and future behavior are synthetic. No financial integration or transaction execution.</span></footer></main>
    {steeringOpen && <SteeringPanel snapshot={snapshots.find(snapshot => snapshot.id === "snapshot-original-maker")!} onSubmit={submitSteering} onClose={() => setSteeringOpen(false)} error={steeringError} />}
  </div>;
}
