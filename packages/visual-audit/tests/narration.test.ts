import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceAnnotation, NarrationSegment, Snapshot } from "@mangekyo/contracts";
import { createDemoStream } from "../adapters/mock-events";
import { resolveAnnotation, resolveHighlights, validateNarratedExplanation } from "../annotations/highlight-resolver";
import { runMockAudit } from "../auditor/mock-auditor";
import { buildIssueExplanation } from "../narration/evidence-segments";
import { NarrationController, type PlaybackUpdate } from "../narration/narration-controller";
import type { TtsProvider } from "../narration/tts-provider";

const fixture = createDemoStream();
const finding = runMockAudit({ runId: "run-original", throughSequence: 7 }, fixture.events, fixture.snapshots).findings[0];

test("issue narration cites recorded evidence and navigates across four checkpoints", () => {
  const explanation = buildIssueExplanation("message-1", finding, fixture.snapshots);
  assert.deepEqual(explanation.segments.map(segment => segment.snapshotId), ["snapshot-original-maker", "snapshot-original-bank", "snapshot-original-clients", "snapshot-original-checker"]);
  validateNarratedExplanation(explanation, fixture.snapshots);
  for (const segment of explanation.segments) {
    const snapshot = fixture.snapshots.find(item => item.id === segment.snapshotId)!;
    assert.equal(resolveHighlights(snapshot, segment.highlightIds).length, segment.highlightIds.length);
    assert(segment.evidenceRefs.every(ref => snapshot.evidence.some(item => item.id === ref)));
  }
  const invalid = structuredClone(explanation);
  invalid.segments[0].evidenceRefs.push("made-up-document");
  assert.throws(() => validateNarratedExplanation(invalid, fixture.snapshots), /Unknown evidence/);
});

test("highlights reject unrecorded field paths and invented image coordinates", () => {
  const maker = fixture.snapshots.find(item => item.id === "snapshot-original-maker")!;
  const valid = maker.annotations![0];
  assert(resolveAnnotation(maker, valid));
  assert.equal(resolveAnnotation(maker, { ...valid, fieldPath: "observation.fields.unknown" }), undefined);
  const screenshot: Snapshot = { ...maker, screenshot: { url: "/synthetic.png", provenance: "simulated", alt: "Synthetic mock" } };
  const region: EvidenceAnnotation = { id: "region-1", snapshotId: maker.id, evidenceRef: valid.evidenceRef, label: "Owner", region: { x: .1, y: .2, width: .3, height: .4 } };
  assert(resolveAnnotation(screenshot, region));
  assert.equal(resolveAnnotation(maker, region), undefined);
  assert.equal(resolveAnnotation(screenshot, { ...region, region: { x: .9, y: .2, width: .3, height: .4 } }), undefined);
});

test("narration synchronizes segments and supports pause, resume, stop, and replay", () => {
  const callbacks: Parameters<TtsProvider["speak"]>[1][] = [];
  const spoken: string[] = [];
  const states: PlaybackUpdate[] = [];
  const visited: string[] = [];
  let paused = false;
  let stopped = 0;
  const provider: TtsProvider = {
    isAvailable: () => true,
    speak: (text, callback) => { spoken.push(text); callbacks.push(callback); },
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    stop: () => { stopped += 1; },
  };
  const controller = new NarrationController(provider, update => states.push(update), (segment?: NarrationSegment) => { if (segment) visited.push(segment.snapshotId ?? ""); });
  const explanation = buildIssueExplanation("message-1", finding, fixture.snapshots);
  controller.play(explanation);
  assert.equal(visited.length, 0, "keep the current snapshot while audio prepares");
  callbacks[0].onStart?.();
  assert.equal(visited[0], "snapshot-original-maker");
  controller.pause(); assert(paused);
  controller.resume(); assert(!paused);
  callbacks[0].onEnd();
  assert.equal(visited.length, 1, "next segment also waits for audio");
  callbacks[1].onStart?.();
  assert.equal(visited[1], "snapshot-original-bank");
  controller.stop();
  callbacks[1].onEnd();
  assert.equal(visited.length, 2, "stale callback must not advance after stop");
  controller.replay();
  callbacks[2].onStart?.();
  assert.equal(visited[2], "snapshot-original-maker");
  assert(spoken.length === 3 && stopped >= 2);
  assert(states.some(state => state.status === "paused"));
  controller.stop();
});

test("written evidence remains navigable when browser speech is unavailable", () => {
  const visited: string[] = [];
  const updates: PlaybackUpdate[] = [];
  const provider: TtsProvider = { isAvailable: () => false, speak: () => assert.fail("speech must not start"), pause: () => {}, resume: () => {}, stop: () => {} };
  const controller = new NarrationController(provider, update => updates.push(update), segment => { if (segment?.snapshotId) visited.push(segment.snapshotId); });
  controller.play(buildIssueExplanation("message-1", finding, fixture.snapshots));
  assert.deepEqual(visited, ["snapshot-original-maker"]);
  assert.equal(updates.at(-1)?.status, "unavailable");
});

test("captions wait for playback and ignore stale or paused word boundaries", () => {
  let callbacks: Parameters<TtsProvider["speak"]>[1];
  const updates: PlaybackUpdate[] = [];
  const provider: TtsProvider = { isAvailable: () => true, speak: (_text, next) => { callbacks = next; }, pause() {}, resume() {}, stop() {} };
  const controller = new NarrationController(provider, update => updates.push(update), () => {});
  const explanation = buildIssueExplanation("caption-test", finding, fixture.snapshots);
  controller.play(explanation);
  assert.equal(updates.at(-1)?.caption, "");
  callbacks!.onStart?.();
  assert.equal(updates.at(-1)?.caption, explanation.segments[0].text);
  callbacks!.onBoundary?.(12);
  assert.equal(updates.at(-1)?.spokenCharIndex, 12);
  controller.pause();
  const pausedCount = updates.length;
  callbacks!.onBoundary?.(20);
  assert.equal(updates.length, pausedCount);
  controller.resume();
  callbacks!.onBoundary?.(20);
  assert.equal(updates.at(-1)?.spokenCharIndex, 20);
  controller.stop();
  const stoppedCount = updates.length;
  callbacks!.onStart?.(); callbacks!.onBoundary?.(30);
  assert.equal(updates.length, stoppedCount);
});

test("conversational narration waits for the operator before advancing", () => {
  let callbacks: Parameters<TtsProvider["speak"]>[1];
  const updates: PlaybackUpdate[] = [];
  const visited: string[] = [];
  const provider: TtsProvider = { isAvailable: () => true, speak: (_text, next) => { callbacks = next; }, pause() {}, resume() {}, stop() {} };
  const controller = new NarrationController(provider, update => updates.push(update), segment => { if (segment) visited.push(segment.id); });
  controller.play(buildIssueExplanation("dialogue-test", finding, fixture.snapshots), 0, false);
  callbacks!.onStart?.();
  callbacks!.onEnd();
  assert.equal(updates.at(-1)?.status, "awaiting_input");
  assert.equal(visited.length, 1);
  controller.continue();
  callbacks!.onStart?.();
  assert.equal(visited.length, 2);
  controller.stop();
  controller.continue();
  assert.equal(visited.length, 2);
});

import { buildSpokenReply } from "../narration/spoken-reply";
test("chat replies play all chunks then yield for a spoken follow-up",()=>{
 const callbacks: {onEnd:()=>void}[]=[]; const states: PlaybackUpdate[]=[];
 const provider: TtsProvider={isAvailable:()=>true,speak:(_text,callback)=>callbacks.push(callback),pause:()=>{},resume:()=>{},stop:()=>{}};
 const controller=new NarrationController(provider,update=>states.push(update),()=>{});
 const reply=buildSpokenReply("answer","The record names Client B. ".repeat(100));
 assert(reply.segments.length>1);assert(reply.segments.every(segment=>segment.text.length<=1400));
 controller.play(reply,0,true,true);
 for(let i=0;i<reply.segments.length;i++){callbacks[i].onEnd();if(i<reply.segments.length-1)assert.equal(states.at(-1)?.status,"playing");}
 assert.equal(states.at(-1)?.status,"awaiting_input");
 controller.stop();callbacks.at(-1)!.onEnd();assert.equal(states.at(-1)?.status,"idle");
});
test("spoken replies retain the answer without markdown or raw snapshot UUIDs",()=>{
 const reply=buildSpokenReply("answer","**Client B** owns reference B-204. See 12345678-abcd-abcd-abcd-123456789abc-snapshot-3.");
 assert.equal(reply.segments[0].text,"Client B owns reference B two zero four. See snapshot 3.");
});

import { parseChatSections } from "../../../apps/visual-audit-dev/lib/chat-sections";
test("snapshot replies preserve requested order and reject invented evidence", () => {
  const first = fixture.snapshots.find(item => item.annotations?.length)!;
  const second = fixture.snapshots.find(item => item.id !== first.id && item.annotations?.length)!;
  const answer = parseChatSections(JSON.stringify({sections:[
    {snapshotId:second.id,text:"Start with this evidence.",annotationIds:[second.annotations![0].id,first.annotations![0].id,"invented"]},
    {snapshotId:first.id,text:"Then examine the earlier record.",annotationIds:[first.annotations![0].id]},
  ]}), fixture.snapshots);
  assert.deepEqual(answer.snapshotIds,[second.id,first.id]);
  const spoken = buildSpokenReply("ordered",answer.text,answer.sections,fixture.snapshots);
  assert.deepEqual(spoken.segments.map(item=>item.snapshotId),answer.snapshotIds);
  assert.deepEqual(spoken.segments[0].highlightIds,[second.annotations![0].id]);
  assert.equal(spoken.segments[0].evidenceRefs[0],second.annotations![0].evidenceRef);
  assert.throws(()=>parseChatSections('{"sections":[{"snapshotId":"other-tenant","text":"Wrong"}]}',fixture.snapshots));
  assert.throws(()=>parseChatSections('{"sections":[',fixture.snapshots));
});

test("continuous audio changes snapshots at word boundaries without another generation",()=>{
  const spoken:string[]=[],visited:string[]=[],updates:PlaybackUpdate[]=[];
  let callbacks:Parameters<TtsProvider["speak"]>[1];
  const provider:TtsProvider={continuous:true,isAvailable:()=>true,speak:(text,next)=>{spoken.push(text);callbacks=next;},pause(){},resume(){},stop(){}};
  const controller=new NarrationController(provider,u=>updates.push(u),s=>{if(s)visited.push(s.id);});
  const explanation={id:"continuous",messageId:"message",segments:[
    {id:"agreement",text:"Read the agreement.",evidenceRefs:[],highlightIds:[]},
    {id:"statement",text:"Compare the statement.",evidenceRefs:[],highlightIds:[]},
    {id:"check",text:"Payment is held.",evidenceRefs:[],highlightIds:[]},
  ]};
  controller.play(explanation,0,true,true);
  expectSingleTrack();
  assert.deepEqual(visited,[],"continuous track must be ready before navigation");
  callbacks!.onStart?.();callbacks!.onBoundary?.(5);
  assert.equal(updates.at(-1)?.segmentIndex,0);
  controller.pause();callbacks!.onBoundary?.(20);assert.equal(updates.at(-1)?.segmentIndex,0);
  controller.resume();callbacks!.onBoundary?.(20);
  assert.equal(visited.at(-1),"statement");assert.equal(updates.at(-1)?.spokenCharIndex,0);
  callbacks!.onBoundary?.(43);assert.equal(visited.at(-1),"check");
  callbacks!.onEnd();assert.equal(updates.at(-1)?.status,"awaiting_input");expectSingleTrack();
  controller.stop();callbacks!.onBoundary?.(0);assert.equal(updates.at(-1)?.status,"idle");
  function expectSingleTrack(){assert.deepEqual(spoken,["Read the agreement. Compare the statement. Payment is held."]);}
});
