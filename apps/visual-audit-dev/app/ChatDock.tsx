"use client";
import {useEffect,useRef,useState} from "react";
import {usePathname} from "next/navigation";
import {Maximize2,Minimize2,Minus,MessageSquare,X} from "lucide-react";
import Workspace from "./Workspace";
import {workspaceChatEvent} from "../lib/workspace-chat";
import "./chat-dock.css";

export function ChatDock(){
 const pathname=usePathname();
 const [open,setOpen]=useState(false);
 const [mounted,setMounted]=useState(false);
 const [expanded,setExpanded]=useState(false);
 const [messageId,setMessageId]=useState<string>();
 const launcher=useRef<HTMLButtonElement>(null);
 function show(id?:string){setMessageId(id);setMounted(true);setOpen(true);}
 function hide(){setOpen(false);requestAnimationFrame(()=>launcher.current?.focus());}
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
  <button ref={launcher} className="chat-dock-launcher" hidden={open} aria-label="Open chat" aria-expanded={open} aria-controls="workspace-chat-window" onClick={()=>show()}><MessageSquare size={18}/><span>Chat</span></button>
  {mounted&&<section id="workspace-chat-window" role="dialog" aria-modal="false" aria-labelledby="chat-dock-title" className={`chat-dock ${expanded?"expanded":""}`} hidden={!open} onKeyDown={event=>{if(event.key==="Escape" && !(event.target as HTMLElement).closest(".ws-modal")){event.stopPropagation();hide()}}}>
   <header className="chat-dock-header"><img src="/mangekyo-logo.png" alt="" width={29} height={29}/><h2 id="chat-dock-title">Chat</h2><div><button aria-label="Minimize chat" onClick={hide}><Minus size={17}/></button><button aria-label={expanded?"Restore chat size":"Expand chat"} aria-pressed={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button><button aria-label="Close chat" onClick={hide}><X size={18}/></button></div></header>
   <Workspace section="chat" embedded chatActive={open} targetMessageId={messageId}/>
  </section>}
 </>;
}
