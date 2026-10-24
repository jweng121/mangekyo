import {NextRequest,NextResponse} from "next/server";
import {mutate,activity} from "../../../lib/store";
export async function POST(request:NextRequest){const body=await request.json();if(typeof body.target!=="string"||typeof body.runId!=="string")return NextResponse.json({error:"target and runId required"},{status:400});await mutate(state=>activity(state,"tool","Browser read",`${body.target}: ${String(body.value||"").slice(0,200)}`,body.runId));return NextResponse.json({ok:true})}
