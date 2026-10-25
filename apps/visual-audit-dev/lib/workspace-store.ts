import {atomicRename} from "./atomic-rename";
import "server-only";
import {demoWorkspace} from "./erp-demo";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {artifactDirectory,readInvestigation} from "./local-store";
import {escalationCases,type AgentDefinition,type OrchestratorMessage,type WorkspaceData} from "./workspace-data";
const file=()=>path.join(artifactDirectory(),"..","workspace.json");
type State={agents:AgentDefinition[];messages:OrchestratorMessage[]};
let queue=Promise.resolve();
export async function workspaceState():Promise<State>{try{return JSON.parse(await readFile(file(),"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return {agents:[],messages:[]};}}
export function updateWorkspace(change:(state:State)=>void){const next=queue.then(async()=>{const state=await workspaceState();change(state);await mkdir(path.dirname(file()),{recursive:true});const temp=file()+"."+crypto.randomUUID()+".tmp";await writeFile(temp,JSON.stringify(state));await atomicRename(temp,file());});queue=next.catch(()=>{});return next;}
export async function readWorkspace():Promise<WorkspaceData>{
  const [source,record,state]=await Promise.all([demoWorkspace(),readInvestigation(),workspaceState()]);
  if(source.simulation.escalationRunId && escalationCases(record).some(c=>c.run.id===source.simulation.escalationRunId&&c.completed))source.simulation.step="Correction completed. Distribution held for signatures and payment approval.";
  return {...source,record,...state,storage:{workspace:"local",investigations:process.env.NEXT_PUBLIC_VISUAL_AUDIT_MODE==="convex"?"convex":"local",platformConvexConfigured:!!process.env.NEXT_PUBLIC_PLATFORM_CONVEX_URL}};
}
