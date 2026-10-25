"use client";
import { useEffect, useState } from "react";

const quiet = Array<number>(10).fill(.12);
/** Measure microphone samples locally; transcription events do not drive the meter. */
export function useMicrophoneMeter(enabled: boolean) {
  const [meter, setMeter] = useState({ bars: quiet, speaking: false, error: "" });
  useEffect(() => {
    let disposed = false, stream: MediaStream | undefined, context: AudioContext | undefined, frame = 0;
    let source: MediaStreamAudioSourceNode | undefined;
    const stop = () => { cancelAnimationFrame(frame); source?.disconnect(); stream?.getTracks().forEach(track => track.stop()); if (context && context.state !== "closed") void context.close(); };
    setMeter({ bars: quiet, speaking: false, error: "" });
    if (!enabled) return;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (disposed) { stop(); return; }
        context = new AudioContext(); await context.resume();
        if (disposed) { stop(); return; }
        const analyser = context.createAnalyser(); analyser.fftSize = 512;
        source = context.createMediaStreamSource(stream); source.connect(analyser);
        // No destination connection: the microphone must never feed the speakers.
        const samples = new Float32Array(analyser.fftSize);
        let previous = quiet, lastUpdate = 0, lastSound = 0;
        const sample = (time: number) => {
          if (disposed) return;
          if (time - lastUpdate >= 33) {
            analyser.getFloatTimeDomainData(samples);
            const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
            if (rms > .008) lastSound = time;
            const speaking = rms > .008 || lastSound > 0 && time - lastSound < 180;
            const bars = quiet.map((_, i) => {
              const start = Math.floor(i * samples.length / 10), end = Math.floor((i + 1) * samples.length / 10);
              let energy = 0; for (let j = start; j < end; j++) energy += samples[j] * samples[j];
              const level = Math.sqrt(energy / (end - start));
              const target = .12 + Math.min(.88, Math.max(0, level - .006) * 12);
              return previous[i] * .35 + target * .65;
            });
            previous = bars; lastUpdate = time;
            setMeter(current => current.speaking === speaking && !current.error && bars.every((bar, i) => Math.abs(bar - current.bars[i]) < .015) ? current : { bars, speaking, error: "" });
          }
          frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
      } catch (error) {
        stop();
        if (!disposed) setMeter({ bars: quiet, speaking: false, error: (error as DOMException).name === "NotAllowedError" ? "Microphone blocked. Allow access to show the waveform." : "Microphone level unavailable. Check your input device." });
      }
    })();
    return () => { disposed = true; stop(); };
  }, [enabled]);
  return meter;
}
