"use client";

import { useState } from "react";
import type { AgentEvent, AuditFinding, ChatMessage, NarratedExplanation as Explanation, Snapshot } from "@mangekyo/contracts";
import { answerMockQuestion } from "../chat/mock-chat";
import type { PlaybackUpdate } from "../narration/narration-controller";
import { buildPlainExplanation } from "../narration/evidence-segments";
import { NarratedExplanation } from "./NarratedExplanation";
import { VoiceControls } from "./VoiceControls";

interface Props {
  selected?: Snapshot;
  snapshots: Snapshot[];
  events: AgentEvent[];
  findings: AuditFinding[];
  messages: ChatMessage[];
  onMessages: (messages: ChatMessage[]) => void;
  onSteer: () => void;
  playback: PlaybackUpdate;
  voiceAvailable: boolean;
  activeNarration?: { explanationId: string; segmentIndex: number };
  onPlay: (explanation: Explanation) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onReplay: (explanation: Explanation) => void;
  onSelectSegment: (explanation: Explanation, index: number) => void;
}

export function AgentChat({ selected, snapshots, events, findings, messages, onMessages, onSteer, playback, voiceAvailable, activeNarration, onPlay, onPause, onResume, onStop, onReplay, onSelectSegment }: Props) {
  const [draft, setDraft] = useState("");
  const submit = (question: string) => {
    if (!question.trim()) return;
    const now = new Date().toISOString();
    const user: ChatMessage = { id: crypto.randomUUID(), role: "user", text: question.trim(), snapshotId: selected?.id, timestamp: now };
    const answer: ChatMessage = { id: crypto.randomUUID(), role: "assistant", text: answerMockQuestion(question, selected, events, findings), snapshotId: selected?.id, timestamp: now };
    answer.narration = buildPlainExplanation(answer);
    onMessages([...messages, user, answer]); setDraft("");
  };
  return <section className="panel chat-panel" aria-label="Mangekyo chat">
    <div className="panel-head"><div><div className="eyebrow">03 / INVESTIGATE</div><h2>Ask Mangekyo</h2></div><span className="mock-label">MOCK</span></div>
    <div className="chat-context"><small>ACTIVE CHECKPOINT</small><strong>{selected ? `${selected.actionType} · ${selected.title}` : "No checkpoint selected"}</strong><span>{selected?.agentRole ?? "Start a run"}</span></div>
    <div className="chat-history" aria-live="polite">{messages.length === 0 ? <div className="chat-intro"><div className="chat-avatar">◈</div><strong>Trace the reasoning.</strong><p>Ask about what an agent read, why it made a proposal, or how branches differ. Responses come from recorded synthetic evidence.</p></div> : messages.map(message => <div key={message.id} className={`chat-message ${message.role}`}><small>{message.role === "assistant" ? "MANGEKYO · MOCK" : "YOU"}{message.snapshotId ? ` · ${message.snapshotId.replace("snapshot-", "")}` : ""}</small><p>{message.text}</p>{message.role === "assistant" && message.narration && <><VoiceControls explanation={message.narration} playback={playback} available={voiceAvailable} onPlay={onPlay} onPause={onPause} onResume={onResume} onStop={onStop} onReplay={onReplay} />{message.narration.segments.some(segment => segment.snapshotId) && <NarratedExplanation explanation={message.narration} snapshots={snapshots} activeSegmentIndex={activeNarration?.explanationId === message.narration.id ? activeNarration.segmentIndex : undefined} onSelect={index => onSelectSegment(message.narration!, index)} />}</>}</div>)}</div>
    <div className="suggestions">{["What did it read?", "Why did they disagree?", "What changed between branches?"].map(question => <button key={question} onClick={() => submit(question)}>{question}</button>)}</div>
    <form className="chat-compose" onSubmit={event => { event.preventDefault(); submit(draft); }}><input aria-label="Ask Mangekyo" value={draft} onChange={event => setDraft(event.target.value)} placeholder="Ask about this checkpoint…" /><button type="submit" aria-label="Send message">↗</button></form>
    <button className="steer-action" onClick={onSteer} disabled={selected?.id !== "snapshot-original-maker"}>↳ Steer Agent from checkpoint</button><p className="chat-disclaimer">Narration and chat are read-only. Corrections require the separate steering control.</p>
  </section>;
}
