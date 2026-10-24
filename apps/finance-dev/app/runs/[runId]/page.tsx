"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../../../../convex/_generated/api";
import { MotionRoot } from "../../components/MotionRoot";
import { money, personName } from "../../lib/desk";
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
  "finance.checker.completed": { title: "Checker confirmed the claims it could judge", who: "Agent 2", tone: "ok" },
  "finance.checker.rejected": { title: "Checker found an unsupported claim", who: "Agent 2", tone: "bad" },
};
const DOT = { ok: ["var(--ok-soft)", "var(--ok)", "passed"], ai: ["var(--ai-soft)", "var(--ai)", "agent step"], bad: ["var(--bad)", "#fff", "failed"], q: ["var(--wait-soft)", "var(--wait)", "waiting on a person"] } as const;
const OUTCOME: Record<string, string> = { proposal_ready: "Ready for approval", needs_information: "Asked a question", findings: "Findings only" };
const runOutcome = (r: { status: string; outcome: string | null }) => r.status === "checker_rejected" ? "Stopped by the checker" : r.outcome ? OUTCOME[r.outcome] : r.status === "failed" ? "Failed" : r.status.replace(/_/g, " ");
const VERDICT = { supported: ["t-ok", "Supported"], not_supported: ["t-bad", "Not supported"], not_checkable: ["t-wait", "Not checkable"] } as const;
const CHOICES = [
  { id: "cite_clarification", label: "Cite the person's answer as the source for the claim", needs: "Optional note" },
  { id: "checker_wrong", label: "The checker is wrong, keep the claim (needs a reason)", needs: "Why the checker is wrong (required)" },
  { id: "add_document", label: "Add a document and rerun", needs: "Paste the document text (required)" },
] as const;

function FixIt({ runId, creao }: { runId: string; creao: boolean }) {
  const router = useRouter();
  const rerun = useMutation(api.financeInvestigations.correctAndRerun);
  const [choice, setChoice] = useState<(typeof CHOICES)[number]["id"]>("cite_clarification");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <section className="card bad" aria-label="Fix it">
    <h2 style={{ fontSize: 18, margin: 0 }}>Fix it</h2>
    <p>Correct what went wrong, then rerun from step 3. This run stays exactly as it is, and the new run links back to it.</p>
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      <legend className="eyebrow" style={{ marginBottom: 6 }}>What was wrong</legend>
      {CHOICES.map(c => <label key={c.id} style={{ display: "flex", gap: 10, fontSize: 14, alignItems: "flex-start" }}><input type="radio" name="fix" checked={choice === c.id} onChange={() => setChoice(c.id)} style={{ minHeight: 0, marginTop: 3 }} />{c.label}</label>)}
    </fieldset>
    <label className="field">{CHOICES.find(c => c.id === choice)!.needs}<textarea value={note} onChange={e => setNote(e.target.value)} rows={3} /></label>
    {error && <p role="alert" style={{ color: "var(--bad)" }}>{error}</p>}
    <p className="meta">Recorded as sam, approver (dev only).{creao ? " In CREAO mode the rerun is a real, paid run." : ""}</p>
    <div className="acts"><button className="btn" disabled={busy} onClick={async () => {
      setBusy(true); setError(null);
      try { const r = await rerun({ runId, choice, note, dev: { role: "approver", name: "sam" } }); router.push(`/runs/${encodeURIComponent(r.runId)}`); }
      catch (e) { setError(e instanceof ConvexError && typeof e.data === "string" ? e.data : "Couldn't rerun. Try again."); }
      finally { setBusy(false); }
    }}>Rerun from step 3{creao ? " (starts a CREAO run)" : ""}</button></div>
  </section>;
}
const plain = (text: string) => text.replace(/^SIMULATED: /, "Mock agent: ");

export default function RunInspector() {
  const runId = decodeURIComponent(String(useParams<{ runId: string }>().runId));
  const view = useQuery(api.financeDesk.getRunView, { runId });
  const config = useQuery(api.financeInvestigations.getProviderConfiguration);
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
  const verdicts = new Map((run.claimCheck?.claims ?? []).map(c => [c.findingId, c]));
  const policies = (input?.approvedPolicies ?? []).filter(p => run.result?.proposedAllocations.some(a => a.evidenceSourceIds.includes(p.sourceId)));
  const latest = runs.reduce((a, b) => (b.attempt > a.attempt ? b : a), runs[0]);
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
        <div className="runs">{runs.map(r => <Link key={r.runId} className={`run${r.status === "failed" || r.status === "checker_rejected" ? " failed" : ""}`} href={`/runs/${encodeURIComponent(r.runId)}`} aria-current={r.runId === runId ? "page" : undefined}>
          <span className="m" style={{ fontSize: 12, color: "var(--muted)" }}>Run {r.attempt}{r.parentRunId ? ` · follows run ${runs.find(x => x.runId === r.parentRunId)?.attempt ?? "?"}` : ""}</span>
          <b style={{ color: r.status === "failed" || r.status === "checker_rejected" ? "var(--bad)" : r.outcome === "proposal_ready" ? "var(--ok)" : "var(--wait)" }}>{runOutcome(r)}</b>
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
          {run.status === "checker_rejected" && latest?.runId === runId && <FixIt runId={runId} creao={config?.mode === "creao"} />}
          <section className="card" aria-label="Claim by claim"><h2 style={{ fontSize: 18, margin: 0 }}>Claim by claim</h2>
            {policies.map(p => <span key={p.sourceId} className="tag t-ok">Used policy {p.policyId}{p.approvedBy ? `, approved by ${personName(p.approvedBy)}` : ""}</span>)}
            {claims.length === 0 ? <p>No claims in this run{run.status === "failed" ? "; it failed before a valid answer" : ""}.</p> : claims.map(c => {
              const v = verdicts.get(c.findingId);
              const [tone, label] = v ? VERDICT[v.verdict] : ["t-wait", "Not checked yet"];
              return <div key={c.findingId} className="claim">
                <span className={`tag ${tone}`} style={{ flex: "none" }}>{label}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: v?.verdict === "not_supported" ? 600 : 400 }}>&ldquo;{c.summary.replace(/^SIMULATED: /, "")}&rdquo;</span>
                  {v?.verdict === "not_supported" && v.sourceSays && <div className="quote"><span style={{ color: "var(--muted)" }}>What the source actually says:</span><br /><span className="m">{v.sourceSays}</span></div>}
                  {v && <span style={{ fontSize: 13, color: "#33424A" }}>{v.reason}{v.checkedBy !== "none" ? ` (checked by ${v.checkedBy})` : ""}</span>}
                  {c.sourceRefs.map(ref => <span key={ref} className="ids">Cites {ref}{sources.has(ref) ? ` · ${sources.get(ref)}` : ""}</span>)}
                </div></div>;
            })}
            <p className="meta">{run.claimCheck ? `Checked by code${run.claimCheck.agentMode !== "off" ? ` and the ${run.claimCheck.agentMode} checker agent` : ""} at ${new Date(run.claimCheck.checkedAt).toLocaleString("en-US")}. Any unsupported claim stops the run before a person sees a proposal.` : "This run finished before the claim checker existed, so its claims weren't checked."}</p>
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
