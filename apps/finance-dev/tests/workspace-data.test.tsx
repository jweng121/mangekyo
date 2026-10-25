import {describe,it,expect} from "vitest";
import {currentWorkspaceRecord,bankStatement,escalationCases,runReviewStatus} from "../../visual-audit-dev/lib/workspace-data";
import type {InvestigationRecord} from "../../../packages/contracts";
describe("Harbor Trust workspace",()=>{
 it("reconciles every statement row to its recorded closing balance",()=>{
   let balance=bankStatement.opening;
   for(const transaction of bankStatement.transactions){balance+=transaction.amount;expect(balance).toBe(transaction.balance)}
   expect(balance).toBe(bankStatement.closing);
   expect(bankStatement.transactions.filter(t=>t.amount>0).reduce((sum,t)=>sum+t.amount,0)).toBe(15350);
 });
 it("keeps reruns out of the escalation count and preserves resolved history",()=>{
   const record={runs:[{id:"a",taskId:"1042",agentId:"matching-agent"},{id:"b",taskId:"1042",agentId:"matching-agent",parentRunId:"a"},{id:"c",taskId:"1042",agentId:"matching-agent"}],escalations:[{runId:"a",status:"open"},{runId:"b",status:"open"},{runId:"c",status:"resolved"}],findings:[],snapshots:[{runId:"a"}]} as unknown as InvestigationRecord;
   const cases=escalationCases(record);expect(cases.map(c=>c.run.id)).toEqual(["a","c"]);expect(cases.filter(c=>c.open)).toHaveLength(1);expect(cases[0].snapshots).toBe(1);
 });
 it("moves only the latest successful correction to Completed",()=>{
   const record={runs:[{id:"a",taskId:"bank-line-1042",agentId:"deposit-matching-agent",status:"escalated",createdAt:"1"},{id:"b",parentRunId:"a",status:"corrected",createdAt:"2"}],escalations:[{runId:"a",status:"open"}],findings:[],snapshots:[{runId:"b",actionType:"AUDIT",auditStatus:"clear",executionStatus:"completed"}]} as unknown as InvestigationRecord;
   expect(escalationCases(record)[0]).toMatchObject({completed:true,open:false,agent:"Deposit matching agent",workflow:"Deposit ownership"});
   expect(runReviewStatus(record,"a")).toBe("Completed");
   record.runs.push({...record.runs[1],id:"c",parentRunId:"b",status:"failed",createdAt:"3"});
   expect(escalationCases(record)[0]).toMatchObject({completed:false,open:true});
   record.runs[2].status="corrected";
   record.findings.push({runId:"c",reviewStatus:"open"} as InvestigationRecord["findings"][number]);
   expect(escalationCases(record)[0].completed).toBe(false);
 });
 it("separates queued agent work, processing, and human escalations",()=>{
   const record={runs:[{id:"queue",status:"running"},{id:"work",status:"running"},{id:"human",status:"escalated"}],escalations:[],findings:[],snapshots:[{runId:"work"}]} as unknown as InvestigationRecord;
   expect(runReviewStatus(record,"queue")).toBe("Needs review");
   expect(runReviewStatus(record,"work")).toBe("Processing");
   expect(runReviewStatus(record,"human")).toBe("Needs escalation");
 });
});

it("keeps archived simulations out of the current queue while retaining correction descendants",()=>{
 const record={runs:[{id:"old"},{id:"current"},{id:"child",parentRunId:"current"},{id:"grandchild",parentRunId:"child"}]} as InvestigationRecord;
 const simulation={phase:"connected",sessionId:"session",runIds:["current"],imported:1,step:""} as const;
 expect(currentWorkspaceRecord(record,{...simulation,runIds:[...simulation.runIds]}).runs.map(r=>r.id)).toEqual(["current","child","grandchild"]);
 expect(currentWorkspaceRecord(record,{...simulation,runIds:[]}).runs).toEqual([]);
 expect(record.runs).toHaveLength(4);
});
