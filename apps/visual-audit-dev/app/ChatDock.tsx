"use client";
import {useEffect,useRef,useState} from "react";
import {usePathname} from "next/navigation";
import {Maximize2,Minimize2,Minus,X} from "lucide-react";
import Workspace from "./Workspace";
import {workspaceChatEvent} from "../lib/workspace-chat";
import "./chat-dock.css";

export function ChatDock(){
 const pathname=usePathname();
 const [open,setOpen]=useState(false);
 const [mounted,setMounted]=useState(false);
 const [expanded,setExpanded]=useState(false);
 const [messageId,setMessageId]=useState<string>();
 const opener=useRef<HTMLElement|null>(null);
 function show(id?:string){opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setMessageId(id);setMounted(true);setOpen(true);}
 function hide(){setOpen(false);requestAnimationFrame(()=>opener.current?.focus());}
 useEffect(()=>{
  const handle=(event:Event)=>show((event as CustomEvent<{messageId?:string}>).detail?.messageId);
  window.addEventListener(workspaceChatEvent,handle);
  return()=>window.removeEventListener(workspaceChatEvent,handle);
 },[]);
 useEffect(()=>{
  const url=new URL(window.location.href);
  if(url.searchParams.get("chat")==="open"){
   show(decodeURIComponent(url.hash.slice(1))||undefined);
   url.searchParams.delete("chat");url.hash="";
   window.history.replaceState(window.history.state,"",url.pathname+url.search);
  }
 },[pathname]);
 return <>
  {mounted&&<section id="workspace-chat-window" role="dialog" aria-modal="false" aria-labelledby="chat-dock-title" className={`chat-dock ${expanded?"expanded":""}`} hidden={!open} onKeyDown={event=>{if(event.key==="Escape" && !(event.target as HTMLElement).closest(".ws-modal")){event.stopPropagation();hide()}}}>
   <header className="chat-dock-header"><img src="/mangekyo-logo.png" alt="" width={29} height={29}/><h2 id="chat-dock-title">Chat</h2><div><button aria-label="Minimize chat" onClick={hide}><Minus size={17}/></button><button aria-label={expanded?"Restore chat size":"Expand chat"} aria-pressed={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button><button aria-label="Close chat" onClick={hide}><X size={18}/></button></div></header>
   <Workspace section="chat" embedded chatActive={open} targetMessageId={messageId}/>
  </section>}
 </>;
}
