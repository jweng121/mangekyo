"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { MotionRoot } from "../../components/MotionRoot";
import { money } from "../../lib/desk";
import "../../mk.css";

const STEP: Record<string, { title: string; who: string; tone: "ok" | "ai" | "bad" | "q" }> = {
  "finance.investigation.started": { title: "Started the attempt", who: "System", tone: "ok" },
  "finance.investigation.resumed": { title: "Resumed with saved answers", who: "System", tone: "ok" },
  "finance.evidence.retrieved": { title: "Gathered and froze the evidence", who: "Code", tone: "ok" },
  "finance.checks.completed": { title: "Ran the code checks", who: "Code", tone: "ok" },
  "finance.provider.started": { title: "Sent the frozen evidence to the investigator", who: "System", tone: "ok" },
  "finance.provider.result_received": { title: "Investigator answered", who: "Agent", tone: "ai" },
  "finance.validation.failed": { title: "Answer rejected by validation", who: "Code", tone: "bad" },
  "finance.investigation.failed": { title: "Attempt failed", who: "System", tone: "bad" },
  "finance.question.raised": { title: "Asked a question instead of guessing", who: "Agent", tone: "q" },
  "finance.clarification.saved": { title: "A person answered", who: "Person", tone: "ok" },
  "finance.investigation.completed": { title: "Finished", who: "Agent", tone: "ai" },
};
const DOT = { ok: ["var(--ok-soft)", "var(--ok)", "passed"], ai: ["var(--ai-soft)", "var(--ai)", "agent step"], bad: ["var(--bad)", "#fff", "failed"], q: ["var(--wait-soft)", "var(--wait)", "waiting on a person"] } as const;
const OUTCOME: Record<string, string> = { proposal_ready: "Ready for approval", needs_information: "Asked a question", findings: "Findings only" };
const runOutcome = (r: { status: string; outcome: string | null }) => r.outcome ? OUTCOME[r.outcome] : r.status === "failed" ? "Failed" : r.status.replace(/_/g, " ");
const plain = (text: string) => text.replace(/^SIMULATED: /, "Mock agent: ");

export default function RunInspector() {
  const runId = decodeURIComponent(String(useParams<{ runId: string }>().runId));
  const view = useQuery(api.financeDesk.getRunView, { runId });
  if (view === undefined) return <MotionRoot className=""><p className="wrap empty" style={{ marginTop: 24 }}>Loading the run…</p></MotionRoot>;
  if (view === null) return <MotionRoot className=""><p className="wrap empty" style={{ marginTop: 24 }}>No run with this ID. <Link href="/desk">Back to the desk</Link></p></MotionRoot>;
  const { run, runs, steps } = view;
  const input = run.providerInput;
  const deposit = input?.records.transactions[0];
  const crumb = deposit ? `Deposit ${money(deposit.amountCents)} · ${deposit.description}` : "Synthetic investigation case";
  const sources = new Map<string, string>();
  input?.records.documents.forEach(d => sources.set(d.sourceId, `${d.title}: ${d.excerpt}`));
  input?.records.transactions.forEach(t => sources.set(t.sourceId, `${money(t.amountCents)} · ${t.description}`));
  input?.records.invoices.forEach(i => sources.set(i.sourceId, i.excerpt));
  input?.humanClarifications.forEach(c => sources.set(c.sourceId, `Answer: “${c.answer}”`));
  const claims = run.result?.findings ?? [];
  return <MotionRoot className="">
    <header className="bar"><div className="wrap bar-in">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", minWidth: 0 }}>
        <Link className="brand" href="/desk" aria-label="Back to desk"><img src="/mangekyo-logo.png" alt="" width={34} height={34} /></Link>
        <nav aria-label="Breadcrumb" style={{ fontSize: 14, color: "var(--muted)", display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0 }}><Link href="/desk">Desk</Link><span aria-hidden="true">/</span><span style={{ color: "var(--ink)", fontWeight: 600, overflowWrap: "anywhere" }}>{crumb} / Run {run.attempt} of {runs.length}</span></nav>
      </div>
      <Link className="btn" href={`/runs/${encodeURIComponent(runId)}/view`}>What the agent saw</Link>
    </div></header>
    <main className="wrap" style={{ display: "flex", flexDirection: "column", gap: 22, paddingBlock: "22px 64px" }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="eyebrow">Every run is kept · nothing is overwritten</span>
        <div className="runs">{runs.map(r => <Link key={r.runId} className={`run${r.status === "failed" ? " failed" : ""}`} href={`/runs/${encodeURIComponent(r.runId)}`} aria-current={r.runId === runId ? "page" : undefined}>
          <span className="m" style={{ fontSize: 12, color: "var(--muted)" }}>Run {r.attempt}{r.parentRunId ? ` · follows run ${runs.find(x => x.runId === r.parentRunId)?.attempt ?? "?"}` : ""}</span>
          <b style={{ color: r.status === "failed" ? "var(--bad)" : r.outcome === "proposal_ready" ? "var(--ok)" : "var(--wait)" }}>{runOutcome(r)}</b>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{r.simulated ? "Mock agent" : "CREAO agent"} · {new Date(r.createdAt).toLocaleString("en-US")}</span>
        </Link>)}</div>
      </section>
      <div className="cols">
        <section className="card" style={{ flex: "999 1 520px", minWidth: 0, padding: "6px 20px 10px" }} aria-label="Steps">
          <h2 style={{ fontSize: 18, margin: "14px 0 2px" }}>What happened in run {run.attempt}</h2>
          <p style={{ margin: "0 0 4px", fontSize: 13, color: "var(--muted)" }}>Each step is a frozen snapshot, saved with its event.</p>
          {steps.map((s, i) => {
            const def = STEP[s.type] ?? { title: s.type, who: "System", tone: "ok" as const };
            const [bg, fg, label] = DOT[def.tone];
            return <div key={s.eventId} className="step">
              <span className="dot" style={{ background: bg, color: fg }} aria-label={label}>{i + 1}</span>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}><b style={def.tone === "bad" ? { color: "var(--bad)" } : undefined}>{def.title}</b><span className="m" style={{ fontSize: 12, color: "var(--muted)" }}>{def.who} · {new Date(s.timestamp).toLocaleTimeString("en-US")}</span></div>
                <span style={{ fontSize: 14, color: "#33424A", overflowWrap: "anywhere" }}>{plain(s.message)}</span>
                <span className="ids">snapshot {s.snapshotId ?? "none"}</span>
              </div></div>;
          })}
        </section>
        <aside style={{ flex: "1 1 400px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          <section className="card" aria-label="Claim by claim"><h2 style={{ fontSize: 18, margin: 0 }}>Claim by claim</h2>
            {claims.length === 0 ? <p>No claims in this run{run.status === "failed" ? "; it failed before a valid answer" : ""}.</p> : claims.map(c => <div key={c.findingId} className="claim">
              <span className="tag t-wait" style={{ flex: "none" }}>Not checked yet</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                <span style={{ fontSize: 14 }}>&ldquo;{c.summary.replace(/^SIMULATED: /, "")}&rdquo;</span>
                {c.sourceRefs.map(ref => <span key={ref} className="ids">Cites {ref}{sources.has(ref) ? ` · ${sources.get(ref)}` : ""}</span>)}
              </div></div>)}
            <p className="meta">Validation already confirmed every cited source exists in the frozen input. Whether each claim is supported by its source is the claim checker&apos;s job, which isn&apos;t connected yet.</p>
          </section>
          {run.result && <section className="card" aria-label="Outcome"><h2 style={{ fontSize: 18, margin: 0 }}>Outcome</h2>
            <p>{run.result.proposedAllocations.length ? `Proposed ${run.result.proposedAllocations.length} allocation(s); none is approved until a person signs off.` : run.result.questions.length ? `Asked ${run.result.questions.length} question(s) instead of guessing (steps above). No money moved.` : "Findings only. No money moved."}</p>
            {run.result.proposedAllocations.map(a => <p key={a.proposalId}><b>Proposed:</b> {money(a.amountCents)} to {input?.records.owners.find(o => o.ownerId === a.ownerId)?.name ?? "an owner"} · unapproved</p>)}
            <details><summary style={{ cursor: "pointer", fontSize: 14 }}>The agent&apos;s full summary</summary><p style={{ marginTop: 8 }}>{plain(run.result.summary)}</p></details></section>}
          {run.error && <section className="card bad"><h2 style={{ fontSize: 18, margin: 0 }}>Why it failed</h2><p>{run.error.message}</p></section>}
        </aside>
      </div>
    </main>
  </MotionRoot>;
}
