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
    const generation = ++this.generation;
    if (autoAdvance && this.provider.continuous && explanation.segments.slice(fromIndex).map(s=>s.text).join(" ").length <= 8000) this.speakContinuous(generation);
    else this.speakCurrent(generation);
  }

  private speakContinuous(generation: number): void {
    const explanation = this.explanation!;
    const first = this.index;
    let offset = 0;
    const spans = explanation.segments.slice(first).map((segment, i) => {
      const span = {segment, index:first+i, start:offset};
      offset += segment.text.length + 1;
      return span;
    });
    const text = spans.map(span=>span.segment.text).join(" ");
    this.onSegment(spans[0].segment,first);
    this.onUpdate({status:"playing",explanationId:explanation.id,segmentIndex:first,caption:"",spokenCharIndex:-1});
    this.provider.speak(text, {
      onStart:()=>{
        if(generation!==this.generation)return;
        this.onSegment(spans[0].segment,first);
        this.onUpdate({status:this.status,explanationId:explanation.id,segmentIndex:first,caption:spans[0].segment.text,spokenCharIndex:-1});
      },
      onBoundary:charIndex=>{
        if(generation!==this.generation||this.status!=="playing")return;
        const span = [...spans].reverse().find(item=>charIndex>=item.start) ?? spans[0];
        if(this.index!==span.index){this.index=span.index;this.onSegment(span.segment,span.index);}
        this.onUpdate({status:"playing",explanationId:explanation.id,segmentIndex:this.index,caption:span.segment.text,spokenCharIndex:charIndex-span.start});
      },
      onEnd:()=>{
        if(generation!==this.generation||this.status!=="playing")return;
        if(this.awaitReply){this.status="awaiting_input";this.index=explanation.segments.length-1;this.onUpdate({status:this.status,explanationId:explanation.id,segmentIndex:this.index});}
        else this.finish();
      },
      onError:error=>{if(generation===this.generation){this.status="error";this.onUpdate({status:"error",explanationId:explanation.id,segmentIndex:this.index,error});}},
    });
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
