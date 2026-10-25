"use client";
import type { InvestigationChatMessage, Snapshot } from "../../../packages/contracts";
import { ArrowUpRight, Database, FileText } from "lucide-react";
import { ChatMessageBody } from "./ChatMessageBody";

export function SnapshotChatReply({ message, snapshots, onOpen }: { message: Pick<InvestigationChatMessage, "id" | "role" | "text" | "sections">; snapshots: Snapshot[]; onOpen: (snapshot: Snapshot) => void }) {
  if (message.role !== "assistant" || !message.sections?.length) return <ChatMessageBody text={message.text}/>;
  return <div className="snapshot-chat-reply" data-message-id={message.id}>{message.sections.map((section, index) => {
    const snapshot = snapshots.find(item => item.id === section.snapshotId);
    return <section className="snapshot-chat-section" key={`${message.id}-${index}`} data-snapshot-id={snapshot?.id}>
      {snapshot && <button className="inline-snapshot-preview" onClick={() => onOpen(snapshot)} aria-label={`Open snapshot ${snapshot.sequence}: ${snapshot.title}`}>
        {snapshot.screenshot ? <img src={snapshot.screenshot.url} alt={snapshot.screenshot.alt} loading="lazy"/> : <span className="record-preview-fields">{snapshot.observation.fields.slice(0, 3).map(field => <span key={field.id}><span>{field.label}</span><strong>{field.value}</strong></span>)}{!snapshot.observation.fields.length && <span>{snapshot.summary}</span>}</span>}
        <span className="inline-snapshot-label">{snapshot.observation.record ? <Database size={14}/> : <FileText size={14}/>}<span><small>Snapshot {snapshot.sequence}</small><strong>{snapshot.title}</strong></span><ArrowUpRight size={14}/></span>
      </button>}
      <ChatMessageBody text={section.text}/>
    </section>;
  })}</div>;
}
