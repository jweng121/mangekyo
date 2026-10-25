import React from "react";
import {renderToString} from "react-dom/server";
import {it,expect} from "vitest";
import {SnapshotBranchGraph} from "../../../packages/visual-audit/components/SnapshotBranchGraph";
import type {Snapshot} from "../../../packages/contracts";
const snapshot=(id:string,sequence:number,flagged=false)=>({id,sequence,title:id,executionStatus:"completed",auditStatus:flagged?"flagged":"clear",actionType:"READ"}) as Snapshot;
it("keeps the error red, supersedes only its suffix, and completes the corrected path",()=>{
 const original=[snapshot("bank",1),snapshot("error",2),snapshot("draft",3),snapshot("audit",4,true)];
 const corrected=[snapshot("reread",1),snapshot("corrected-draft",2),snapshot("validated",3)];
 const html=renderToString(<SnapshotBranchGraph original={original} corrected={corrected} conflictId="error" selectedId="draft" onSelect={()=>{}}/>);
 expect((html.match(/Superseded Snapshot/g)??[]).length).toBe(2);
 expect((html.match(/completed corrected/g)??[]).length).toBe(3);
 expect(html).toContain('history-node selected superseded');
 expect(html).toContain('history-superseded');
 expect(html).toContain('Flagged checkpoint: Snapshot 2: error');
});
it("does not turn a failed corrected checkpoint green",()=>{
 const html=renderToString(<SnapshotBranchGraph original={[snapshot("error",1,true)]} corrected={[snapshot("still-conflicting",1,true)]} onSelect={()=>{}}/>);
 expect(html).toContain('conflict corrected');
 expect(html).not.toContain('completed corrected');
});

it("does not retire the original path while a correction is running or failed",()=>{
 for(const correctedStatus of ["running","failed"]) {
  const html=renderToString(<SnapshotBranchGraph original={[snapshot("error",1,true),snapshot("old-draft",2)]} corrected={[snapshot("reread",1)]} correctedStatus={correctedStatus} onSelect={()=>{}}/>);
  expect(html).not.toContain('Superseded Snapshot');
  expect(html).not.toContain('branch-success');
 }
});
