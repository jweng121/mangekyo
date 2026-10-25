import {NextRequest,NextResponse} from "next/server";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fixture,fixtureRoot} from "../../../../../lib/erp-demo";
import {assertLocalAccess} from "../../../../../lib/local-access";
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{assertLocalAccess(request);const {id}=await params;const doc=(await fixture("documents")).find(d=>d.id===id);if(!doc)return new NextResponse("Not found",{status:404});return new NextResponse(await readFile(path.join(fixtureRoot,doc.pdf)),{headers:{"Content-Type":"application/pdf","Content-Disposition":`inline; filename="${doc.id}.pdf"`}});}catch{return new NextResponse("Document unavailable",{status:404});}}
