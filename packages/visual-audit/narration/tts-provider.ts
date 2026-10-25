export interface TtsProvider {
  /** Provider supplies word boundaries for one continuous multi-snapshot track. */
  readonly continuous?: boolean;
  isAvailable(): boolean;
  speak(text: string, callbacks: { onEnd: () => void; onError: (error: string) => void; onStart?: () => void; onBoundary?: (charIndex: number) => void }): void;
  pause(): void;
  resume(): void;
  stop(): void;
}
