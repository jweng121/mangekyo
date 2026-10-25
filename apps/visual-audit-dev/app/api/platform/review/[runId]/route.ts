import { NextRequest, NextResponse } from "next/server";
import { readPlatformReview, platformClient } from "../../../../../lib/platform-client";
import { assertLocalAccess } from "../../../../../lib/local-access";
import { api } from "../../../../../../../convex/_generated/api";
import { appendChatMessage } from "../../../../../lib/local-store";
export const runtime="nodejs";
type Context={params:Promise<{runId:string}>};
export async function GET(request:NextRequest,context:Context) {try {assertLocalAccess(request);return NextResponse.json((await readPlatformReview((await context.params).runId)).record);}catch(error){return NextResponse.json({error:(error as Error).message},{status:503});}}
export async function POST(request:NextRequest,context:Context) {try {
  assertLocalAccess(request);
  const requestedRunId=(await context.params).runId;
  const body=await request.json();
  if(body.action!=="steer" || typeof body.instruction!=="string" || body.instruction.trim().length<12 || body.instruction.length>2000 || !["cite_clarification","checker_wrong","add_document"].includes(body.choice)) return NextResponse.json({error:"Choose a correction type and provide an instruction."},{status:400});
  const {record}=await readPlatformReview(requestedRunId);
  const runId=record.platformReview?.runId??requestedRunId;
  const {current}=await readPlatformReview(runId);
  if(current.run.status!=="checker_rejected") return NextResponse.json({error:"This run is not awaiting a checker correction. Review its required action on the overview."},{status:409});
  const result=await platformClient().mutation(api.financeInvestigations.correctAndRerun,{runId,choice:body.choice,note:body.instruction,dev:{role:"approver",name:"sam"}});
  const createdAt=new Date().toISOString();
  await appendChatMessage({id:crypto.randomUUID(),runId,role:"user",text:body.instruction,snapshotIds:[],provider:"local",createdAt});
  await appendChatMessage({id:crypto.randomUUID(),runId,role:"assistant",text:"Correction sent to Trust Intake. A new attempt has started; review its recorded result before approving any financial action.",snapshotIds:[],provider:"local",createdAt});
  return NextResponse.json({runId:result.runId,record:(await readPlatformReview(result.runId)).record});
}catch(error){return NextResponse.json({error:(error as Error).message},{status:500});}}
