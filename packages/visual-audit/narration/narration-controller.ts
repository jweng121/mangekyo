import type { NarratedExplanation, NarrationSegment } from "@mangekyo/contracts";
import type { TtsProvider } from "./tts-provider";

export type PlaybackStatus = "idle" | "playing" | "paused" | "awaiting_input" | "unavailable" | "error";
export interface PlaybackUpdate { status: PlaybackStatus; explanationId?: string; segmentIndex?: number; error?: string; caption?: string; spokenCharIndex?: number }

export class NarrationController {
  private generation = 0;
  private explanation?: NarratedExplanation;
  private lastExplanation?: NarratedExplanation;
  private index = 0;
  private status: PlaybackStatus = "idle";
  private autoAdvance = true;
  private awaitReply = false;

  constructor(private provider: TtsProvider, private onUpdate: (update: PlaybackUpdate) => void, private onSegment: (segment?: NarrationSegment, index?: number) => void) {}

  play(explanation: NarratedExplanation, fromIndex = 0, autoAdvance = true, awaitReply = false): void {
    this.stop();
    this.lastExplanation = explanation;
    this.explanation = explanation;
    this.index = fromIndex;
    this.autoAdvance = autoAdvance;
    this.awaitReply = awaitReply;
    if (fromIndex < 0 || fromIndex >= explanation.segments.length) throw new Error("Invalid narration segment index.");
    if (!this.provider.isAvailable()) {
      this.status = "unavailable";
      this.onSegment(explanation.segments[fromIndex], fromIndex);
      this.onUpdate({ status: "unavailable", explanationId: explanation.id, segmentIndex: fromIndex });
      return;
    }
    this.status = "playing";
    this.speakCurrent(++this.generation);
  }

  private speakCurrent(generation: number): void {
    const explanation = this.explanation;
    if (!explanation || generation !== this.generation) return;
    const segment = explanation.segments[this.index];
    if (!segment) { this.finish(); return; }
    this.onSegment(segment, this.index);
    this.onUpdate({ status: "playing", explanationId: explanation.id, segmentIndex: this.index, caption: "", spokenCharIndex: -1 });
    this.provider.speak(segment.text, {
      onStart: () => {
        if (generation !== this.generation) return;
        // Replay the focus animation when buffered audio actually starts.
        this.onSegment(segment, this.index);
        this.onUpdate({ status: this.status, explanationId: explanation.id, segmentIndex: this.index, caption: segment.text, spokenCharIndex: -1 });
      },
      onBoundary: charIndex => {
        if (generation !== this.generation || this.status !== "playing") return;
        this.onUpdate({ status: this.status, explanationId: explanation.id, segmentIndex: this.index, caption: segment.text, spokenCharIndex: charIndex });
      },
      onEnd: () => {
        if (generation !== this.generation || this.status !== "playing") return;
        if (!this.autoAdvance || this.awaitReply && this.index === explanation.segments.length - 1) {
          this.status = "awaiting_input";
          this.onUpdate({ status: "awaiting_input", explanationId: explanation.id, segmentIndex: this.index, caption: segment.text, spokenCharIndex: segment.text.length });
          return;
        }
        this.index += 1;
        if (this.index >= explanation.segments.length) this.finish();
        else this.speakCurrent(generation);
      },
      onError: error => {
        if (generation !== this.generation) return;
        this.status = "error";
        this.onUpdate({ status: "error", explanationId: explanation.id, segmentIndex: this.index, error });
      },
    });
  }

  pause(): void { if (this.status === "playing") { this.provider.pause(); this.status = "paused"; this.onUpdate({ status: "paused", explanationId: this.explanation?.id, segmentIndex: this.index }); } }
  continue(): void { if (this.status !== "awaiting_input" || !this.explanation) return; this.index += 1; if (this.index >= this.explanation.segments.length) { this.finish(); return; } this.status = "playing"; this.speakCurrent(++this.generation); }
  resume(): void { if (this.status === "paused") { this.provider.resume(); this.status = "playing"; this.onUpdate({ status: "playing", explanationId: this.explanation?.id, segmentIndex: this.index }); } }
  replay(): void { if (this.lastExplanation) this.play(this.lastExplanation); }
  stop(): void { this.generation += 1; this.provider.stop(); this.status = "idle"; this.explanation = undefined; this.onUpdate({ status: "idle" }); this.onSegment(undefined); }
  private finish(): void { this.generation += 1; this.status = "idle"; this.explanation = undefined; this.onUpdate({ status: "idle" }); this.onSegment(undefined); }
}
