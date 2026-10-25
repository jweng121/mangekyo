import "server-only";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import {artifactDirectory,readInvestigation} from "./local-store";
import {evidenceWorker} from "./evidence-worker";
import {bankStatement,type AgentDefinition,type OrchestratorMessage,type WorkspaceData} from "./workspace-data";
const file=()=>path.join(artifactDirectory(),"..","workspace.json");
type State={agents:AgentDefinition[];messages:OrchestratorMessage[]};
let queue=Promise.resolve();
export async function workspaceState():Promise<State>{try{return JSON.parse(await readFile(file(),"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return {agents:[],messages:[]};}}
export function updateWorkspace(change:(state:State)=>void){const next=queue.then(async()=>{const state=await workspaceState();change(state);await mkdir(path.dirname(file()),{recursive:true});const temp=file()+"."+crypto.randomUUID()+".tmp";await writeFile(temp,JSON.stringify(state));await rename(temp,file());});queue=next.catch(()=>{});return next;}
export async function readWorkspace():Promise<WorkspaceData>{
  const [source,record,state]=await Promise.all([
    evidenceWorker<Pick<WorkspaceData,"clients"|"drafts">>({action:"workspace",databasePath:path.join(artifactDirectory(),"..","trust-ledger.sqlite")}),readInvestigation(),workspaceState(),
  ]);
  return {bank:bankStatement,...source,record,...state};
}
