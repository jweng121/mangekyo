import type { TtsProvider } from "./tts-provider";

export class BrowserTtsProvider implements TtsProvider {
  private current?: SpeechSynthesisUtterance;
  isAvailable(): boolean { return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window; }
  speak(text: string, callbacks: { onEnd: () => void; onError: (error: string) => void; onStart?: () => void; onBoundary?: (charIndex: number) => void }): void {
    if (!this.isAvailable()) { callbacks.onError("Browser speech synthesis is unavailable."); return; }
    this.stop();
    const utterance = new SpeechSynthesisUtterance(text);
    this.current = utterance;
    utterance.rate = 1;
    utterance.onstart = () => { if (this.current === utterance) { callbacks.onStart?.(); callbacks.onBoundary?.(0); } };
    utterance.onboundary = event => { if (this.current === utterance) callbacks.onBoundary?.(event.charIndex); };
    utterance.onend = () => { if (this.current !== utterance) return; this.current = undefined; callbacks.onEnd(); };
    utterance.onerror = event => { if (this.current !== utterance) return; this.current = undefined; callbacks.onError(event.error); };
    window.speechSynthesis.speak(utterance);
  }
  pause(): void { if (this.isAvailable()) window.speechSynthesis.pause(); }
  resume(): void { if (this.isAvailable()) window.speechSynthesis.resume(); }
  stop(): void { if (this.current) { this.current.onend = null; this.current.onerror = null; this.current = undefined; } if (this.isAvailable()) window.speechSynthesis.cancel(); }
}
