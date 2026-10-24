"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { MotionRoot } from "../../../components/MotionRoot";
import { VisualAuditPlaceholder } from "../../../components/VisualAuditPlaceholder";
import { money } from "../../../lib/desk";
import "../../../mk.css";

function Row({ label, id }: { label: string; id: string }) {
  return <div className="given"><span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{label}</span><span>{id}</span></div>;
}

export default function AgentView() {
  const runId = decodeURIComponent(String(useParams<{ runId: string }>().runId));
  const view = useQuery(api.financeDesk.getRunView, { runId });
  const [step, setStep] = useState(0);
  if (!view) return <MotionRoot className="dark"><p className="wrap" style={{ paddingTop: 24 }}>{view === null ? "No run with this ID." : "Loading…"}</p></MotionRoot>;
  const input = view.run.providerInput;
  const current = view.steps[Math.min(step, Math.max(0, view.steps.length - 1))];
  return <MotionRoot className="dark">
    <header className="bar"><div className="wrap bar-in">
      <Link className="brand" href="/desk" aria-label="Back to desk"><img src="/mangekyo-logo.png" alt="" width={34} height={34} /></Link>
      <Link className="btn alt" href={`/runs/${encodeURIComponent(runId)}`} style={{ background: "transparent", color: "#E9ECEA", borderColor: "#5B7079" }}>Back to the run</Link>
    </div></header>
    <main className="wrap" style={{ display: "flex", flexDirection: "column", gap: 20, paddingBlock: "22px 64px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div><span className="eyebrow" style={{ color: "#9FB1B8" }}>Run {view.run.attempt} · step {step + 1} of {view.steps.length}</span><h1 style={{ fontSize: 28, margin: "4px 0 0", letterSpacing: "-.02em" }}>What the agent saw</h1></div>
        <span className="m" style={{ fontSize: 12, color: "#13222B", background: "#E9C46A", padding: "4px 10px", borderRadius: 3 }}>PLACEHOLDER · VISUAL AUDIT</span>
      </div>
      <div className="cols">
        <section style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }} aria-label="Captured view">
          <VisualAuditPlaceholder runId={runId} stepIndex={step} snapshotId={current?.snapshotId ?? null} />
          <div className="frames" role="list" aria-label="Frames in this run">{view.steps.map((f, i) => <button key={f.eventId} type="button" role="listitem" className="frm" aria-current={i === step} onClick={() => setStep(i)}>
            <i /><span>{i + 1}. {f.type.replace("finance.", "").replace(/[._]/g, " ")}</span></button>)}</div>
        </section>
        <aside style={{ flex: "1 1 360px", minWidth: 0, background: "#18303B", border: "1px solid #33464F", borderRadius: 4, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 8 }} aria-label="Exactly what it was given">
          <h2 style={{ fontSize: 17, margin: 0 }}>Exactly what it was given</h2>
          <p style={{ margin: 0, fontSize: 13, color: "#9FB1B8" }}>The frozen input for this attempt. Nothing else was visible to the agent.</p>
          {!input ? <p>No frozen input was saved for this attempt.</p> : <>
            <div className="given-group">Records</div>
            {input.records.transactions.map(t => <Row key={t.sourceId} label={`Deposit ${money(t.amountCents)} · ${t.description}`} id={t.sourceId} />)}
            {input.records.documents.map(d => <Row key={d.sourceId} label={d.title} id={d.sourceId} />)}
            {input.records.invoices.map(i => <Row key={i.sourceId} label={i.excerpt} id={i.sourceId} />)}
            {input.records.owners.map(o => <Row key={o.ownerId} label={`Candidate owner · ${o.name}`} id={o.ownerId} />)}
            {input.records.ownerLedgerBalances?.map(b => <Row key={b.sourceId} label={`Balance · ${b.name} · ${money(b.availableCents)} available`} id={b.sourceId} />)}
            <div className="given-group">Clarifications</div>
            {input.humanClarifications.length === 0 ? <Row label="None" id="—" /> : input.humanClarifications.map(c => <Row key={c.sourceId} label={`“${c.answer}”`} id={c.sourceId} />)}
            <div className="given-group">Approved policies</div>
            {input.approvedPolicies.length === 0 ? <Row label="None" id="—" /> : input.approvedPolicies.map(p => <Row key={p.sourceId} label={p.statement} id={`${p.policyId}@${p.version}`} />)}
            <div className="given-group">Code checks</div>
            <Row label={`Amounts ${input.deterministicChecks.amounts.status} · reconciliation ${input.deterministicChecks.threeWay?.status ?? input.deterministicChecks.reconciliation.status}`} id="deterministicChecks" />
            <div className="m" style={{ fontSize: 11, color: "#9FB1B8", lineHeight: 1.7, borderTop: "1px solid #33464F", paddingTop: 10, overflowWrap: "anywhere" }}>
              {input.schemaVersion} · instructions {input.instructionVersion}<br />context as of {input.contextAsOf ? new Date(input.contextAsOf).toISOString() : "not recorded (legacy run)"} · cutoff {new Date(input.scope.cutoff).toISOString()}<br />{view.run.runId}
            </div></>}
        </aside>
      </div>
    </main>
  </MotionRoot>;
}
