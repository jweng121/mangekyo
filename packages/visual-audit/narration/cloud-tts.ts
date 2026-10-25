import type { TtsProvider } from "./tts-provider";
import { readTimestampStream, wordTimeline, type FishTimestampEvent, type WordTiming } from "./fish-timestamps";

/** Captions follow provider word timestamps on the audio clock, never estimated timers. */
export class CloudTtsProvider implements TtsProvider {
  constructor(readonly continuous = true) {}
  private paused = false;
  private audio?: HTMLAudioElement;
  private abort?: AbortController;
  private objectUrl?: string;
  private frame?: number;
  private onError?: (error: string) => void;
  isAvailable() { return typeof Audio !== "undefined"; }
  speak(text: string, callbacks: { onEnd: () => void; onError: (error: string) => void; onStart?: () => void; onBoundary?: (charIndex: number) => void }) {
    this.stop(); this.onError = callbacks.onError;
    const abort = new AbortController(); this.abort = abort;
    void (async () => {
      const response = await fetch("/api/visual-audit/tts", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({text,timestamps:true}), signal:abort.signal });
      if (!response.ok) throw new Error((await response.json()).error ?? "Cloud TTS failed");
      let blob: Blob, timeline: WordTiming[] = [];
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const parts: Uint8Array<ArrayBuffer>[] = [], snapshots = new Map<number,FishTimestampEvent>(); let size=0;
        await readTimestampStream(response, event => {
          if (event.audio_base64) { const bytes=Uint8Array.from(atob(event.audio_base64),char=>char.charCodeAt(0)); size+=bytes.length; if(size>24*1024*1024)throw new Error("Speech audio too large"); parts.push(bytes); }
          if (event.alignment) snapshots.set(event.chunk_seq ?? 0,event);
        });
        timeline=wordTimeline(text,snapshots);
        if (!timeline.length) throw new Error("Word timing unavailable for this voice response. Please retry.");
        blob=new Blob(parts,{type:"audio/mpeg"});
      } else { blob=await response.blob(); }
      if (abort.signal.aborted) return;
      this.objectUrl=URL.createObjectURL(blob); const audio=new Audio(this.objectUrl);this.audio=audio;
      let started=false,last=-1;
      const tick=()=> {
        if(abort.signal.aborted)return;
        if(!audio.paused && !this.paused) {
          const current=[...timeline].reverse().find(word=>word.start<=audio.currentTime);
          if(current && current.charIndex!==last){last=current.charIndex;callbacks.onBoundary?.(last);}
        }
        this.frame=requestAnimationFrame(tick);
      };
      audio.onplaying=()=>{if(abort.signal.aborted)return;if(!started){started=true;callbacks.onStart?.();}if(this.frame===undefined)tick();};
      audio.onended=()=>{if(abort.signal.aborted)return;this.release();callbacks.onEnd();};
      audio.onerror=()=>{if(abort.signal.aborted)return;this.release();callbacks.onError("Audio playback failed");};
      if(!this.paused)await audio.play();
    })().catch(error=>{if(!abort.signal.aborted){abort.abort();this.release();callbacks.onError(String(error));}});
  }
  pause(){this.paused=true;this.audio?.pause();}
  resume(){this.paused=false;void this.audio?.play().catch(error=>this.onError?.(String(error)));}
  stop(){this.paused=false;this.abort?.abort();this.release();}
  private release(){if(this.frame!==undefined)cancelAnimationFrame(this.frame);this.frame=undefined;if(this.audio){this.audio.onplaying=null;this.audio.onended=null;this.audio.onerror=null;this.audio.pause();this.audio.src="";}if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);this.objectUrl=undefined;this.audio=undefined;}
}
