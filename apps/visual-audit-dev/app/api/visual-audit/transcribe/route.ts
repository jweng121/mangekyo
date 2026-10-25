import {NextRequest, NextResponse} from "next/server";
import {assertLocalAccess} from "../../../../lib/local-access";
import {retryFetch} from "../../../../lib/retry-fetch";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try { assertLocalAccess(request); return NextResponse.json({configured:!!process.env.FISH_API_KEY, model:"transcribe-1-pro"}); }
  catch { return NextResponse.json({error:"Local demo access only"},{status:403}); }
}
export async function POST(request: NextRequest) {
  try {
    assertLocalAccess(request);
    if (!process.env.FISH_API_KEY) return NextResponse.json({error:"Speech transcription requires FISH_API_KEY."},{status:503});
    if (Number(request.headers.get("content-length")) > 10*1024*1024) return NextResponse.json({error:"Recording is too large. Please ask a shorter question."},{status:413});
    const input = await request.formData(), audio = input.get("audio");
    if (!(audio instanceof File) || audio.size < 100 || audio.size > 10*1024*1024) return NextResponse.json({error:"Provide a recording under 10 MB."},{status:400});
    const form = new FormData();
    form.set("audio",audio); form.set("language","en"); form.set("ignore_timestamps","true");
    form.set("diarize","false"); form.set("tag_audio_events","false");
    const response = await retryFetch("https://api.fish.audio/v1/asr",{method:"POST",headers:{Authorization:`Bearer ${process.env.FISH_API_KEY}`,model:"transcribe-1-pro"},body:form,signal:request.signal});
    if (!response.ok) return NextResponse.json({error: response.status===402 ? "Fish Audio transcription needs API credit. Add credit, then retry this recording." : `Transcription service failed (${response.status}). Retry your recording.`},{status:502});
    const result = await response.json() as {text?:string};
    const text = result.text?.trim();
    if (!text) return NextResponse.json({error:"No speech was detected. Please try speaking again."},{status:422});
    return NextResponse.json({text,model:"transcribe-1-pro"});
  } catch (error) {
    return NextResponse.json({error:(error as Error).name==="TimeoutError" ? "Transcription took too long. Retry your recording." : "Could not transcribe the recording. Please retry."},{status:502});
  }
}
