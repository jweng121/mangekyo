"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { MotionRoot } from "../../components/MotionRoot";
import { OrchestratorTimeline } from "../../components/OrchestratorTimeline";
import { money, personName } from "../../lib/desk";
import "../../mk.css";

const RULE: Record<string, string> = { L3: "evidence exists", L4: "a different person", L6: "exact amount", L7: "still proposed, not already recorded", R1: "clears the mismatch" };

/** One mismatch-agent run: the code-found cause, what it was given, its explanation, the entry it proposes, and the checks. */
export default function ReconciliationRun() {
  const runId = decodeURIComponent(String(useParams<{ runId: string }>().runId));
  const view = useQuery(api.financeReconciliation.getRunView, { runId });
  if (view === undefined) return <MotionRoot className=""><p className="wrap empty" style={{ marginTop: 24 }}>Loading the run…</p></MotionRoot>;
  if (view === null) return <MotionRoot className=""><p className="wrap empty" style={{ marginTop: 24 }}>No mismatch run with this ID. <Link href="/desk">Back to the desk</Link></p></MotionRoot>;
  const { run, correction, events, state } = view;
  const { cause, records } = run.input;
  const owner = (id: string | null) => records.owners.find(o => o.ownerId === id)?.name ?? (id === null ? "Not yet assigned" : "an owner");
  const texts = new Map<string, string>([
    ...records.bankTransactions.map(t => [t.sourceId, `${t.direction === "outflow" ? "Out" : "In"} ${money(t.amountCents)} · ${t.counterparty} · ${t.reference}`] as [string, string]),
    ...records.ledgerEntries.map(e => [e.entryId, `${e.kind.replace(/_/g, " ")} ${money(e.amountCents)} · ${owner(e.ownerId)}`] as [string, string]),
  ]);
  return <MotionRoot className="">
    <header className="bar"><div className="wrap bar-in">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", minWidth: 0 }}>
        <Link className="brand" href="/desk" aria-label="Back to desk"><img src="/mangekyo-logo.png" alt="" width={34} height={34} /></Link>
        <nav aria-label="Breadcrumb" style={{ fontSize: 14, color: "var(--muted)", display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0 }}><Link href="/desk">Desk</Link><span aria-hidden="true">/</span><span style={{ color: "var(--ink)", fontWeight: 600, overflowWrap: "anywhere" }}>Mismatch · {money(Math.abs(cause.amountCents ?? 0))} · mismatch agent ({run.mode})</span></nav>
      </div>
    </div></header>
    <main className="wrap" style={{ display: "flex", flexDirection: "column", gap: 22, paddingBlock: "22px 64px" }}>
      <section className="card bad" aria-label="Found by code">
        <span className="tag t-code">Found by code · three-way check</span>
        <h2 style={{ fontSize: 18, margin: 0 }}>{cause.message}</h2>
        <p className="meta">The mismatch agent was given this cause and only the {records.bankTransactions.length + records.ledgerEntries.length} records it involves. Bank minus books when found: {money(run.input.threeWay.bankMinusBook)}.</p>
      </section>
      <div className="cols">
        <div style={{ flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          {state && <OrchestratorTimeline state={state} events={events} retries={run.retries} />}
          <section className="card" aria-label="What the agent was given"><h2 style={{ fontSize: 18, margin: 0 }}>What the agent was given</h2>
            {[...texts].map(([id, text]) => <div key={id} className="claim"><span className="tag t-code" style={{ flex: "none" }}>Record</span><div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}><span style={{ fontSize: 14 }}>{text}</span><span className="ids">{id}</span></div></div>)}
            {records.documents.map(d => <div key={d.sourceId} className="claim"><span className="tag t-code" style={{ flex: "none" }}>Document</span><div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}><span style={{ fontSize: 14 }}>{d.title}: {d.text}</span><span className="ids">{d.sourceId}</span></div></div>)}
          </section>
        </div>
        <aside style={{ flex: "1 1 400px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          {run.error && <section className="card bad"><span className="tag t-bad">Failed, needs a person</span><p>{run.error.message}</p></section>}
          {run.output && <section className="card" aria-label="Explanation"><span className="tag t-ai">Mismatch agent · mock</span><h2 style={{ fontSize: 18, margin: 0 }}>Explanation</h2><p>{run.output.explanation}</p>
            {run.output.findings.map(f => { const check = run.findingChecks.find(c => c.findingId === f.findingId); return <div key={f.findingId} className="claim">
              <span className={`tag ${check?.supported ? "t-ok" : "t-bad"}`} style={{ flex: "none" }}>{check?.supported ? "Supported" : "Not supported"}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}><span style={{ fontSize: 14 }}>&ldquo;{f.summary}&rdquo;</span>
                {check && !check.supported && <span style={{ fontSize: 13 }}>Missing from its sources: {check.missing.join(", ")}</span>}
                {f.sourceRefs.map(ref => <span key={ref} className="ids">Cites {ref}{texts.has(ref) ? ` · ${texts.get(ref)}` : ""}</span>)}</div></div>; })}
            {run.output.questions.map(q => <p key={q.key}><b>Asks:</b> {q.question}</p>)}
          </section>}
          {run.output?.proposedEntry && <section className="card" aria-label="Proposed correcting entry"><h2 style={{ fontSize: 18, margin: 0 }}>Proposed correcting entry</h2>
            <p><b className="n">{money(run.output.proposedEntry.amountCents)}</b> · {run.output.proposedEntry.kind === "record_bank_item" ? "record the bank item" : "reverse an entry"} for {owner(run.output.proposedEntry.ownerId)}. {run.output.proposedEntry.memo}.</p>
            {run.dryRun && <ul className="recon">{run.dryRun.evaluated.map(rule => { const failed = run.dryRun!.failures.find(f => f.rule === rule); return <li key={rule}><span>{rule} · {RULE[rule] ?? rule}</span><span className={`tag ${failed ? "t-bad" : "t-ok"}`}>{failed ? failed.message : "passed in the dry run"}</span></li>; })}</ul>}
            <p className="meta">{correction ? correction.status === "posted" ? `Approved by ${personName(correction.decidedBy ?? "")}; the lock ran again and the entry was posted.` : correction.status === "rejected" ? `Rejected by ${personName(correction.decidedBy ?? "")}: ${correction.rejectionReason}` : "Waiting for an approver on the desk. Approving re-runs the lock with who is acting." : "No correction was proposed."}</p>
          </section>}
        </aside>
      </div>
    </main>
  </MotionRoot>;
}
