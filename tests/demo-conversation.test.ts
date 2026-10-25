import {describe,it,expect} from "vitest";
import type {InvestigationRecord,Snapshot} from "../packages/contracts";
import {demoConversation,demoLines} from "../apps/visual-audit-dev/lib/demo-conversation";
function fixture(){
  const sources=[
    {documentId:"fee-c03",observation:{fields:[{value:"25% of NET recovery after deduction of allocated litigation costs"}]}},
    {documentId:"settlement-v1.pdf",observation:{fields:[{value:"25% of gross $937,500.00"}]}},
    {documentId:"fee-basis-check",observation:{fields:[],record:{rows:[{excessCents:3375000,correctFeeCents:90375000,proposedFeeCents:93750000}]}}},
    {documentId:"proposed-distribution",observation:{fields:[],record:{rows:[{client:"Ana Bello",grossCents:375000000,costCents:13500000}]}}},
    {documentId:"settlement_drafts",observation:{fields:[],record:{rows:[{status:"held",ledgerPosted:0}]}}},
  ];
  return {runs:[{id:"original",taskId:"hartwell-settlement",status:"escalated"}],snapshots:sources.map((s,i)=>({...s,id:String(i),runId:"original",annotations:[{id:`annotation-${i}`}]}))} as unknown as InvestigationRecord;
}
describe("rehearsed settlement conversation",()=>{
  it("returns the exact requested confirmation with document navigation",()=>{
    const record=fixture();const answer=demoConversation("It looks like the agent calculated Ana's fee using the gross settlement instead of deducting costs",record.snapshots[2],record)!;
    expect(answer.text.replace(/\s+/g," ")).toBe(demoLines.confirm.join(" "));
    expect(answer.snapshotIds).toEqual(["0","1"]);
  });
  it("prepares a held correction without claiming execution",()=>{
    const record=fixture();const answer=demoConversation("Okay let's correct that. Recalculate her fee after costs and keep payment on hold",record.snapshots[2],record)!;
    expect(answer.correction?.snapshotId).toBe("3");expect(answer.correction?.instruction).toContain("separately approved");
    expect(answer.text).toContain("Select Correct decision");expect(record.runs).toHaveLength(1);
  });
  it("never reuses scripted facts after the amounts or run state change",()=>{
    const record=fixture(),selected=record.snapshots[2];
    selected.observation.record!.rows[0].excessCents=22500;
    expect(demoConversation("quick read",selected,record)).toBeUndefined();
    const corrected=fixture();corrected.runs.push({id:"child",parentRunId:"original",status:"corrected"} as InvestigationRecord["runs"][number]);
    expect(demoConversation("quick read",corrected.snapshots[0],corrected)).toBeUndefined();
  });
  it("leaves unrelated or cancelled requests to the normal assistant",()=>{
    const record=fixture();
    for(const question of ["What is the client's name?","Do not recalculate her fee yet"])
      expect(demoConversation(question,record.snapshots[0],record)).toBeUndefined();
  });
});
