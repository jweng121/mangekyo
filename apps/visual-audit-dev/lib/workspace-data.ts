import type { InvestigationRecord } from "../../../packages/contracts";

// The four rows and balances in the current Harbor Trust bank statement fixture.
export const bankStatement = {
  currency: "CAD", account: "HT-4821", opening: 128450, closing: 141350,
  transactions: [
    { id: "1040", date: "2026-10-22", reference: "Y-407 / Dune retainer", amount: 7100, balance: 135550, code: "Y-407" },
    { id: "1041", date: "2026-10-22", reference: "TR-1022 / Client disbursement", amount: -2450, balance: 133100, code: null },
    { id: "1042", date: "2026-10-23", reference: "B-204 / Beacon deposit", amount: 5000, balance: 138100, code: "B-204" },
    { id: "1043", date: "2026-10-23", reference: "X-310 / Cedar deposit", amount: 3250, balance: 141350, code: "X-310" },
  ],
};
export type WorkspaceClient = {id:string;name:string;legal:string;code:string;trust:string;invoice:string;amount:string;account:string};
export type AllocationDraft = {id:string;bankLine:string;client:string;legalEntity:string;liabilityAccount:string;invoice:string;amount:string;currency:string;status:string;ledgerPosted:number;createdAt:string};
export type AgentDefinition = {id:string;name:string;instructions:string;createdAt:string;status:"draft"};
export type OrchestratorMessage = {id:string;role:"user"|"assistant";text:string;createdAt:string};
export type WorkspaceData = {bank:typeof bankStatement;clients:WorkspaceClient[];drafts:AllocationDraft[];record:InvestigationRecord;agents:AgentDefinition[];messages:OrchestratorMessage[]};
export function escalationCases(record:InvestigationRecord) {
  return record.runs.filter(run=>!run.parentRunId && record.escalations.some(e=>e.runId===run.id)).map(run=>{
    const family=new Set([run.id]);
    for(let pass=0;pass<record.runs.length;pass++)for(const attempt of record.runs)if(attempt.parentRunId&&family.has(attempt.parentRunId))family.add(attempt.id);
    const latest=record.runs.filter(r=>family.has(r.id)).sort((a,b)=>(a.createdAt??"").localeCompare(b.createdAt??"")).at(-1)!;
    const blocked=record.findings.some(f=>f.runId===latest.id&&f.reviewStatus==="open") || record.escalations.some(e=>e.runId===latest.id&&e.status==="open");
    const validated=record.snapshots.some(s=>s.runId===latest.id && s.actionType==="AUDIT" && s.auditStatus==="clear" && s.executionStatus==="completed") || record.reports?.some(r=>r.correctedRunId===latest.id);
    const corrected=latest.id!==run.id && latest.status==="corrected" && !!validated && !blocked;
    const resolved=!record.escalations.some(e=>e.runId===run.id&&e.status==="open");
    const completed=corrected || (resolved && !blocked && (latest.id===run.id || !["running","failed","escalated"].includes(latest.status)));
    return {run,latest,completed,open:!completed,
    outcome:record.snapshots.filter(s=>s.runId===latest.id).sort((a,b)=>a.sequence-b.sequence).at(-1)?.summary,
    agent:run.agentId.replaceAll(/[-_]/g," ").replace(/^./,letter=>letter.toUpperCase()),
    workflow:run.taskId==="bank-line-1042"?"Deposit ownership":run.agentId==="trust-records-agent"?"Client record validation":run.taskId.replaceAll(/[-_]/g," ").replace(/^./,letter=>letter.toUpperCase()),
    finding:record.findings.find(f=>f.runId===run.id),
    snapshots:record.snapshots.filter(s=>s.runId===run.id).length,
  };});
}
export function runReviewStatus(record:InvestigationRecord,runId:string) {
  const run=record.runs.find(r=>r.id===runId);
  const root=escalationCases(record).find(c=>c.run.id===runId);
  if(root?.completed)return "Completed";
  if(record.escalations.some(e=>e.runId===runId&&e.status==="open")||record.findings.some(f=>f.runId===runId&&f.reviewStatus==="open")||run?.status==="escalated")return "Needs escalation";
  if(run?.status==="running")return record.snapshots.some(s=>s.runId===runId)?"Processing":"Needs review";
  if(run?.status==="failed")return "Failed";
  return "Completed";
}
