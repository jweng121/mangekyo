import type { NarratedExplanation, SnapshotChatSection, Snapshot } from "@mangekyo/contracts";
import { spokenReference } from "./walkthrough-dialogue";

function plainChunks(text: string): string[] {
  const plain = spokenReference(text
    .replace(/```[\s\S]*?```/g, "The code details are in chat.")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-snapshot-(\d+)\b/gi, "snapshot $1")
    .replace(/^[ \t]*[>#*-]+[ \t]*/gm, "")
    .replace(/[*`_]/g, "").replace(/\s+/g, " ").trim());
  const chunks: string[] = []; let chunk = "";
  for (const word of plain.split(" ")) {
    if (chunk.length + word.length > 1400) { chunks.push(chunk); chunk = ""; }
    chunk += `${chunk ? " " : ""}${word}`;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function buildSpokenReply(messageId: string, text: string, sections?: SnapshotChatSection[], snapshots: Snapshot[] = []): NarratedExplanation {
  const parts = sections?.length ? sections : [{ text, annotationIds: [] }];
  return { id: `reply-${messageId}`, messageId, segments: parts.flatMap((part, sectionIndex) => {
    const snapshot = snapshots.find(item => item.id === part.snapshotId);
    const annotations = (snapshot?.annotations ?? []).filter(item => part.annotationIds.includes(item.id));
    return plainChunks(part.text).map((chunk, index) => ({
      id: `reply-${messageId}-${sectionIndex}-${index}`, text: chunk,
      snapshotId: snapshot?.id, evidenceRefs: annotations.map(item => item.evidenceRef),
      highlightIds: annotations.map(item => item.id),
      navigationTarget: snapshot ? { snapshotId: snapshot.id, evidenceRef: annotations[0]?.evidenceRef } : undefined,
    }));
  }) };
}
