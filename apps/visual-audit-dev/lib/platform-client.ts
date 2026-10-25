import "server-only";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";
import { platformRecord, type PlatformRunView } from "./platform-record";
import { readInvestigation } from "./local-store";
export function platformClient() {
  const url=process.env.NEXT_PUBLIC_PLATFORM_CONVEX_URL;
  if(!url) throw new Error("Connect the platform with NEXT_PUBLIC_PLATFORM_CONVEX_URL.");
  const client=new ConvexHttpClient(url);
  if(process.env.MANGEKYO_PLATFORM_AUTH_TOKEN) client.setAuth(process.env.MANGEKYO_PLATFORM_AUTH_TOKEN);
  return client;
}
export async function readPlatformReview(runId:string) {
  const client=platformClient();
  const current=await client.query(api.financeDesk.getRunView,{runId});
  if(!current) throw new Error("This platform run was not found.");
  const [other,saved,local]=await Promise.all([
    Promise.all(current.runs.filter(run=>run.runId!==runId).map(run=>client.query(api.financeDesk.getRunView,{runId:run.runId}))),
    client.query(api.finance.listTaskSnapshots,{taskId:current.run.taskId}),readInvestigation(),
  ]);
  const views=[current,...other.filter((view):view is PlatformRunView=>!!view)].sort((a,b)=>a.run.attempt-b.run.attempt);
  const record=platformRecord(views,saved);
  const ids=new Set(record.runs.map(run=>run.id));
  record.chatMessages=local.chatMessages.filter(message=>ids.has(message.runId));
  record.steeringRequests=local.steeringRequests.filter(request=>ids.has(request.parentRunId));
  const latest=views.at(-1)!;
  const overview=latest.accountId ? await client.query(api.financeIntake.getAccountOverview,{accountId:latest.accountId}) : null;
  const proposals=overview?.proposals.filter(p=>p.origin.type==="agent" && p.origin.runId===latest.run.runId)??[];
  const resolved=proposals.length>0 && proposals.every(p=>p.status==="posted");
  record.platformReview={runId:latest.run.runId,accountId:latest.accountId,canCorrect:latest.run.status==="checker_rejected",status:resolved?"resolved":["checker_rejected","failed","needs_information"].includes(latest.run.status)?"needs_review":latest.run.status==="completed"?"ready_for_approval":"running"};
  if(resolved) {
    record.escalations=record.escalations.map(e=>({...e,status:"resolved"}));
    record.findings=record.findings.map(f=>({...f,reviewStatus:"resolved"}));
    const id=`platform-resolved:${latest.run.runId}`;
    if(!record.chatMessages.some(m=>m.id===id)) {
      const message={id,runId:record.runs[0].id,role:"assistant" as const,text:"Marked as resolved. The corrected allocation was approved and posted through the platform's financial controls.",snapshotIds:[],provider:"local" as const,createdAt:new Date().toISOString()};
      const {appendChatMessage}=await import("./local-store");await appendChatMessage(message);record.chatMessages.push(message);
    }
  }
  return {record,current};
}
