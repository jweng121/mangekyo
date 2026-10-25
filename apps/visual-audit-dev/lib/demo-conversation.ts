import type {InvestigationRecord, Snapshot, SnapshotChatSection} from "../../../packages/contracts";

export const demoLines = {
  welcome:"Hey, let's get started. Anything you want to address first?",
  overview:["Ana's settlement is on hold because two documents disagree on her fee. Her agreement takes 25% after litigation costs.","The distribution statement instead uses the gross amount.","That overcharges Ana by $33,750. No funds have been released."],
  confirm:["You're right. Her agreement takes the 25% fee after costs.","This draft took it before costs, so Ana would be overcharged $33,750."],
  correct:"I've prepared that correction. Select Correct decision to rerun the agent and save a revised draft. Payment will stay on hold pending signatures and approval.",
};
export const demoAudioTexts = [demoLines.welcome,...[demoLines.overview,demoLines.confirm].map(lines=>lines.join(" ")),demoLines.correct];
export const heldFeeInstruction = "Recalculate Ana Bello's fee after deducting allocated litigation costs. Save a corrected held draft. Keep payment blocked until revised documents are signed and separately approved.";

/** Rehearsed copy is used only when this exact synthetic case still supports it. */
export function demoConversation(question:string, selected:Snapshot, record:InvestigationRecord) {
  let run=record.runs.find(r=>r.id===selected.runId);
  const seen=new Set<string>();
  while(run?.parentRunId&&!seen.has(run.id)){seen.add(run.id);run=record.runs.find(r=>r.id===run!.parentRunId);}
  if(!run?.taskId.startsWith("hartwell-")||run.parentRunId||run.status!=="escalated")return;
  const q=question.toLowerCase();
  const wantsCorrection=/\b(recalculate|re-?run)\b|let'?s correct|^correct (that|her|the)/.test(q)&&/\b(fee|costs?|decision|draft|that)\b/.test(q);
  if(record.runs.some(r=>r.parentRunId===run.id&&r.status!=="failed")&&!wantsCorrection)return;
  const snapshots=record.snapshots.filter(s=>s.runId===run.id);
  const find=(id:string)=>snapshots.find(s=>s.documentId===id);
  const agreement=find("fee-c03"),statement=find("settlement-v1.pdf"),check=find("fee-basis-check"),proposal=find("proposed-distribution"),draft=find("settlement_drafts");
  const math=check?.observation.record?.rows[0],allocation=proposal?.observation.record?.rows[0],saved=draft?.observation.record?.rows[0];
  if(!agreement||!statement||!check||!proposal||math?.excessCents!==3375000||math.correctFeeCents!==90375000||math.proposedFeeCents!==93750000||allocation?.client!=="Ana Bello"||allocation.grossCents!==375000000||allocation.costCents!==13500000||saved?.status!=="held"||Boolean(saved.ledgerPosted))return;
  if(!agreement.observation.fields.some(f=>/25%.*net.*after.*cost/i.test(f.value)))return;
  if(!statement.observation.fields.some(f=>/25% of gross/i.test(f.value)&&f.value.includes("$937,500.00")))return;
  if(/\b(don't|do not|not yet|cancel)\b/.test(q))return;
  const section=(snapshot:Snapshot,text:string):SnapshotChatSection=>({snapshotId:snapshot.id,text,annotationIds:snapshot.annotations?.slice(0,1).map(a=>a.id)??[]});
  let sections:SnapshotChatSection[];
  let correction: {snapshotId:string;instruction:string}|undefined;
  if(wantsCorrection){
    sections=[{text:demoLines.correct,annotationIds:[]}];
    correction={snapshotId:proposal.id,instruction:heldFeeInstruction};
  }else if(/quick read|snapshots of misalignment|quick overview/.test(q)){
    sections=[section(agreement,demoLines.overview[0]),section(statement,demoLines.overview[1]),section(check,demoLines.overview[2])];
  }else if(/gross/.test(q)&&/cost/.test(q)&&/fee|calculated|agreement/.test(q)){
    sections=[section(agreement,demoLines.confirm[0]),section(statement,demoLines.confirm[1])];
  }else return;
  return {text:sections.map(s=>s.text).join("\n\n"),sections,snapshotIds:sections.flatMap(s=>s.snapshotId?[s.snapshotId]:[]),provider:"local" as const,correction};
}
