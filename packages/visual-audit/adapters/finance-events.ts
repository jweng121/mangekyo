import type { AgentEvent, Snapshot } from "@mangekyo/contracts";

/** Boundary for a future committed finance event stream. Phase 1 uses synthetic events. */
export interface FinanceEventSource {
  subscribe(cursor: { runId: string; afterSequence: number }, onEvent: (event: AgentEvent, snapshot: Snapshot) => void): () => void;
}
