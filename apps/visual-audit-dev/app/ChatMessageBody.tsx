"use client";
import Markdown from "react-markdown";
export function ChatMessageBody({ text }: { text: string }) {
  return <div className="chat-message-body"><Markdown skipHtml disallowedElements={["img"]}>{text}</Markdown></div>;
}
