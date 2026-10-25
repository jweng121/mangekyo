import assert from "node:assert/strict";
import test from "node:test";
import type { AuditFinding, Snapshot, RecordEvidence } from "@mangekyo/contracts";
import { buildWalkthroughDialogue, spokenReference, walkthroughDialogue } from "../narration/walkthrough-dialogue";
const finding = { id: "finding", reviewedThroughSequence: 5, explanation: "The request names Client A, but the lookup returned Client B." } as AuditFinding;
const record: RecordEvidence = { system: "Local SQLite", resource: "trust_clients", operation: "read", status: "succeeded", filters: { paymentCode: "B-204" }, columns: [], rows: [{ name: "Client B", legal: "Beacon Development LLC" }], rowCount: 1, truncated: false, executedAt: "2026-10-24" };
const snapshot = (data: Partial<Snapshot> = {}) => ({ id: "read", runId: "run", sequence: 1, actionType: "READ", summary: "Technical summary", observation: { kind: "api", fields: [], label: "Record", record }, evidence: [{ id: "evidence" }], annotations: [{ id: "annotation", evidenceRef: "evidence" }], ...data } as Snapshot);
test("dialogue describes the observed lookup and conflicting proposal", () => {
 const read = snapshot(); const proposal = snapshot({ id: "proposal", actionType: "PROPOSE", observation: { kind: "api", label: "Proposal", fields: [{ id: "proposed-owner", label: "Owner", value: "Client A" }] } });
 const text = walkthroughDialogue(read, [read, proposal], finding);
 assert.match(text, /B two zero four/); assert.match(text, /returned Client B, Beacon Development LLC/); assert.match(text, /different from Client A/); assert.doesNotMatch(text, /SELECT|Technical summary|trust_clients/);
});
test("empty, broad, partial, and failed reads do not assert a unique owner", () => {
 for (const [override, expected] of [[{rows:[],rowCount:0},/no matching records/], [{rows:[{},{}],rowCount:2},/returned 2 records/], [{truncated:true},/only part/], [{status:"failed"},/read failed/]] as const) {
  const read=snapshot({observation:{kind:"api",label:"Read",fields:[],record:{...record,...override} as RecordEvidence}});
  const text=walkthroughDialogue(read,[read],finding);assert.match(text,expected);assert.doesNotMatch(text,/It returned Client B/);
 }
});
test("draft narration explains the write without reading internal identifiers", () => {
 const write=snapshot({actionType:"WRITE_CONFIRMED",observation:{kind:"api",label:"Write",fields:[],record:{...record,operation:"insert",resource:"allocation_drafts",rows:[{id:"AL-secret-uuid",client:"Client A",ledgerPosted:false}]}}});
 const text=walkthroughDialogue(write,[write],finding);assert.match(text,/saved a new allocation draft for Client A/);assert.match(text,/No financial ledger entry was posted/);assert.doesNotMatch(text,/AL-secret/);
});
test("dialogue preserves evidence navigation and excludes other runs", () => {
 const result=buildWalkthroughDialogue("run",finding,[snapshot(),snapshot({runId:"unrelated"})]);
 assert.equal(result.segments.length,1);assert.deepEqual(result.segments[0].highlightIds,["annotation"]);assert.deepEqual(result.segments[0].evidenceRefs,["evidence"]);assert(result.segments[0].text.length<2000);
 assert.equal(spokenReference("B-204"),"B two zero four");
});

import { wordTimeline, readTimestampStream } from "../narration/fish-timestamps";
import { currentCaption } from "../narration/caption-phrases";
test("words stay hidden until their audio boundary", () => {
 assert.equal(currentCaption("The agent read it. Next step.",-1), "");
 assert.equal(currentCaption("The agent read it. Next step.",0), "The");
 assert.equal(currentCaption("The agent read it. Next step.",4), "The agent");
 assert.equal(currentCaption("The agent read it. Next step.",19), "Next");
});
test("Fish timeline replaces snapshots and applies chunk offsets", () => {
 const snapshots=new Map();
 snapshots.set(0,{alignment:{segments:[{text:"The",start:0,end:.2}]}});
 snapshots.set(0,{alignment:{segments:[{text:"The",start:0,end:.2},{text:"agent",start:.2,end:.5}]}});
 snapshots.set(1,{chunk_audio_offset_sec:1,alignment:{segments:[{text:"read",start:.1,end:.4}]}});
 assert.deepEqual(wordTimeline("The agent read.",snapshots),[{start:0,end:.2,charIndex:0},{start:.2,end:.5,charIndex:4},{start:1.1,end:1.4,charIndex:10}]);
});
test("SSE handles split events and cumulative alignment metadata",async()=>{
 const encoder=new TextEncoder();const events: unknown[]=[];
 const response=new Response(new ReadableStream({start(controller){for(const text of ['data: {"audio_base','64":"QQ==","alignment":null}\r\n\r','\ndata: {"chunk_seq":0,"alignment":{"segments":[]}}\n\n'])controller.enqueue(encoder.encode(text));controller.close();}}));
 await readTimestampStream(response,event=>events.push(event));assert.equal(events.length,2);
});
