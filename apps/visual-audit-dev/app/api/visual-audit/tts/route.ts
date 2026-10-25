import { NextRequest, NextResponse } from "next/server";
import { assertLocalAccess } from "../../../../lib/local-access";
import {retryFetch} from "../../../../lib/retry-fetch";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try { assertLocalAccess(request); const provider = process.env.MANGEKYO_TTS_PROVIDER || "browser"; return NextResponse.json({ provider, configured: provider === "browser" || provider === "fish" && !!process.env.FISH_API_KEY || provider === "elevenlabs" && !!process.env.ELEVENLABS_API_KEY && !!process.env.MANGEKYO_TTS_VOICE }); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 403 }); }
}

export async function POST(request: NextRequest) {
  try {
    assertLocalAccess(request);
    const provider = process.env.MANGEKYO_TTS_PROVIDER;
    if (provider !== "fish" && provider !== "elevenlabs") return NextResponse.json({ error: "Cloud TTS is not selected" }, { status: 400 });
    const { text, timestamps } = await request.json() as { text?: string; timestamps?: boolean };
    if (!text?.trim() || text.length > 8000) return NextResponse.json({ error: "TTS answer must be 1 to 8000 characters" }, { status: 400 });
    if (provider === "fish") {
      const key = process.env.FISH_API_KEY;
      if (!key) return NextResponse.json({ error: "Fish Audio TTS requires FISH_API_KEY" }, { status: 503 });
      const model = process.env.MANGEKYO_TTS_MODEL || "s2.1-pro-free";
      if (!["s2.1-pro-free", "s2.1-pro", "s2-pro", "s1", "drama-3"].includes(model)) return NextResponse.json({ error: `Unsupported Fish Audio model: ${model}` }, { status: 400 });
      const voice = process.env.MANGEKYO_TTS_VOICE;
      const response = await retryFetch(timestamps ? "https://api.fish.audio/v1/tts/stream/with-timestamp" : "https://api.fish.audio/v1/tts", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", model }, body: JSON.stringify({ text, format: "mp3", ...(voice ? { reference_id: voice } : {}) }), signal: request.signal },60000);
      if (!response.ok) return NextResponse.json({ error: `Fish Audio TTS failed (${response.status})` }, { status: 502 });
      return new NextResponse(response.body, { headers: { "Content-Type": timestamps ? "text/event-stream" : "audio/mpeg", "Cache-Control": "private, no-store" } });
    }
    const key = process.env.ELEVENLABS_API_KEY;
    const voice = process.env.MANGEKYO_TTS_VOICE;
    if (!key || !voice) return NextResponse.json({ error: "ElevenLabs TTS requires ELEVENLABS_API_KEY and MANGEKYO_TTS_VOICE" }, { status: 503 });
    const model = process.env.MANGEKYO_TTS_MODEL || "eleven_multilingual_v2";
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, { method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ text, model_id: model }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) return NextResponse.json({ error: `ElevenLabs TTS failed (${response.status})` }, { status: 502 });
    return new NextResponse(response.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, no-store" } });
  } catch (error) {
    const cause = (error as Error & { cause?: { code?: string } }).cause?.code;
    const message = cause === "EACCES" || cause === "EPERM" ? "The app server is blocked from connecting to the voice service. Restart the development server in a terminal with network access."
      : (error as Error).name === "TimeoutError" ? "The voice service took too long to respond. Please retry."
      : (error as Error).message === "fetch failed" ? "Unable to connect to the voice service. Check the server network connection and retry."
      : (error as Error).message;
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
