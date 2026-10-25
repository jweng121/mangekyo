"use client";

import { useState, type FormEvent } from "react";
import type { FinanceCaseBundle, FinanceTask, HumanClarification, InvestigationScope, InvestigationStartScope, TaskInvestigationView } from "@mangekyo/contracts";
import { investigationPeriod } from "../investigationPeriod";

export interface FinanceProviderConfiguration { mode: "mock" | "creao" | "external" | null; configured: boolean; message: string }
/** What is being investigated: the legacy synthetic case or an intake deposit task. */
export interface InvestigationSubject {
  task: FinanceTask;
  accountId: string;
  currency: string;
  evidence: Array<{ sourceId: string; text: string }>;
  scopeKinds: InvestigationScope["kind"][];
}

export function subjectFromCase(data: FinanceCaseBundle): InvestigationSubject {
  return {
    task: data.task, accountId: "synthetic-bank-account-001", currency: data.transaction.currency,
    evidence: [{ sourceId: data.document.sourceId, text: data.document.excerpt }, { sourceId: data.transaction.sourceId, text: data.transaction.description }],
    scopeKinds: ["deposit_investigation", "historical_onboarding"],
  };
}

interface Props {
  subject: InvestigationSubject;
  investigation: TaskInvestigationView | undefined;
  configuration: FinanceProviderConfiguration | undefined;
  connected: boolean;
  onStart(scope: InvestigationStartScope): Promise<void>;
  onAnswer(runId: string, questionId: string, answer: string): Promise<void>;
}

function EvidenceLink({ sourceId, subject, clarifications }: { sourceId: string; subject: InvestigationSubject; clarifications: HumanClarification[] }) {
  const text = subject.evidence.find(row => row.sourceId === sourceId)?.text ?? clarifications.find(row => row.sourceId === sourceId)?.answer;
  return <details className="evidence-reference"><summary><code>{sourceId}</code></summary>
    <p>{text ?? "See the immutable provider context for this source version."}</p>
  </details>;
}

export function FinanceInvestigationView({ subject, investigation, configuration, connected, onStart, onAnswer }: Props) {
  const [kind, setKind] = useState<InvestigationScope["kind"]>(subject.scopeKinds.includes("historical_onboarding") ? "historical_onboarding" : "deposit_investigation");
  const [fromDate, setFromDate] = useState("");
  const [cutoffDate, setCutoffDate] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = investigation?.runs[0];
  const active = latest !== undefined && ["queued", "retrieving_evidence", "checking", "provider_starting", "provider_pending", "validating"].includes(latest.status);
  const questions = investigation?.questions.filter(question => question.runId === latest?.runId || question.status === "open") ?? [];

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Investigation request failed. Please retry."); }
    finally { setBusy(false); }
  }
  function start(event: FormEvent) {
    event.preventDefault();
    void perform(() => onStart({ kind, accountId: subject.accountId, currency: subject.currency, ...investigationPeriod(fromDate, cutoffDate) }));
  }

  return <section aria-label="Finance investigation">
    <h2>Finance investigator {configuration?.mode === "mock" && <small>SIMULATED / MOCK</small>}
      {configuration?.mode === "creao" && <small>CREAO / REAL</small>}</h2>
    <p role={configuration && !configuration.configured ? "alert" : "status"}>{configuration?.message ?? "Loading provider configuration…"}</p>
    <p>The investigator proposes findings and questions. Allocations and candidate policies remain unapproved.</p>
    <form onSubmit={start}>
      <label>Investigation scope<select value={kind} onChange={event => setKind(event.target.value as InvestigationScope["kind"])} disabled={active || busy}>
        <option value="deposit_investigation">Individual deposit</option>
        {subject.scopeKinds.includes("historical_onboarding") && <option value="historical_onboarding">Historical onboarding · available records only</option>}
      </select></label>
      <div className="period-fields">
        <label>Period starts (optional)<input type="datetime-local" value={fromDate} onChange={event => setFromDate(event.target.value)} disabled={active || busy} /></label>
        <label>Cutoff (defaults to now)<input type="datetime-local" value={cutoffDate} onChange={event => setCutoffDate(event.target.value)} disabled={active || busy} /></label>
      </div>
      <p><code>{subject.accountId}</code> · {subject.currency}</p>
      <button type="submit" disabled={busy || active || !configuration?.configured || !connected || !investigation}>
        {busy ? "Saving request…" : active ? "Investigation running…" : latest ? "Run new investigation attempt" : "Run investigation"}
      </button>
    </form>
    {error && <p role="alert">{error}</p>}
    {!investigation ? <p role="status">Loading investigation history…</p> : latest ? <>
      <div className="run-status" role="status">Attempt {latest.attempt} · {latest.status} · {latest.simulated ? "SIMULATED" : "CREAO"}</div>
      <p>Run: <code>{latest.runId}</code>{latest.parentRunId && <> · Parent: <code>{latest.parentRunId}</code></>}</p>
      {latest.externalRunId && <p>Provider run: <code>{latest.externalRunId}</code></p>}
      {latest.reportSource && <p>Report source: <code>{latest.reportSource.field}</code> ({latest.reportSource.format}).</p>}
      <p>Reviewed scope: {latest.scope.accountId}, {latest.scope.currency}, {latest.scope.from === null ? "available start" : new Date(latest.scope.from).toISOString()} through {new Date(latest.scope.cutoff).toISOString()}.</p>
      {latest.error && <p role="alert"><strong>{latest.error.code}</strong>: {latest.error.message}</p>}
      {latest.error?.details && <ul aria-label="Validation details">{latest.error.details.map((detail, index) => <li key={index}><code>{detail.path}</code>: {detail.reason}</li>)}</ul>}
      {latest.providerInput && <>
        <h3>Records and code checks</h3>
        <p>{latest.providerInput.records.transactions.length} transaction(s), {latest.providerInput.records.documents.length} document(s), {latest.providerInput.humanClarifications.length} saved clarification(s). Coverage: available records only.</p>
        <p>Amount validation: {latest.providerInput.deterministicChecks.amounts.status}. Reconciliation: {latest.providerInput.deterministicChecks.reconciliation.status}. Owner allocations verified: no.</p>
        {latest.resultChecks && <p>Proposed-allocation code checks: {latest.resultChecks.proposedAllocations.status}.</p>}
        <ul>{latest.providerInput.records.missingEvidence.map(item => <li key={item}>{item}</li>)}</ul>
      </>}
      {latest.result && <>
        <h3>Investigation result · {latest.result.outcome}</h3><p>{latest.result.summary}</p>
        {latest.result.findings.map(finding => <article key={finding.findingId}><h4>Finding</h4><p>{finding.summary}</p>
          {finding.sourceRefs.map(sourceId => <EvidenceLink key={sourceId} sourceId={sourceId} subject={subject} clarifications={investigation.clarifications} />)}</article>)}
        <h3>Proposed allocations · unapproved</h3>
        {latest.result.proposedAllocations.length === 0 ? <p>No allocation proposed. The deposit remains unallocated.</p> :
          <ul>{latest.result.proposedAllocations.map(proposal => <li key={proposal.proposalId}>{proposal.amountCents} integer cents {proposal.currency} to <code>{proposal.ownerId}</code> for <code>{proposal.transactionId}</code> · unapproved
            {proposal.evidenceSourceIds.map(sourceId => <EvidenceLink key={sourceId} sourceId={sourceId} subject={subject} clarifications={investigation.clarifications} />)}</li>)}</ul>}
        {latest.result.proposedActions.length > 0 && <><h3>Proposed evidence requests</h3><ul>{latest.result.proposedActions.map((action, index) => <li key={index}>{action.description}</li>)}</ul></>}
        {latest.result.candidatePolicies.length > 0 && <><h3>Candidate policies · proposed for human review</h3><ul>{latest.result.candidatePolicies.map(policy => <li key={policy.policyId}>{policy.statement}</li>)}</ul></>}
      </>}
      {questions.length > 0 && <><h3>Missing-information questions</h3>{questions.map(question => <article key={question.questionId}>
        <p><strong>{question.question}</strong></p>
        {question.sourceRefs.map(sourceId => <EvidenceLink key={sourceId} sourceId={sourceId} subject={subject} clarifications={investigation.clarifications} />)}
        {question.status === "answered" ? <p>Clarification saved · {investigation.clarifications.find(row => row.clarificationId === question.clarificationId)?.answer}</p> : <form onSubmit={event => { event.preventDefault(); void perform(() => onAnswer(question.runId, question.questionId, answers[question.questionId] ?? "")); }}>
          <label htmlFor={question.questionId}>Task-scoped clarification<textarea id={question.questionId} value={answers[question.questionId] ?? ""} onChange={event => setAnswers({ ...answers, [question.questionId]: event.target.value })} minLength={1} maxLength={4000} required disabled={busy || active} /></label>
          <p>Saved as clarification, without financial authorization. This development app has no sign-in; an unauthenticated respondent is labelled accordingly.</p>
          <button type="submit" disabled={busy || active || !connected || !(answers[question.questionId] ?? "").trim()}>Save answer and resume</button>
        </form>}
      </article>)}</>}
      <details><summary>Saved provider context, checks, and prior attempts ({investigation.runs.length})</summary><pre>{JSON.stringify(investigation, null, 2)}</pre></details>
      <p>Visual audit hook: {investigation.auditHandoff?.visualAuditStatus ?? "awaiting_result"}. The separate visual-audit agent is not connected.</p>
    </> : <p>No investigation attempts saved yet.</p>}
  </section>;
}
