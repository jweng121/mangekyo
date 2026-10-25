import type { ApprovedMemoryContext, MemoryEntry, MemoryQuery } from "@mangekyo/contracts";
import { retrieveApprovedMemory } from "../memory/memory-store";

/** Finance agents may request guidance, but this adapter grants no finance permissions. */
export interface MemoryContextAdapter {
  getApprovedContext(query: MemoryQuery): ApprovedMemoryContext;
}

export function createLocalMemoryContextAdapter(entries: MemoryEntry[]): MemoryContextAdapter {
  return { getApprovedContext: query => retrieveApprovedMemory(entries, query) };
}
