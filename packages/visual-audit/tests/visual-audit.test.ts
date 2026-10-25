import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryEntry } from "@mangekyo/contracts";
import { createDemoStream, DATA_CONTEXT, ORGANIZATION_ID, TASK_TYPE } from "../adapters/mock-events";
import { simulateFutureRun } from "../adapters/future-run";
import { runMockAudit } from "../auditor/mock-auditor";
import { selectSnapshot } from "../chat/chat-context";
import { answerMockQuestion } from "../chat/mock-chat";
import { buildExecutionGraph, ingestEvent, snapshotForEvent } from "../graph/execution-graph";
import { approveMemory, proposeMemory, readStoredProposal, retrieveApprovedMemory, reviseMemory, writeStoredProposal } from "../memory/memory-store";
import { simulateSteering } from "../steering/steering-manager";

const fixture = createDemoStream();
const maker = fixture.snapshots.find(snapshot => snapshot.id === "snapshot-original-maker")!;

test("events ingest in order, ignore duplicate delivery, and reject missing parents", () => {
  let events: typeof fixture.events = [];
  for (const event of fixture.events) events = ingestEvent(events, event);
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(ingestEvent(events, fixture.events[2]), events);
  assert.throws(() => ingestEvent([], fixture.events[2]), /Missing parent/);
});

test("every snapshot associates with its committed event and selection updates chat context", () => {
  for (const event of fixture.events) assert.equal(snapshotForEvent(event, fixture.snapshots)?.eventId, event.id);
  const selected = selectSnapshot("original-maker", fixture.events, fixture.snapshots);
  assert.equal(selected?.id, maker.id);
  assert.match(answerMockQuestion("Why did they disagree?", selected, fixture.events, runMockAudit({ runId: "run-original", throughSequence: 7 }, fixture.events, fixture.snapshots).findings), /Client A.*Client B/);
  assert.equal(selectSnapshot("original-checker", fixture.events, fixture.snapshots)?.agentRole, "Independent Checker");
});

test("mock audit flags the earliest unsupported proposal without authorizing a write", () => {
  const result = runMockAudit({ runId: "run-original", throughSequence: 7 }, fixture.events, fixture.snapshots);
  assert.equal(result.outcome, "needs_review");
  assert.equal(result.findings[0].snapshotId, maker.id);
  assert.equal(maker.writeTargets.length, 0);
  assert.deepEqual(fixture.events.find(event => event.id === "original-checker")?.parentEventIds, ["original-clients"]);
});

test("steering creates a provenance-linked branch and never replays payments", () => {
  const corrected = simulateSteering(maker, "Recheck B-204 for Client B", "reviewer-1", "dependent_work");
  assert.equal(corrected.steering.checkpointSnapshotId, maker.id);
  assert.equal(corrected.correction.steeringId, corrected.steering.id);
  assert.equal(corrected.correction.replayPayments, false);
  assert.equal(corrected.branch.forkSnapshotId, maker.id);
  const graph = buildExecutionGraph([...fixture.events, ...corrected.events]);
  assert(graph.edges.some(edge => edge.source === "original-maker" && edge.target === "corrected-steer"));
  assert.equal(corrected.snapshots.find(snapshot => snapshot.id === "snapshot-corrected-proposal")?.observation.output?.proposedOwner, "Client B");
});

test("only approved memory in the exact scope is retrieved for a future run", () => {
  const corrected = simulateSteering(maker, "Recheck B-204", "reviewer-1", "dependent_work");
  const proposal = proposeMemory(corrected.steering, maker);
  const query = { organizationId: ORGANIZATION_ID, agentRole: "Matching Maker", taskType: TASK_TYPE, dataContext: DATA_CONTEXT };
  assert.equal(retrieveApprovedMemory([proposal], query).entries.length, 0);
  const approved = approveMemory(proposal, "reviewer-2", "2026-10-23T12:01:00.000Z");
  assert.equal(retrieveApprovedMemory([approved], query).entries[0].id, approved.id);
  assert.equal(retrieveApprovedMemory([approved], { ...query, organizationId: "other-tenant" }).entries.length, 0);
  assert.equal(retrieveApprovedMemory([approved], { ...query, agentRole: "Independent Checker" }).entries.length, 0);
  assert.equal(retrieveApprovedMemory([{ ...approved, status: "revoked" } as MemoryEntry], query).entries.length, 0);
  const future = simulateFutureRun([approved]);
  assert(future.snapshots.some(snapshot => snapshot.memoryRefs?.includes(approved.id)));
  assert.throws(() => simulateFutureRun([proposal]), /No approved/);
});

test("memory proposals persist without becoming active and revisions preserve version history", () => {
  const correction = simulateSteering(maker, "Recheck B-204", "reviewer-1", "dependent_work");
  const proposal = proposeMemory(correction.steering, maker);
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  writeStoredProposal(storage, proposal);
  assert.equal(readStoredProposal(storage)?.status, "pending");
  const approved = approveMemory(proposal, "reviewer-2", "2026-10-23T12:01:00.000Z");
  const revision = reviseMemory(approved, "reviewer-2", "2026-10-23T12:02:00.000Z");
  assert.equal(revision.version, 2);
  assert.equal(revision.supersedesId, approved.id);
  assert.equal(retrieveApprovedMemory([revision], { organizationId: ORGANIZATION_ID, agentRole: "Matching Maker", taskType: TASK_TYPE, dataContext: DATA_CONTEXT }).entries.length, 0);
});
