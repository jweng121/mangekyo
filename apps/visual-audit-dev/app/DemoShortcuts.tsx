"use client";
import {useEffect,useRef,useState} from "react";
import {useRouter} from "next/navigation";

export function DemoShortcuts(){
 const router=useRouter();
 const pending=useRef(false);
 const [notice,setNotice]=useState("");
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(""),5000);return()=>clearTimeout(timer)},[notice]);
 useEffect(()=>{
  async function handle(event:KeyboardEvent){
   if(!event.ctrlKey||!event.altKey||event.shiftKey||event.metaKey||event.repeat)return;
   if(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable=true],[role=textbox]"))return;
   const action=({Digit1:"connect",Digit2:"incoming",Digit0:"reset"} as Record<string,string>)[event.code];
   if(!action)return;
   event.preventDefault();if(pending.current)return;pending.current=true;setNotice("");
   try{
    const response=await fetch("/api/workspace/simulate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action})});
    const result=await response.json();if(!response.ok)throw new Error(result.error??"Demo action failed");
    window.dispatchEvent(new Event("mangekyo:workspace-refresh"));
    if(action==="reset")router.push("/desk");
    else if(action==="connect")router.push("/activity");
   }catch(error){setNotice((error as Error).message)}finally{pending.current=false}
  }
  window.addEventListener("keydown",handle);return()=>window.removeEventListener("keydown",handle);
 },[router]);
 return notice?<div role="status" aria-live="polite" style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",zIndex:1000,maxWidth:"calc(100vw - 40px)",padding:"12px 18px",borderRadius:12,background:"#fff",color:"#554b47",boxShadow:"0 4px 24px #30211a18",fontSize:13,pointerEvents:"none"}}>{notice}</div>:null;
}
