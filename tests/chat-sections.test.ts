import {describe, it, expect} from "vitest";
import type {Snapshot} from "../packages/contracts";
import {parseChatSections} from "../apps/visual-audit-dev/lib/chat-sections";

const snapshots = [{id:"agreement", annotations:[{id:"fee-clause"}]}] as Snapshot[];
const answer = JSON.stringify({sections:[{snapshotId:"agreement",text:"The fee is calculated after costs.",annotationIds:["fee-clause","invented"]}]});

describe("chat response envelopes", () => {
  it.each([answer, "```json\n"+answer+"\n```", '<invoke name="respond">\n'+answer+'\n</invoke>'])("preserves verified navigation for supported formatting", raw => {
    const result = parseChatSections(raw, snapshots);
    expect(result.snapshotIds).toEqual(["agreement"]);
    expect(result.sections[0].annotationIds).toEqual(["fee-clause"]);
    expect(result.text).toBe("The fee is calculated after costs.");
  });
  it.each(['<invoke name="respond">'+answer, '<invoke name="execute">'+answer+'</invoke>', answer.slice(0,-3), 'Additional text '+answer])("rejects incomplete or unexpected content", raw => {
    expect(()=>parseChatSections(raw,snapshots)).toThrow("incomplete answer");
  });
  it("still rejects unavailable evidence inside the envelope", () => {
    expect(()=>parseChatSections('<invoke name="respond">'+answer.replace('agreement','missing')+'</invoke>',snapshots)).toThrow("unavailable evidence");
  });
});
