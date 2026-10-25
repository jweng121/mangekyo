"use client";
import type { NarratedExplanation } from "@mangekyo/contracts";
import type { PlaybackUpdate } from "../narration/narration-controller";

export function VoiceControls({ explanation, playback, available, onPlay, onPause, onResume, onStop, onReplay }: { explanation: NarratedExplanation; playback: PlaybackUpdate; available: boolean; onPlay: (explanation: NarratedExplanation) => void; onPause: () => void; onResume: () => void; onStop: () => void; onReplay: (explanation: NarratedExplanation) => void }) {
  const active = playback.explanationId === explanation.id;
  const status = active ? playback.status : "idle";
  return <div className="voice-controls" aria-label="Narration controls">
    {!available && <span className="voice-unavailable">Voice unavailable in this browser; evidence remains available below.</span>}
    <button type="button" onClick={() => onPlay(explanation)} disabled={!available || status === "playing" || status === "paused"}>Explain Aloud</button>
    {status === "playing" && <button type="button" onClick={onPause}>Pause</button>}
    {status === "paused" && <button type="button" onClick={onResume}>Resume</button>}
    {(status === "playing" || status === "paused") && <button type="button" onClick={onStop}>Stop</button>}
    <button type="button" onClick={() => onReplay(explanation)} disabled={!available}>Replay</button>
    {active && playback.error && <span role="status">Voice error: {playback.error}</span>}
  </div>;
}
