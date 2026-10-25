import {NextRequest,NextResponse,after} from "next/server";
import {assertLocalAccess} from "../../../../lib/local-access";
import {startDemo,executeDemo} from "../../../../lib/erp-demo";
export const runtime="nodejs";
export const maxDuration=120;
export async function POST(request:NextRequest){try{assertLocalAccess(request);const {action}=await request.json();const state=await startDemo(action);if(action!=="reset")after(()=>executeDemo(action,state.sessionId));return NextResponse.json(state,{status:202});}catch(e){return NextResponse.json({error:(e as Error).message},{status:409});}}
