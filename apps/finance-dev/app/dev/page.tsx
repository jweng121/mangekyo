"use client";

import { useState } from "react";
import { useMutation, useQuery, useConvexConnectionState } from "convex/react";
import { ConvexError } from "convex/values";
import { FinanceCaseView, FinanceInvestigationView, subjectFromCase } from "@mangekyo/finance-core";
import { MoneyPanel } from "../MoneyPanel";
import "./dev.css";
import { api } from "../../../../convex/_generated/api";

export default function FinancePage() {
  const [historyAfter, setHistoryAfter] = useState(0);
  const data = useQuery(api.finance.getSyntheticCase);
  const events = useQuery(api.finance.listTaskEvents, data ? { taskId: data.task.taskId, afterSequence: historyAfter } : "skip");
  const snapshots = useQuery(api.finance.listTaskSnapshots, data ? { taskId: data.task.taskId, afterSequence: historyAfter } : "skip");
  const seed = useMutation(api.finance.seedSyntheticCase);
  const investigation = useQuery(api.financeInvestigations.getTaskInvestigation, data ? { taskId: data.task.taskId } : "skip");
  const configuration = useQuery(api.financeInvestigations.getProviderConfiguration);
  const startInvestigation = useMutation(api.financeInvestigations.startInvestigation);
  const answerQuestion = useMutation(api.financeInvestigations.answerQuestion);
  const connection = useConvexConnectionState();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadSyntheticCase() {
    setSaving(true); setError(null); setMessage(null);
    try {
      const result = await seed({});
      setMessage(result.created ? "Synthetic case saved." : "Existing synthetic case loaded; no duplicates created.");
    } catch {
      setError("Could not save the synthetic case. Check the connection and backend deployment, then retry.");
    } finally { setSaving(false); }
  }

  return (
    <div className="dev-root"><main>
      <header><p>MANGEKYO / FINANCE DEVELOPMENT</p><h1>Finance investigation</h1>
        <p>Review available historical records or individual deposits with persisted evidence and audit records.</p>
        <p role="status">{connection.isWebSocketConnected ? "Live connection active" : "Connecting to Convex…"}</p>
      </header>
      <button onClick={loadSyntheticCase} disabled={saving || !connection.isWebSocketConnected}>
        {saving ? "Saving…" : "Load synthetic case"}
      </button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <MoneyPanel connected={connection.isWebSocketConnected} />
      {data === undefined ? <p role="status">Loading saved case…</p> : data === null ?
        <p>No sample case saved yet. Load the synthetic case to create it.</p> : <>
          <FinanceCaseView data={data} />
          <FinanceInvestigationView subject={subjectFromCase(data)} investigation={investigation} configuration={configuration}
            connected={connection.isWebSocketConnected}
            onStart={async scope => {
              try { await startInvestigation({ taskId: data.task.taskId, scope }); }
              catch (error) {
                if (error instanceof ConvexError && typeof error.data === "string") throw new Error(error.data);
                throw new Error("Could not start the investigation. Check your connection and try again.");
              }
            }}
            onAnswer={async (runId, questionId, answer) => { await answerQuestion({ runId, questionId, answer }); }} />
          <nav aria-label="Audit history pages"><p>History after sequence {historyAfter} · up to 100 records per page</p>
            {historyAfter > 0 && <button onClick={() => setHistoryAfter(0)}>First history page</button>}{" "}
            {events?.length === 100 && <button onClick={() => setHistoryAfter(events[events.length - 1].sequence)}>Next history page</button>}
          </nav>
          <section aria-label="Saved events"><h2>Saved events</h2>
            {events === undefined ? <p role="status">Loading events…</p> :
              events.map((event) => <details key={event.eventId}><summary>#{event.sequence} · {event.type}</summary>
                <pre>{JSON.stringify(event, null, 2)}</pre></details>)}
          </section>
          <section aria-label="Structured snapshots"><h2>Investigation snapshot history</h2>
            <p>Developer integration view · structured state saved with the task.</p>
            {snapshots === undefined ? <p role="status">Loading snapshots…</p> :
              snapshots.map((snapshot) => <details key={snapshot.snapshotId}><summary>Snapshot #{snapshot.sequence} · {snapshot.output.investigationStatus}</summary>
                <pre>{JSON.stringify(snapshot, null, 2)}</pre></details>)}
          </section>
        </>}
    </main></div>
  );
}
