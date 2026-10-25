import type { Snapshot, SnapshotChatSection } from "../../../packages/contracts";

// Navigation is only allowed to evidence supplied to this answer.
export function parseChatSections(raw: string, snapshots: Snapshot[]) {
  let value: unknown;
  // Some responses wrap otherwise valid JSON in a textual respond invocation.
  // Unwrap only this complete envelope; never execute it or salvage partial JSON.
  let json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const envelope = json.match(/^<invoke\s+name=["']respond["']\s*>\s*([\s\S]*?)\s*<\/invoke>$/);
  if (envelope) json = envelope[1];
  try { value = JSON.parse(json); }
  catch { throw new Error("The assistant returned an incomplete answer. Please try again."); }
  const entries = (value as { sections?: unknown[] } | null)?.sections;
  if (!Array.isArray(entries) || !entries.length) throw new Error("The assistant returned no answer sections.");
  const sections: SnapshotChatSection[] = entries.map(entry => {
    const part = entry as { text?: unknown; snapshotId?: unknown; annotationIds?: unknown };
    if (!part || typeof part.text !== "string" || !part.text.trim()) throw new Error("The assistant returned an empty answer section.");
    const snapshot = snapshots.find(item => item.id === part.snapshotId);
    if (part.snapshotId && !snapshot) throw new Error("The assistant referenced unavailable evidence. Please try again.");
    const annotationIds = Array.isArray(part.annotationIds) ? [...new Set(part.annotationIds.filter((id): id is string => typeof id === "string" && !!snapshot?.annotations?.some(item => item.id === id)))] : [];
    return { text: part.text.trim(), ...(snapshot ? { snapshotId: snapshot.id } : {}), annotationIds };
  });
  return { sections, text: sections.map(part => part.text).join("\n\n"), snapshotIds: [...new Set(sections.flatMap(part => part.snapshotId ? [part.snapshotId] : []))] };
}
