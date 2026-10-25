import {NextRequest,NextResponse} from "next/server";
import {assertLocalAccess} from "../../../lib/local-access";
import {readWorkspace,updateWorkspace} from "../../../lib/workspace-store";
export const runtime="nodejs";
export async function GET(request:NextRequest){try{assertLocalAccess(request);return NextResponse.json(await readWorkspace(),{headers:{"Cache-Control":"no-store"}});}catch(e){return NextResponse.json({error:(e as Error).message},{status:500});}}
export async function POST(request:NextRequest){try{
 assertLocalAccess(request);const body=await request.json();
 if(body.action!=="create_agent" || typeof body.name!=="string" || !body.name.trim() || body.name.length>80 || typeof body.instructions!=="string" || body.instructions.trim().length<12 || body.instructions.length>4000)return NextResponse.json({error:"Add an agent name and instructions (12–4,000 characters)."},{status:400});
 const agent={id:crypto.randomUUID(),name:body.name.trim(),instructions:body.instructions.trim(),createdAt:new Date().toISOString(),status:"draft" as const};
 await updateWorkspace(s=>{s.agents.push(agent);s.messages.push({id:crypto.randomUUID(),role:"assistant",text:`Created ${agent.name} as a read-only analyst. Its instructions are saved. Run its analysis from Agents; it has no permission to move funds.`,createdAt:agent.createdAt});});return NextResponse.json({agent});
 }catch(e){return NextResponse.json({error:(e as Error).message},{status:500});}}
