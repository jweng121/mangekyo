import { NextRequest, NextResponse } from "next/server";
import { readPlatformReview } from "../../../../../../lib/platform-client";
import { assertLocalAccess } from "../../../../../../lib/local-access";
import { auditProvider } from "../../../../../../lib/audit-provider";
import { appendChatMessage } from "../../../../../../lib/local-store";
import type { InvestigationChatMessage } from "../../../../../../../../packages/contracts";
export const runtime="nodejs";
export async function POST(request:NextRequest,context:{params:Promise<{runId:string}>}) {try {
 assertLocalAccess(request);const body=await request.json();
 if(typeof body.question!=="string" || !body.question.trim() || body.question.length>2000 || (body.conversationId!==undefined && (typeof body.conversationId!=="string"||body.conversationId.length>100)) || (body.conversationTitle!==undefined && (typeof body.conversationTitle!=="string"||body.conversationTitle.length>80))) return NextResponse.json({error:"Invalid question or conversation."},{status:400});
 const {record}=await readPlatformReview((await context.params).runId);
 const selected=record.snapshots.find(s=>s.id===body.snapshotId);
 if(!selected)return NextResponse.json({error:"Select a saved snapshot from this run."},{status:400});
 record.chatMessages=record.chatMessages.filter(m=>(m.conversationId??"default")===(body.conversationId??"default"));
 const answer=await auditProvider().answer(body.question,selected,record),createdAt=new Date().toISOString();
 const shared={runId:selected.runId,createdAt,conversationId:body.conversationId,conversationTitle:body.conversationTitle};
 const user:InvestigationChatMessage={...shared,id:crypto.randomUUID(),role:"user",text:body.question,snapshotIds:[selected.id],provider:"local"};
 const assistant:InvestigationChatMessage={...shared,id:crypto.randomUUID(),role:"assistant",...answer};
 await appendChatMessage(user);await appendChatMessage(assistant);return NextResponse.json({user,assistant});
 }catch(error){return NextResponse.json({error:(error as Error).message},{status:500});}}
