import "server-only";
import {createHash} from "node:crypto";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {artifactDirectory} from "./local-store";
import {demoAudioTexts} from "./demo-conversation";
import {atomicRename} from "./atomic-rename";

export function demoAudioCachePath(text:string,model:string,voice:string|undefined,timestamps:boolean|undefined) {
  if(!demoAudioTexts.includes(text))return;
  const key=createHash("sha256").update(JSON.stringify({v:1,text,model,voice,timestamps:!!timestamps})).digest("hex");
  return path.join(artifactDirectory(),"demo-audio",key+".bin");
}
export async function readDemoAudio(file:string|undefined) {
  if(!file)return;
  try{return new Uint8Array(await readFile(file));}catch{return;}
}
export async function saveDemoAudio(file:string,bytes:Uint8Array) {
  await mkdir(path.dirname(file),{recursive:true});const temp=file+"."+crypto.randomUUID()+".tmp";await writeFile(temp,bytes);await atomicRename(temp,file);
}
