"use client";
import {useQuery} from "convex/react";
import {api} from "../../../../convex/_generated/api";
export interface VisualAuditFrameProps {runId:string;stepIndex:number;snapshotId:string|null}
export function PlatformEvidenceFrame({runId,stepIndex,snapshotId}:VisualAuditFrameProps) {
 const view=useQuery(api.financeDesk.getRunView,{runId});
 const snapshots=useQuery(api.finance.listTaskSnapshots,view?{taskId:view.run.taskId}:"skip");
 const saved=snapshots?.find(s=>s.snapshotId===snapshotId);
 return <section className="platform-record-frame" aria-label="Recorded snapshot"><header><span>Snapshot {stepIndex+1}</span><h2>{view?.steps[stepIndex]?.message||"Recorded observation"}</h2></header>{saved?<><dl><div><dt>Action</dt><dd>{view?.steps[stepIndex]?.type.replace(/^finance\./,"").replaceAll("."," ")}</dd></div><div><dt>Status</dt><dd>{saved.output.investigationStatus.replaceAll("_"," ")}</dd></div></dl>{"result" in saved.output && saved.output.result?.findings.map(f=><p key={f.findingId}>{f.summary}</p>)}<details><summary>JSON view</summary><pre>{JSON.stringify(saved,null,2)}</pre></details></>:<p>{snapshots===undefined?"Loading the recorded snapshot":"No snapshot was saved for this event."}</p>}</section>;
}
