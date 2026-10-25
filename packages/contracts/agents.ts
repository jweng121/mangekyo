import type { NarratedExplanation } from "./narration";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  snapshotId?: string;
  timestamp: string;
  narration?: NarratedExplanation;
}
