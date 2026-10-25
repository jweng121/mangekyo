import type { AgentEvent, Snapshot } from "@mangekyo/contracts";

export interface ExecutionGraph { nodes: AgentEvent[]; edges: { id: string; source: string; target: string }[] }

export function ingestEvent(events: AgentEvent[], incoming: AgentEvent): AgentEvent[] {
  const existing = events.find(event => event.id === incoming.id);
  if (existing) return events;
  if (events.some(event => event.runId === incoming.runId && event.sequence === incoming.sequence)) {
    throw new Error(`Conflicting sequence ${incoming.sequence} in ${incoming.runId}`);
  }
  if (incoming.parentEventIds.some(parent => !events.some(event => event.id === parent))) {
    throw new Error(`Missing parent for ${incoming.id}`);
  }
  return [...events, incoming].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence);
}

export function buildExecutionGraph(events: AgentEvent[]): ExecutionGraph {
  return {
    nodes: events,
    edges: events.flatMap(event => event.parentEventIds.map(parent => ({ id: `${parent}->${event.id}`, source: parent, target: event.id }))),
  };
}

export function snapshotForEvent(event: AgentEvent, snapshots: Snapshot[]): Snapshot | undefined {
  return snapshots.find(snapshot => snapshot.id === event.snapshotId && snapshot.eventId === event.id && snapshot.runId === event.runId);
}

export function ancestors(eventId: string, events: AgentEvent[]): AgentEvent[] {
  const byId = new Map(events.map(event => [event.id, event]));
  const visited = new Set<string>();
  const visit = (id: string) => {
    for (const parent of byId.get(id)?.parentEventIds ?? []) {
      if (!visited.has(parent)) { visited.add(parent); visit(parent); }
    }
  };
  visit(eventId);
  return events.filter(event => visited.has(event.id));
}
