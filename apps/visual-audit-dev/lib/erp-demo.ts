import {atomicRename} from "./atomic-rename";
import "server-only";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import type {InvestigationRun,Snapshot,AgentEvent,RecordEvidence,SteeringRequest} from "../../../packages/contracts";
import {artifactDirectory,localTenantId,addRun,updateRun,appendAudit,appendCheckpoint,savePdf,saveScreenshot,readInvestigation,saveReport} from "./local-store";
import {captureStructuredCheckpoint} from "./capture-agent";
import {capturePdfRead} from "./pdf-evidence";
import {evidenceWorker} from "./evidence-worker";
import {checkSettlement,ownerBalances,initialImportBatches,type BankRow,type DemoState} from "./erp-demo-model";
export const fixtureRoot=path.resolve(process.cwd(),"../../packages/finance-core/fixtures/hartwell");
export async function fixture<T=any[]>(name:string):Promise<T>{return JSON.parse(await readFile(path.join(fixtureRoot,"erp",name+".json"),"utf8"));}
const file=()=>path.join(artifactDirectory(),"..","erp-simulation.json");
let queue=Promise.resolve();
const initial=():DemoState=>({phase:"disconnected",sessionId:"",runIds:[],imported:0,step:"Connect the ERP to begin"});
export async function demoState():Promise<DemoState>{try{const state:DemoState=JSON.parse(await readFile(file(),"utf8"));if(["connecting","receiving"].includes(state.phase)&&state.updatedAt&&Date.now()-Date.parse(state.updatedAt)>120000)return {...state,phase:"failed",step:"Demo interrupted",error:"The server stopped processing. Restart the demo to replay the import."};return state}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return initial();}}
async function updateDemo(fn:(state:DemoState)=>void){const task=queue.then(async()=>{const state=await demoState();fn(state);state.updatedAt=new Date().toISOString();await mkdir(path.dirname(file()),{recursive:true});const tmp=file()+".tmp";await writeFile(tmp,JSON.stringify(state));await atomicRename(tmp,file());});queue=task.catch(()=>{});await task;return demoState();}
const dollars=(cents:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);
const pause=()=>new Promise(resolve=>setTimeout(resolve,1800));
export async function startDemo(action:string){
 return updateDemo(s=>{
  if(action==="reset"){Object.assign(s,initial());delete s.escalationRunId;delete s.error;
  }else if(action==="connect"){
   if(s.phase!=="disconnected")throw new Error("ERP is already connected. Use incoming data for the next batch.");
   Object.assign(s,{phase:"connecting",sessionId:crypto.randomUUID(),step:"Connecting to Hartwell ERP",runIds:[],imported:0});
  }else if(action==="incoming"){
   if(s.phase!=="connected")throw new Error("Finish connecting the ERP before importing the next batch.");
   s.phase="receiving";s.step="Receiving settlement documents and bank post";
  }else throw new Error("Unknown simulation action");
 });
}
async function run(name:string,agentId:string,sessionId:string):Promise<InvestigationRun>{const r:InvestigationRun={id:crypto.randomUUID(),schemaVersion:1,tenantId:localTenantId(),taskId:"hartwell-"+agentId,agentId,displayName:name,branchId:"original",createdAt:new Date().toISOString(),status:"running"};await addRun(r);try{await updateDemo(s=>{if(s.sessionId!==sessionId)throw new Error("Demo reset");s.runIds.push(r.id)});}catch(error){await updateRun(r.id,{status:"failed"});throw error;}return r;}
async function records(r:InvestigationRun,sequence:number,resource:string,rows:any[],summary:string,actionType:Snapshot["actionType"]="READ",auditStatus:Snapshot["auditStatus"]="unreviewed"){
 const flat=rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,typeof value==="object"&&value!==null?JSON.stringify(value):value]))) as RecordEvidence["rows"];
 const exported=["bank-transactions","incoming-items"].includes(resource);
 const record:RecordEvidence={system:exported?"Hartwell ERP / fixture export":"Hartwell demo / derived records",currency:"USD",resource,operation:"read",status:actionType==="PROPOSE"?"proposed":"succeeded",filters:{},columns:(resource==="bank-transactions"?["id","postedDate","description","amountCents","balanceCents"]:Object.keys(flat[0]??{}).slice(0,6)).map(key=>({key,label:key.replace(/Cents$/," (USD)").replace(/([a-z])([A-Z])/g,"$1 $2").replace(/^./,letter=>letter.toUpperCase()),align:key.endsWith("Cents")?"right":undefined})),rows:flat,rowCount:rows.length,truncated:false,executedAt:new Date().toISOString()};
 return captureStructuredCheckpoint({run:r,sequence,actionType,auditStatus,executionStatus:actionType==="ESCALATE"?"blocked":"completed",title:({"bank-transactions":"Bank deposit","proposed-distribution":"Distribution proposal","corrected-distribution":"Corrected proposal","fee-basis-check":"Fee check","human-review":"Human review"} as Record<string,string>)[resource]??resource.replaceAll("-"," ").replace(/^./,c=>c.toUpperCase()),summary,documentId:resource,documentVersion:createHash("sha256").update(JSON.stringify(rows)).digest("hex"),toolCall:exported?`Read ERP export ${resource}.json`:`Evaluate ${resource} from imported ERP evidence`,toolResponse:JSON.stringify(rows),observation:{label:resource,record,fields:[{id:"result",label:"Recorded result",value:summary}],output:{source:exported?"ERP fixture export":"Derived from recorded ERP evidence",operation:actionType==="PROPOSE"?"Proposed distribution / not executed":"Read"}}});
}
async function savedDraft(r:InvestigationRun,sequence:number,feeCents:number,clientCents:number){
 const row={id:r.id,client:"Ana Bello",feeCents,clientCents,status:"held",ledgerPosted:false,supersedes:r.parentRunId};
 const databasePath=path.join(artifactDirectory(),"..","hartwell-simulation.sqlite");
 const result=await evidenceWorker<{record:RecordEvidence}>({action:"settlement_draft",databasePath,row});
 return captureStructuredCheckpoint({run:r,sequence,actionType:"WRITE_CONFIRMED",title:"Distribution draft saved",summary:`Saved a held distribution draft: ${dollars(feeCents)} in fees and ${dollars(clientCents)} to Ana Bello. No payment was released.`,documentId:"settlement_drafts",documentVersion:r.id,toolCall:"INSERT INTO settlement_drafts (id, client, feeCents, clientCents, status, ledgerPosted)",toolResponse:JSON.stringify(result),observation:{label:"Settlement draft",record:result.record,fields:[{id:"fee",label:"Attorney fee",value:dollars(feeCents)},{id:"client",label:"Client proceeds",value:dollars(clientCents)},{id:"status",label:"Payment status",value:"Held / not posted"}]}});
}
async function agreementSnapshot(r:InvestigationRun,sequence:number){
 const bytes=await readFile(path.join(fixtureRoot,"documents/fee-c03.pdf"));
 // This scanned PDF ships with Edwin's text companion. Preserve that provenance;
 // do not claim that a text parser or live OCR extracted the raster page.
 const text=await readFile(path.join(fixtureRoot,"documents/fee-c03.txt"),"utf8");
 if(!text.includes("NET recovery after deduction"))throw new Error("Fee agreement text changed; review the scenario");
 const rendered=await evidenceWorker<{pngBase64:string;dimensions:{width:number;height:number};pageCount:number}>({action:"pdf",bytes:bytes.toString("base64"),renderOnly:true});
 const pdf=await savePdf(bytes),png=await saveScreenshot(Buffer.from(rendered.pngBase64,"base64"));
 const id=`${r.id}-snapshot-${sequence}`,eventId=`${r.id}-event-${sequence}`,timestamp=new Date().toISOString();
 const summary="Ana Bello's signed agreement requires a 25% fee after her share of costs is deducted. The agent must use the net recovery, not the gross allocation.";
 const event:AgentEvent={id:eventId,schemaVersion:1,runId:r.id,taskId:r.taskId,agentId:r.agentId,agentRole:r.agentId,sequence,timestamp,actionType:"READ",title:"Signed fee agreement",summary,parentEventIds:[`${r.id}-event-${sequence-1}`],branchId:r.branchId,snapshotId:id,status:"completed"};
 const snapshot:Snapshot={id,eventId,schemaVersion:1,runId:r.id,taskId:r.taskId,agentId:r.agentId,agentRole:r.agentId,sequence,timestamp,actionType:"READ",title:event.title,summary,parentSnapshotId:`${r.id}-snapshot-${sequence-1}`,documentId:"fee-c03",documentVersion:"fixture-scan-with-text-companion",source:"fee-c03.pdf + supplied fee-c03.txt",sourceDocument:{url:`/api/visual-audit/documents/${pdf}`,filename:"fee-c03.pdf",mimeType:"application/pdf",sha256:createHash("sha256").update(bytes).digest("hex"),pageNumber:1,pageCount:rendered.pageCount,extraction:"provided-transcript"},screenshot:{url:`/api/visual-audit/artifacts/${png}`,provenance:"actual",artifactId:png,alt:"Original scanned Ana Bello fee agreement",capturedAt:timestamp},screenshotDimensions:rendered.dimensions,observation:{kind:"document",label:"Signed agreement / supplied text companion",documentText:text,fields:[{id:"basis",label:"Fee basis",value:"25% of NET recovery after deduction of allocated litigation costs"}]},readTargets:["Signed fee basis"],writeTargets:[],evidence:[{id:id+"-basis",label:"Signed fee basis",source:"fee-c03.txt (supplied transcript of fee-c03.pdf)",value:text}],instructionVersion:"hartwell-demo-1",policyVersion:"hold-distributions-1",executionStatus:"completed",auditStatus:"unreviewed"};
 await appendCheckpoint(event,snapshot);return snapshot;
}
async function settlementEvidence(r:InvestigationRun){
 const transactions=await fixture<BankRow[]>("bank-transactions");const deposit=transactions.find(t=>t.id==="harborline-deposit")!;
 await records(r,1,"bank-transactions",[deposit],"The ERP recorded a $125,000 settlement deposit from Harborline. It belongs to a joint matter with three separate client allocations.");await pause();
 await capturePdfRead({bytes:await readFile(path.join(fixtureRoot,"documents/allocation-global.pdf")),filename:"allocation-global.pdf",run:r,sequence:2,title:"Signed client allocation",field:"allocation",label:"Bello allocation and costs",pattern:"Ana Bello: [^\n]*",summary:"The signed allocation gives Ana Bello $25,000, with $900 in shared litigation costs."});await pause();
 await agreementSnapshot(r,3);await pause();
 await capturePdfRead({bytes:await readFile(path.join(fixtureRoot,"documents/settlement-v1.pdf")),filename:"settlement-v1.pdf",run:r,sequence:4,title:"Signed distribution statement",field:"fee",label:"Bello distribution",pattern:"20% / 25% of gross[^\n]*",summary:"The signed statement lists a $6,250 fee and $17,850 to Ana Bello. It calculates the fee on gross recovery, before costs."});await pause();
 const allocation=(await fixture("allocation-agreements"))[0].allocations.find((a:any)=>a.clientId==="c03");
 const agreement=(await fixture("fee-agreements")).find((a:any)=>a.clientId==="c03");
 const statement=(await fixture("settlement-statements")).find((s:any)=>s.id==="settlement-v1");
 const proposedFee=statement.lines.find((l:any)=>l.clientId==="c03"&&l.kind==="attorney_fee").amountCents;
 return {allocation,agreement,proposedFee,check:checkSettlement(allocation,agreement,proposedFee)};
}
export async function executeDemo(action:string,sessionId:string){
 const mutate=(fn:(s:DemoState)=>void)=>updateDemo(s=>{if(s.sessionId!==sessionId)throw new Error("Demo reset");fn(s)});
 let active:InvestigationRun|undefined;
 const queued:InvestigationRun[]=[];
 try{
  const all=await fixture<BankRow[]>("bank-transactions");const boundary=all.findIndex(row=>row.id==="harborline-deposit");if(boundary<1)throw new Error("Settlement bank post missing");
  if(action==="connect"){
   const batches=initialImportBatches(all);
   const connection=await run("Connect IOLTA account 4417","bank-sync-agent",sessionId);queued.push(connection);
   const batchRuns:InvestigationRun[]=[];
   for(const batch of batches){const label=new Date(batch.month+"-01T12:00:00Z").toLocaleDateString("en-US",{month:"long",year:"numeric",timeZone:"UTC"});const job=await run(`${label} / ${batch.transactions.length} transactions`,"transaction-import-agent",sessionId);queued.push(job);batchRuns.push(job);}
   const documentRun=await run("Index source documents","document-indexing-agent",sessionId);queued.push(documentRun);
   const ledgerRun=await run("Reconcile client ledgers","ledger-reconciliation-agent",sessionId);queued.push(ledgerRun);
   active=connection;await pause();
   await records(active,1,"connection",[{account:"IOLTA 4417",source:"Hartwell ERP fixture",mode:"Demo replay"}],"Opened the ERP demo source. Queued transaction imports, source document indexing, and ledger reconciliation.");await pause();await updateRun(active.id,{status:"completed"});
   let imported=0;
   for(let index=0;index<batches.length;index++){
    const batch=batches[index];active=batchRuns[index];
    await records(active,1,"bank-transactions",batch.transactions,`Read ${batch.transactions.length} posted bank transactions for ${batch.month}. Importing the recorded amounts and client allocations.`);
    await pause();imported+=batch.transactions.length;
    await mutate(s=>{s.imported=imported;s.step=`Imported ${imported} bank transactions`});
    await records(active,2,"import-result",[{month:batch.month,transactions:batch.transactions.length,status:"Imported",newPayments:0}],`Imported ${batch.transactions.length} existing ERP bank posts. No new payments were created.`);
    await updateRun(active.id,{status:"completed"});
   }
   const baseline=all.slice(0,boundary),documentIds=new Set(baseline.flatMap(row=>row.documentIds));
   active=documentRun;
   const manifest=(await fixture("documents")).filter((document:any)=>documentIds.has(document.id));
   if(manifest.length!==documentIds.size)throw new Error("An imported transaction is missing its source document");
   await records(active,1,"document-manifest",manifest.map((document:any)=>({id:document.id,title:document.title,date:document.date,format:"PDF"})),`Reading the source manifest for ${manifest.length} supporting documents.`);await pause();
   const files=await Promise.all(manifest.map(async(document:any)=>{const bytes=await readFile(path.join(fixtureRoot,document.pdf));if(bytes.subarray(0,5).toString()!=="%PDF-")throw new Error(`Invalid PDF: ${document.id}`);return {id:document.id,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};}));
   await records(active,2,"document-index",files,`Indexed ${files.length} source PDFs and verified their file hashes. Document content has not been approved by this indexing step.`);await updateRun(active.id,{status:"completed"});
   active=ledgerRun;
   const clients=await fixture("clients");const balances=ownerBalances(baseline);
   await records(active,1,"client-balances",Object.entries(balances).map(([clientId,balanceCents])=>({clientId,client:clients.find((c:any)=>c.id===clientId)?.name??clientId,balanceCents})),`Read balances for ${Object.keys(balances).length} client ledgers. Reconciling them against imported trust cash.`);await pause();
   const total=baseline.reduce((n,r)=>n+r.amountCents,0);
   const journal=(await fixture("trust-ledger-entries")).filter((entry:any)=>baseline.some(row=>row.id===entry.transactionId));
   if(total!==baseline.at(-1)!.balanceCents||Object.values(balances).reduce((n,v)=>n+v,0)!==total||journal.length!==baseline.length||journal.some((entry:any)=>entry.lines.reduce((n:number,line:any)=>n+line.debitCents-line.creditCents,0)!==0))throw new Error("Imported cash and client journals do not reconcile");
   await records(active,2,"ledger-reconciliation",[{account:"IOLTA 4417",cashCents:total,clientLiabilityCents:total,balancedJournals:journal.length}],`Reconciled ${journal.length} balanced journal entries and client liabilities to ${dollars(total)} in trust cash. This verifies totals; it does not approve historical transactions or perform a full compliance audit.`);
   await updateRun(active.id,{status:"completed"});
   await mutate(s=>{s.phase="connected";s.step="ERP connected. Ready for incoming data."});
  }else{
   active=await run("Harborline settlement received","settlement-intake-agent",sessionId);await pause();
   await mutate(s=>{s.imported=boundary+1;s.step="New bank post imported: $125,000 settlement"});
   await records(active,1,"incoming-items",(await fixture("incoming-items")).filter((r:any)=>r.id==="incoming-global"),"Received settlement draft 902174 and its existing ERP bank post. Added $125,000 to the imported cash balance.");await pause();await updateRun(active.id,{status:"completed"});
   active=await run("Ana Bello / Settlement fee review","settlement-distribution-agent",sessionId);await pause();
   const {allocation,proposedFee,check}=await settlementEvidence(active);
   const proposal=await records(active,5,"proposed-distribution",[{client:"Ana Bello",grossCents:allocation.amountCents,costCents:allocation.costCents,feeCents:proposedFee,clientCents:allocation.amountCents-allocation.costCents-proposedFee}],"The distribution agent carried forward the signed statement's $6,250 fee. That uses the gross allocation before costs.","PROPOSE");await pause();
   await savedDraft(active,6,proposedFee,allocation.amountCents-allocation.costCents-proposedFee);await pause();
   if(check.excessCents<=0)throw new Error("Scenario no longer contains the expected fee discrepancy");
   const explanation=`Ana Bello's fee is overstated by ${dollars(check.excessCents)}. The signed agreement requires 25% of ($25,000 minus $900): ${dollars(check.feeCents)}, leaving ${dollars(check.clientCents)} for the client.`;
   await records(active,7,"fee-basis-check",[{proposedFeeCents:proposedFee,correctFeeCents:check.feeCents,excessCents:check.excessCents,release:"Held for human review"}],explanation,"AUDIT","flagged");
   await records(active,8,"human-review",[{client:"Ana Bello",status:"Needs escalation",taskedAgent:active.agentId,release:"No payment released"}],"The fee discrepancy needs human review. Compare the agreement with the statement, then direct a corrected draft. Updated signatures and payment approval remain separate.","ESCALATE","needs_review");
   const findingId=crypto.randomUUID();await appendAudit({id:findingId,schemaVersion:1,runId:active.id,snapshotId:proposal.id,category:"risky_write",severity:"high",explanation,evidence:(await readInvestigation()).snapshots.filter(s=>s.runId===active!.id&&s.sequence<=5).flatMap(s=>s.evidence),suggestedAction:"Recalculate the fee after costs. Hold payment until the corrected statement is signed and approved.",reviewStatus:"open",reviewedThroughSequence:8},{id:crypto.randomUUID(),findingId,snapshotId:proposal.id,runId:active.id,status:"open",createdAt:new Date().toISOString()});
   await updateRun(active.id,{status:"escalated"});await mutate(s=>{s.phase="escalated";s.escalationRunId=active!.id;s.step="Ana Bello's distribution needs human review"});
  }
 }catch(e){const current=await readInvestigation();for(const job of queued)if(current.runs.some(r=>r.id===job.id&&r.status==="running"))await updateRun(job.id,{status:"failed"});if(active&&!queued.some(job=>job.id===active!.id))await updateRun(active.id,{status:"failed"});if((await demoState()).sessionId!==sessionId)return;await mutate(s=>{s.phase="failed";s.error=(e as Error).message;s.step="Simulation stopped"});}
}
export async function correctSettlement(parent:InvestigationRun,steering:SteeringRequest){
 if(!/net|cost|6025|6,025/i.test(steering.instruction))throw new Error("For this demo, direct the agent to calculate the fee after costs. Other corrections require a different workflow.");
 const corrected:InvestigationRun={...parent,id:crypto.randomUUID(),parentRunId:parent.id,steeringId:steering.id,branchId:"corrected",status:"running",createdAt:new Date().toISOString()};await addRun(corrected);await updateDemo(s=>{s.runIds.push(corrected.id)});
 try{
  const {check}=await settlementEvidence(corrected);
  await records(corrected,5,"corrected-distribution",[{client:"Ana Bello",feeCents:check.feeCents,clientCents:check.clientCents}],"Recalculated the fee after $900 in costs: $6,025. Ana Bello's proceeds increase to $18,075.","PROPOSE");
  await savedDraft(corrected,6,check.feeCents,check.clientCents);
  await records(corrected,7,"fee-basis-check",[{feeCents:check.feeCents,agreesWithContract:true,paymentReleased:false}],"The corrected fee agrees with the signed fee basis. The new distribution draft remains held for signatures and payment approval.","AUDIT","clear");
  await updateRun(corrected.id,{status:"corrected"});
  const report={id:crypto.randomUUID(),version:1,runId:parent.id,correctedRunId:corrected.id,taskId:parent.taskId,agentId:parent.agentId,escalationSnapshotId:steering.checkpointSnapshotId,steeringRequestId:steering.id,status:"draft" as const,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),authorId:"mangekyo-local-auditor",content:`Ana Bello settlement fee corrected from $6,250 to $6,025 using the signed net-after-costs agreement. Client proceeds: $18,075. Operator instruction: ${steering.instruction}. A new held draft was saved; no payment was posted. Supersedes the prior draft for this review only. Updated client signatures and separate payment approval are still required.`,evidenceSnapshotIds:(await readInvestigation()).snapshots.filter(s=>s.runId===corrected.id).map(s=>s.id),remainingUncertainty:"Corrected settlement signatures and payment authorization are outstanding. This review covers Bello's fee only."};
  await saveReport(report);return {steering,corrected:{...corrected,status:"corrected"},report,record:await readInvestigation()};
 }catch(e){await updateRun(corrected.id,{status:"failed"});throw e;}
}
export async function demoWorkspace(){
 const state=await demoState();const [all,clients,documents,invoices]=await Promise.all([fixture<BankRow[]>("bank-transactions"),fixture("clients"),fixture("documents"),fixture("invoices")]);
 const rows=all.slice(0,state.imported),balances=ownerBalances(rows),incoming=rows.some(r=>r.id==="harborline-deposit");
 const ids=new Set(rows.flatMap(r=>r.documentIds));if(incoming)for(const id of ["fee-c03","settlement-v1","allocation-global"])ids.add(id);
 const docs=documents.filter((d:any)=>ids.has(d.id));
 const drafts=await evidenceWorker<{drafts:any[]}>({action:"settlement_workspace",databasePath:path.join(artifactDirectory(),"..","hartwell-simulation.sqlite")});
 return {simulation:state,bank:{currency:"USD",account:"IOLTA 4417",opening:0,closing:rows.reduce((n,r)=>n+r.amountCents,0)/100,transactions:rows.map(r=>({id:r.id,date:r.postedDate,reference:r.description,amount:r.amountCents/100,balance:r.balanceCents/100,code:r.clientId,documentId:r.documentIds[0]}))},clients:clients.filter((c:any)=>c.id in balances).map((c:any)=>({id:c.id,name:c.name,legal:c.name,code:c.id,trust:"Hartwell & Moreno / IOLTA",invoice:"",amount:"",account:"liability:"+c.id,balance:balances[c.id]/100})),drafts:drafts.drafts.filter(d=>state.runIds.includes(d.id)||d.sessionId===state.sessionId).map(d=>({id:d.id,bankLine:"harborline-deposit",client:d.client,legalEntity:d.client,liabilityAccount:"liability:c03",invoice:"settlement-v1",amount:(d.clientCents/100).toFixed(2),currency:"USD",status:d.status,ledgerPosted:0,createdAt:d.createdAt})),documents:docs.map((d:any)=>({id:d.id,name:d.title,date:d.date,kind:d.kind,href:"/api/workspace/documents/"+d.id})),invoices:invoices.filter((i:any)=>ids.has(i.documentId))};
}
