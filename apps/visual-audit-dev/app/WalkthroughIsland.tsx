"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, X, Mic, Square } from "lucide-react";
import { currentCaption, MangekyoAvatar } from "@mangekyo/visual-audit";
import type { NarratedExplanation, Snapshot } from "../../../packages/contracts";
import { IconButton } from "./ReviewControls";

export function WalkthroughIsland({ title, thinking, autoSend, listening, speaking, levels, reply, inputError, speechSupported, onListen, error, open, status, available, explanation, index, snapshots, annotationNumbers, caption, spokenCharIndex, onStart, onPause, onResume, onClose, onSeek, onContinue }: {
  title?: string; thinking: boolean; autoSend: boolean; listening: boolean; speaking: boolean; levels: number[]; reply: string; inputError: string; speechSupported: boolean; onListen: () => void;
  error?: string; caption: string; spokenCharIndex: number;
  open: boolean; status: string; available: boolean; explanation?: NarratedExplanation; index: number; snapshots: Snapshot[]; annotationNumbers: Record<string, number>;
  onContinue: () => void; onStart: () => void; onPause: () => void; onResume: () => void; onClose: () => void; onSeek: (index: number) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expandedHeight, setExpandedHeight] = useState(76);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => setExpandedHeight(content.offsetHeight + 2));
    observer.observe(content);
    return () => observer.disconnect();
  }, [explanation?.segments.length]);
  const segment = explanation?.segments[index];
  const snapshot = snapshots.find(item => item.id === segment?.snapshotId);
  const annotation = snapshot?.annotations?.find(item => segment?.highlightIds.includes(item.id));
  if (!explanation?.segments.length) return null;
  const unavailable = !available || status === "unavailable" || status === "error";
  const text = unavailable ? segment?.text ?? "" : caption;
  const phrase = currentCaption(text, spokenCharIndex);
  const conversation = thinking || status === "paused" || status === "awaiting_input";
  return <div className={`walkthrough-layer ${open ? "is-open" : ""}`}>

    <section className={`walkthrough-island ${open ? "expanded" : ""}`} aria-label="Evidence walkthrough" style={{ height: open ? expandedHeight : 38 }}>
      <button className="walkthrough-anchor" onClick={onStart} tabIndex={open ? -1 : 0} aria-hidden={open} aria-label="Start walkthrough" title="Start the analysis with Mangekyo"><MangekyoAvatar size={32}/></button>
      <div ref={contentRef} className="walkthrough-content" aria-hidden={!open} inert={!open}>
        <div className="walkthrough-callout">{!title && <span className="annotation-number">{annotation ? annotationNumbers[annotation.id] : index + 1}</span>}<strong>{title ?? annotation?.label ?? snapshot?.title}</strong></div>
        <div className="walkthrough-caption" aria-label="Live captions" aria-live="off">
          {conversation ? <div className="island-conversation">
            <div className="island-listening-row"><span className={`operator-waveform ${listening && speaking ? "speaking" : ""}`} aria-hidden="true">{levels.map((level, i) => <i key={i} style={{ height: 26, transform: `scaleY(${listening ? level : .12})` }}/>)}</span><span role="status">{thinking ? "Thinking" : listening ? speaking ? "You're speaking" : "Listening" : reply ? "Reply ready" : "Your turn"}</span></div>
            <small>{inputError || (thinking ? "Preparing your answer" : reply ? `${reply.split(/\s+/).slice(-12).join(" ")} / ${autoSend ? "Sends when you finish" : "Review and send in chat"}` : listening ? "Ask your question" : "Speak or type in chat")}</small>
          </div> : <>{text ? <span className="caption-phrase">{phrase || "\u00a0"}</span> : <span className="caption-waiting">Preparing audio...</span>}{unavailable && <small role="status">{error || "Audio unavailable"}</small>}</>}

        </div>
        <div className="walkthrough-controls">
          {conversation && <IconButton label={listening ? "Stop voice reply" : "Reply by voice"} disabled={!speechSupported} onClick={onListen}>{listening ? <Square size={15}/> : <Mic size={15}/>}</IconButton>}
          {status === "awaiting_input" ? index < explanation.segments.length - 1 ? <button className="walkthrough-continue" onClick={onContinue}>Continue</button> : null : <IconButton label={status === "playing" ? "Pause walkthrough" : status === "paused" ? "Resume walkthrough" : "Replay walkthrough"} onClick={status === "playing" ? onPause : status === "paused" ? onResume : onStart}>{status === "playing" ? <Pause size={16}/> : <Play size={16}/>}</IconButton>}
          <IconButton label="Close walkthrough" onClick={onClose}><X size={16}/></IconButton>
        </div>
      </div>
    </section>
  </div>;
}
