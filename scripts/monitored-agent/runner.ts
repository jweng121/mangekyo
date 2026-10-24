import {chromium} from "playwright";
import {record,saveCapture,deliverCapture,type CaptureContext} from "./capture";
const baseUrl=process.env.DEMO_ERP_BASE_URL||"http://localhost:3001";
const scenario=process.argv[2]||"B";
const parentRunId=process.env.MANGEKYO_PARENT_RUN_ID;
const instruction=process.env.MANGEKYO_STEERING_INSTRUCTION||"";
const runId=process.env.MANGEKYO_RUN_ID||`demo-${scenario.toLowerCase()}-${Date.now()}`;
async function main(){const browser=await chromium.launch({headless:process.env.MANGEKYO_BROWSER_HEADLESS!=="false"});const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});const ctx:CaptureContext={page,runId,taskId:`allocation-${scenario}`,branchId:parentRunId?`branch-${runId}`:"main",agentId:"demo-scripted-001",parentRunId,events:[],snapshots:[],baseUrl};try{
 const tx=scenario==="A"?"TX-001":scenario==="D"?"TX-013":"TX-002";
 await page.goto(`${baseUrl}/transactions`);await page.getByTestId(`transaction-row-${tx}`).getByRole("link",{name:tx}).click();
 await record(ctx,page.getByTestId("transaction-reference"),"[data-testid=transaction-reference]","READ","Read payment reference");
 await record(ctx,page.getByTestId("transaction-owner"),"[data-testid=transaction-owner]","READ","Read possible recipient");
 if(scenario==="B"||scenario==="F"){await page.getByRole("link",{name:"INV-001"}).click();await record(ctx,page.getByTestId("invoice-client"),"[data-testid=invoice-client]","READ","Read related invoice client");await page.goto(`${baseUrl}/transactions/${tx}`)}
 await page.getByRole("link",{name:/Open DOC-/}).click();
 const docSelector=scenario==="A"?"payment-tx-001-recipient":scenario==="D"?"payment-tx-012-reference":"brookstone-beneficiary-beneficiary";
 await record(ctx,page.getByTestId(docSelector),`[data-testid=${docSelector}]`,"READ","Read document beneficiary");
 if(scenario==="C"){await page.goto(`${baseUrl}/documents/DOC-MULTI-001`);await record(ctx,page.getByTestId("company-x-section-revenue"),"[data-testid=company-x-section-revenue]","READ","Read Company X revenue");const extra={scenario,extractedValue:ctx.snapshots.at(-1)?.observation.fields[0].value};const file=await saveCapture(ctx,extra);const delivery=await deliverCapture(ctx,extra);console.log(JSON.stringify({file,delivery,runId,observations:ctx.snapshots.length,extractedValue:extra.extractedValue},null,2));return}
 await page.goto(`${baseUrl}/transactions/${tx}`);
 const owner=scenario==="A"?"Client A — Alder Trust":scenario==="D"?"Client D — Dunlin Trust":instruction.toLowerCase().includes("client b")?"Client B — Brookstone Trust":"Client A — Alder Trust";
 await page.getByTestId("proposed-owner").selectOption({label:owner});await page.getByPlaceholder("Cite the payment reference or document").fill(instruction||`Deterministic ${scenario} decision based on observed records`);await page.getByTestId("allocation-submit").click();await page.getByTestId("allocation-result").waitFor();const result=await record(ctx,page.getByTestId("allocation-result"),"[data-testid=allocation-result]","PROPOSE","Allocation proposal result");
 const escalation=result.value.includes("Rejected")?{id:`${runId}-escalation`,runId,taskId:ctx.taskId,agentId:ctx.agentId,transactionId:tx,snapshotId:ctx.snapshots.find(s=>s.title==="Read document beneficiary")?.id||result.snapshot.id,proposalSnapshotId:result.snapshot.id,reason:result.value,evidence:ctx.snapshots.filter(s=>s.actionType==="READ").flatMap(s=>s.evidence)}:undefined;
 if(escalation)result.snapshot.auditStatus="needs_review";
 const extra={scenario,steeringInstruction:instruction,escalation};const file=await saveCapture(ctx,extra);const delivery=await deliverCapture(ctx,extra);console.log(JSON.stringify({file,delivery,runId,parentRunId,proposal:result.value,escalation,observations:ctx.snapshots.length},null,2));
 }finally{await browser.close()}}
main().catch(e=>{console.error(e);process.exitCode=1});
