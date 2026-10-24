import {mkdir,readFile,rename,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createSeed,type State} from "../data/seed";
const file=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.data/state.json");
let queue=Promise.resolve();
export async function readState():Promise<State>{try{return JSON.parse(await readFile(file,"utf8"))}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;const state=createSeed(Number(process.env.DEMO_ERP_SEED||42));await saveState(state);return state}}
export async function saveState(state:State){await mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(state,null,2));await rename(temp,file)}
export async function mutate<T>(fn:(state:State)=>T|Promise<T>):Promise<T>{const run=queue.then(async()=>{const state=await readState();const result=await fn(state);await saveState(state);return result});queue=run.then(()=>undefined,()=>undefined);return run}
export async function resetState(seed=42){return mutate(async state=>{Object.assign(state,createSeed(seed));return state})}
export function activity(state:State,kind:"tool"|"business",action:string,detail:string,runId?:string){state.activity.unshift({id:`ACT-${String(state.activity.length+1).padStart(4,"0")}`,at:new Date().toISOString(),kind,action,detail,runId})}
