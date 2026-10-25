"use client";
import {useEffect, useRef, useState} from "react";

const quiet = Array<number>(10).fill(.12);
/** One microphone stream feeds both the recording and the live waveform. */
export function useVoiceCapture(onTranscript:(text:string)=>void) {
  const callback=useRef(onTranscript); callback.current=onTranscript;
  const session=useRef(0), cleanup=useRef<()=>void>(()=>{}), submit=useRef<()=>void>(()=>{});
  const pending=useRef<AbortController|null>(null), clip=useRef<Blob|null>(null), active=useRef(false);
  const audioContext=useRef<AudioContext|null>(null);
  const [starting,setStarting]=useState(false);
  const [listening,setListening]=useState(false), [transcribing,setTranscribing]=useState(false), [error,setError]=useState("");
  const [meter,setMeter]=useState({bars:quiet,speaking:false});
  const stop=()=>{session.current++;active.current=false;pending.current?.abort();pending.current=null;cleanup.current();cleanup.current=()=>{};setStarting(false);setListening(false);setTranscribing(false);setMeter({bars:quiet,speaking:false});};
  const transcribe=async(blob:Blob, token:number)=>{
    const controller=new AbortController();pending.current=controller;
    clip.current=blob;setTranscribing(true);setError("");
    try {
      const form=new FormData();form.set("audio",blob,blob.type.includes("mp4")?"question.m4a":"question.webm");
      const response=await fetch("/api/visual-audit/transcribe",{method:"POST",body:form,signal:controller.signal});
      const result=await response.json();
      if(!response.ok){
        // Silence or invalid audio cannot improve by repeatedly sending the same clip.
        if(token===session.current && [400,413,422].includes(response.status))clip.current=null;
        throw new Error(result.error||"Transcription failed. Retry your recording.");
      }
      if(token!==session.current)return;
      clip.current=null;setTranscribing(false);pending.current=null;callback.current(result.text);
    }catch(cause){if(token===session.current&&!controller.signal.aborted)setError((cause as Error).message);}
    finally{if(token===session.current){setTranscribing(false);pending.current=null;}}
  };
  const start=async()=>{
    // A user gesture must be able to unlock a previously suspended audio context.
    if(audioContext.current?.state==="suspended")void audioContext.current.resume().catch(()=>{});
    if(active.current||pending.current)return;
    stop();const token=session.current;active.current=true;clip.current=null;setError("");setStarting(true);
    let stream:MediaStream|undefined, context:AudioContext|undefined, recorder:MediaRecorder|undefined, frame=0, timer:ReturnType<typeof setTimeout>|undefined;
    const release=()=>{clearTimeout(timer);cancelAnimationFrame(frame);if(recorder){recorder.onstop=null;recorder.ondataavailable=null;recorder.onerror=null;if(recorder.state!=="inactive")recorder.stop();}stream?.getTracks().forEach(track=>track.stop());if(audioContext.current===context)audioContext.current=null;if(context&&context.state!=="closed")void context.close();};
    cleanup.current=release;
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},video:false});
      if(token!==session.current){release();return;}
      context=new AudioContext();audioContext.current=context;
      // Do not remain stuck in "Your turn" if the browser blocks audio processing.
      await new Promise<void>((resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error("Microphone audio is paused by the browser. Click the microphone to try again.")),8000);
        context!.resume().then(()=>{clearTimeout(timer);resolve();},reject);
      });
      if(token!==session.current){release();return;}
      const analyser=context.createAnalyser();analyser.fftSize=1024;context.createMediaStreamSource(stream).connect(analyser);
      const mime=["audio/webm;codecs=opus","audio/mp4","audio/webm"].find(type=>MediaRecorder.isTypeSupported(type));
      recorder=new MediaRecorder(stream,mime?{mimeType:mime,audioBitsPerSecond:128000}:undefined);
      const chunks:BlobPart[]=[];let speechMs=0,lastSound=0,lastTick=performance.now(),lastPaint=0,finished=false;
      const finish=()=>{if(finished||token!==session.current)return;finished=true;clearTimeout(timer);cancelAnimationFrame(frame);setListening(false);setMeter({bars:quiet,speaking:false});recorder!.stop();};
      submit.current=finish;
      recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      recorder.onstop=()=>{
        const blob=new Blob(chunks,{type:recorder!.mimeType});release();active.current=false;
        if(token!==session.current)return;
        if(speechMs<250){setError("No microphone audio detected. Check your input device, then click the microphone to record again.");return;}
        void transcribe(blob,token);
      };
      recorder.onerror=()=>{if(token===session.current){stop();setError("Microphone recording failed. Please try again.");}};
      recorder.start(250);setStarting(false);setListening(true);
      timer=setTimeout(finish,90000);
      const samples=new Float32Array(analyser.fftSize), began=performance.now();
      const sample=(now:number)=>{
        if(token!==session.current||finished)return;
        analyser.getFloatTimeDomainData(samples);
        const rms=Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length), speech=rms>.006;
        if(speech){speechMs+=Math.min(100,now-lastTick);lastSound=now;}
        lastTick=now;
        if(now-lastPaint>45){lastPaint=now;setMeter({speaking:speech,bars:quiet.map((_,i)=>{const part=samples.subarray(i*100,(i+1)*100);const energy=Math.sqrt(part.reduce((n,x)=>n+x*x,0)/part.length);return .12+Math.min(.88,energy*14);})});}
        if(speechMs>=250&&now-lastSound>1500){finish();return;}
        if(!lastSound&&now-began>30000){finish();return;}
        frame=requestAnimationFrame(sample);
      };
      frame=requestAnimationFrame(sample);
    }catch(cause){release();if(token===session.current){active.current=false;setStarting(false);setListening(false);setError((cause as DOMException).name==="NotAllowedError"?"Microphone blocked. Allow microphone access or type in chat.":(cause as Error).message.includes("paused by the browser")?(cause as Error).message:"Could not open the microphone. Check your input device.");}}
  };
  const retry=()=>{if(clip.current)void transcribe(clip.current,session.current);else void start();};
  useEffect(()=>()=>{session.current++;pending.current?.abort();cleanup.current();},[]);
  return {starting,listening,transcribing,error,...meter,start,stop,retry,clearError:()=>setError(""),finish:()=>submit.current()};
}
