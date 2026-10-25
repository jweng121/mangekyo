import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";
import type { FinanceSnapshot, InvestigationRecord, Snapshot } from "../../../packages/contracts";
export type PlatformRunView = NonNullable<FunctionReturnType<typeof api.financeDesk.getRunView>>;
const iso = (timestamp: number) => new Date(timestamp).toISOString();
const words = (value: string) => value.replace(/^finance\./, "").replace(/[._]/g, " ").replace(/^./, c=>c.toUpperCase());
const labels: Record<string,string> = { "finance.checks.completed":"Source checks", "finance.provider.result_received":"Agent response", "finance.checker.completed":"Evidence check", "finance.investigation.started":"Investigation", "finance.evidence.retrieved":"Source records", "finance.provider.started":"Agent started", "finance.provider.completed":"Agent response", "finance.claims.checked":"Evidence check", "finance.investigation.completed":"Outcome", "finance.investigation.failed":"Run stopped", "finance.question.asked":"Human review", "finance.proposal.created":"Allocation proposal" };

/** A presentation adapter over saved records. Never manufactures screenshots or writes. */
export function platformRecord(views: PlatformRunView[], saved: FinanceSnapshot[]): InvestigationRecord {
  const record: InvestigationRecord={runs:[],events:[],snapshots:[],findings:[],escalations:[],chatMessages:[],steeringRequests:[],reports:[],memoryRecords:[]};
  const ids = new Set(views.map(view=>view.run.runId));
  for (const view of views) {
    const run=view.run, input=run.providerInput;
    const stopped=run.status==="checker_rejected" || run.status==="failed" || run.status==="needs_information";
    const parent=run.parentRunId && ids.has(run.parentRunId) ? run.parentRunId : undefined;
    const deposit=input?.records.transactions[0];
    const name=deposit ? `${new Intl.NumberFormat("en-US",{style:"currency",currency:deposit.currency}).format(deposit.amountCents/100)} / ${deposit.description}` : "Trust investigation";
    record.runs.push({id:run.runId,displayName:name,schemaVersion:1,tenantId:view.accountId??run.caseId,taskId:run.taskId,agentId:"trust-intake-agent",branchId:parent?"corrected":"original",parentRunId:parent,createdAt:iso(run.createdAt),status:stopped?"escalated":run.status==="completed"?parent?"corrected":"completed":"running"});
    for (const [index,step] of view.steps.filter(step => step.type !== "finance.snapshot.captured").entries()) {
      const stored=saved.find(item=>item.snapshotId===step.snapshotId);
      // Events without snapshots are explicitly represented as recorded events.
      const id=stored?.snapshotId ?? `event:${step.eventId}`;
      const output=stored?.output;
      const flagged=step.status==="checker_rejected"||step.status==="failed"||step.type.includes("question.asked");
      const fields=[{id:"event",label:"Recorded action",value:step.message || words(step.type)},
        ...(output ? [{id:"status",label:"Status",value:words(output.investigationStatus)}] : []),
        ...(output && "result" in output && output.result ? output.result.findings.map(f=>({id:f.findingId,label:"Agent finding",value:f.summary})) : []),
        ...(output && "claimCheck" in output && output.claimCheck ? output.claimCheck.claims.map(c=>({id:`check:${c.findingId}`,label:words(c.verdict),value:c.sourceSays ? `${c.claim} / Source: ${c.sourceSays}. ${c.reason}` : `${c.claim}. ${c.reason}`})) : []),
        ...(step.type.includes("evidence.retrieved") && input ? [
          ...input.records.transactions.map(t=>({id:t.sourceId,label:"Bank transaction",value:`${t.description} / ${t.amountCents/100} ${t.currency}`})),
          ...input.records.documents.map(d=>({id:d.sourceId,label:d.title,value:d.text})),
          ...input.records.invoices.map(i=>({id:i.sourceId,label:"Invoice",value:i.excerpt})),
        ] : []),
      ];
      const action: Snapshot["actionType"]=flagged?"ESCALATE":step.type.includes("proposal")?"PROPOSE":step.type.includes("check")?"AUDIT":"READ";
      const evidence=fields.map(f=>({id:`${id}:${f.id}`,label:f.label,source:stored?"Saved platform snapshot":"Saved platform event",field:f.id,value:f.value}));
      const snapshot: Snapshot={id,schemaVersion:1,eventId:step.eventId,runId:run.runId,taskId:run.taskId,agentId:"trust-intake-agent",agentRole:"Trust Intake",timestamp:iso(step.timestamp),sequence:index+1,actionType:action,title:labels[step.type]??words(step.type),summary:step.message||words(step.type),observation:{kind:"api",label:stored?"Recorded snapshot":"Recorded event",fields:fields.map((f,i)=>({...f,sourceRef:evidence[i].id})),output:{...(output?{status:output.investigationStatus}:{}),provenance:stored?"Saved atomically with the event":"No snapshot saved for this event"}},source:"Platform / Convex",readTargets:[],writeTargets:[],evidence,annotations:fields.map((field,i)=>({id:`${id}:annotation:${i}`,snapshotId:id,evidenceRef:evidence[i].id,label:field.label,fieldPath:`observation.fields.${field.id}`})),instructionVersion:input?.instructionVersion??"recorded",policyVersion:"recorded",executionStatus:"completed",auditStatus:flagged?"flagged":"unreviewed"};
      record.snapshots.push(snapshot);
    }
    if(stopped) {
      const last=record.snapshots.filter(s=>s.runId===run.runId).at(-1);
      if(last) { const findingId=`${run.runId}:platform-finding`;
        const explanation=run.claimCheck?.claims.find(c=>c.verdict==="not_supported")?.reason??run.error?.message??run.result?.questions[0]?.question??"This run needs operator review.";
        record.findings.push({id:findingId,schemaVersion:1,runId:run.runId,snapshotId:last.id,category:"missing_evidence",severity:"high",explanation,evidence:last.evidence,suggestedAction:"Review the recorded evidence and provide a correction.",reviewStatus:"open",reviewedThroughSequence:last.sequence});
        record.escalations.push({id:`${run.runId}:escalation`,findingId,runId:run.runId,snapshotId:last.id,status:"open",createdAt:iso(run.updatedAt)});
      }
    }
  }
  return record;
}
