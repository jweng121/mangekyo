export type FishTimestampEvent = { audio_base64?: string; content?: string; chunk_seq?: number; chunk_audio_offset_sec?: number; alignment?: { segments: { text: string; start: number; end: number }[] } | null; error?: string };
export type WordTiming = { start: number; end: number; charIndex: number };
const normalized = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Alignment events are cumulative snapshots, never per-packet deltas. */
export function wordTimeline(text: string, snapshots: Map<number, FishTimestampEvent>): WordTiming[] {
  const words = [...text.matchAll(/\S+/g)]; let cursor = 0;
  const result: WordTiming[] = [];
  for (const [, event] of [...snapshots].sort(([a], [b]) => a - b)) {
    const offset = event.chunk_audio_offset_sec ?? 0;
    for (const segment of event.alignment?.segments ?? []) {
      const match = normalized(segment.text);
      if (!match || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) continue;
      // Do not fabricate word boundaries when the provider supplies a whole phrase.
      const index = words.findIndex((word, i) => i >= cursor && normalized(word[0]) === match);
      if (index < 0) continue;
      result.push({ start: offset + segment.start, end: offset + segment.end, charIndex: words[index].index! }); cursor = index + 1;
    }
  }
  return result.sort((a,b) => a.start-b.start);
}
export async function readTimestampStream(response: Response, onEvent: (event: FishTimestampEvent) => void) {
  if (!response.body) throw new Error("Empty speech stream");
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "";
  const parse = (frame: string) => {
    const payload = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!payload || payload === "[DONE]") return;
    const event = JSON.parse(payload) as FishTimestampEvent;
    if (event.error) throw new Error(event.error);
    onEvent(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream:true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) { parse(pending.slice(0,boundary.index)); pending = pending.slice(boundary.index + boundary[0].length); }
      if (pending.length > 8 * 1024 * 1024) throw new Error("Speech event too large");
      if (done) { if (pending.trim()) parse(pending); break; }
    }
  } finally { reader.releaseLock(); }
}
