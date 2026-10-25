import type { AgentEvent, Snapshot } from "@mangekyo/contracts";
import { snapshotForEvent } from "../graph/execution-graph";

export function selectSnapshot(eventId: string, events: AgentEvent[], snapshots: Snapshot[]): Snapshot | undefined {
  const event = events.find(item => item.id === eventId);
  return event ? snapshotForEvent(event, snapshots) : undefined;
}
