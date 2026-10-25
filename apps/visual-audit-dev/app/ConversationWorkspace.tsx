"use client";

import { MangekyoAvatar } from "@mangekyo/visual-audit";

import { useEffect, useMemo, useRef, useState } from "react";
import type { InvestigationRecord, InvestigationReport, NarratedExplanation, NarrationSegment, Snapshot } from "../../../packages/contracts";
import { BrowserTtsProvider, CloudTtsProvider, ExecutionGraph, NarrationController, SnapshotInspector } from "@mangekyo/visual-audit";

const empty: InvestigationRecord = { runs: [], events: [], snapshots: [], steeringRequests: [], reports: [], chatMessages: [], memoryRecords: [], findings: [], escalations: [] };
type Message = { id: string; runId: string; role: "user" | "assistant"; text: string; snapshotIds: string[] };
type VisualTab = "evidence" | "activity" | "review";

function issueNarration(record: InvestigationRecord): NarratedExplanation | undefined {
  const run = record.runs.filter(item => item.branchId === "original" && item.status === "escalated").at(-1);
  if (!run) return;
  const snapshots = record.snapshots.filter(item => item.runId === run.id);
  const ordered = [4, 1, 3, 5].map(sequence => snapshots.find(item => item.sequence === sequence)).filter((item): item is Snapshot => !!item);
  const text = [
    "The agent proposed Client A based on the invoice. This was a draft selection.",
    "The bank record showed payment reference B-204.",
    "The customer record associates B-204 with Client B.",
    "The ERP confirmed a draft proposal only. The disagreement needs human review.",
  ];
  const segments: NarrationSegment[] = ordered.map((snapshot, index) => ({
    id: `${snapshot.id}-narration`, text: text[index], snapshotId: snapshot.id,
    evidenceRefs: snapshot.evidence.map(item => item.id),
    highlightIds: snapshot.annotations?.map(item => item.id) ?? [],
    navigationTarget: { snapshotId: snapshot.id, evidenceRef: snapshot.evidence[0]?.id },
  }));
  return { id: `issue-${run.id}`, messageId: `issue-${run.id}`, segments };
}

function requestedVisual(question: string): VisualTab | undefined {
  if (!/\b(show|open|view|see|display|visual|screenshot|graph|timeline|capture)\b/i.test(question)) return;
  if (/\b(graph|timeline|execution|workflow|steps|path)\b/i.test(question)) return "activity";
  if (/\b(report|review|correction|outcome)\b/i.test(question)) return "review";
  return "evidence";
}

function requestedCheckpoint(question: string): number | undefined {
  if (/\b(bank|payment|reference|deposit)\b/i.test(question)) return 1;
  if (/\b(invoice|payer)\b/i.test(question)) return 2;
  if (/\b(customer|client record|ownership record)\b/i.test(question)) return 3;
  if (/\b(proposal|draft|allocation)\b/i.test(question)) return 4;
}

export function ConversationWorkspace() {
  const [record, setRecord] = useState<InvestigationRecord>(empty);
  const [selectedId, setSelectedId] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const [visualOpen, setVisualOpen] = useState(false);
  const [visualTab, setVisualTab] = useState<VisualTab>("evidence");
  const [view, setView] = useState<"execution" | "workflow">("execution");
  const [steering, setSteering] = useState(false);
  const [instruction, setInstruction] = useState("The payment reference identifies Client B. Reconsider the allocation and verify the bank evidence.");
  const [activeHighlights, setActiveHighlights] = useState<string[]>([]);
  const [reportText, setReportText] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("idle");
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const controller = useRef<NarrationController | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const askedInSession = useRef(false);

  const openVisual = (tab: VisualTab) => { setVisualTab(tab); setVisualOpen(true); };
  const selectSnapshot = (eventId: string) => { setSelectedId(eventId); openVisual("evidence"); };
  if (!controller.current) controller.current = new NarrationController(
    new BrowserTtsProvider(),
    update => setVoiceStatus(update.status),
    segment => { if (segment?.snapshotId) { selectSnapshot(segment.snapshotId.replace("-snapshot-", "-event-")); setActiveHighlights(segment.highlightIds); } },
  );

  useEffect(() => {
    setVoiceAvailable(new BrowserTtsProvider().isAvailable());
    fetch("/api/visual-audit", { cache: "no-store" }).then(async response => {
      const json = await response.json();
      if (!response.ok) throw new Error(json.error);
      setRecord(json);
    }).catch(cause => setError((cause as Error).message));
    fetch("/api/visual-audit/tts").then(response => response.json()).then(config => {
      if ((config.provider === "fish" || config.provider === "elevenlabs") && config.configured) {
        controller.current?.stop();
        controller.current = new NarrationController(new CloudTtsProvider(), update => setVoiceStatus(update.status), segment => {
          if (segment?.snapshotId) { setSelectedId(segment.snapshotId.replace("-snapshot-", "-event-")); setVisualTab("evidence"); setVisualOpen(true); setActiveHighlights(segment.highlightIds); }
        });
        setVoiceAvailable(true);
      }
    }).catch(() => {});
    return () => controller.current?.stop();
  }, []);
  useEffect(() => {
    const stream = new EventSource("/api/visual-audit/stream");
    stream.onmessage = event => { try { setRecord(JSON.parse(event.data) as InvestigationRecord); } catch {} };
    return () => stream.close();
  }, []);
  useEffect(() => { setMessages(record.chatMessages ?? []); }, [record.chatMessages]);
  useEffect(() => { if (askedInSession.current) threadEnd.current?.scrollIntoView({ block: "end" }); }, [messages.length, asking]);

  const escalatedRuns = record.runs.filter(run => run.branchId === "original" && run.status === "escalated").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const original = escalatedRuns.find(run => run.id === activeRunId) ?? escalatedRuns[0];
  const corrected = record.runs.filter(run => run.parentRunId === original?.id && run.branchId === "corrected").at(-1);
  const future = record.runs.filter(run => run.parentRunId === original?.id && run.branchId === "future").at(-1);
  const runIds = new Set([original?.id, corrected?.id, future?.id]);
  const visibleMessages = messages.filter(message => runIds.has(message.runId));
  const allEvents = record.events.filter(event => runIds.has(event.runId));
  const selected = record.snapshots.find(snapshot => snapshot.eventId === selectedId);
  const proposal = record.snapshots.find(snapshot => snapshot.runId === original?.id && snapshot.sequence === 4);
  const report = record.reports.filter(item => item.runId === original?.id).at(-1);
  const lesson = record.memoryRecords.filter(item => item.sourceReportId === report?.id).at(-1);
  const narration = useMemo(() => issueNarration(record), [record]);
  useEffect(() => { if (original && !selectedId) setSelectedId(`${original.id}-event-4`); }, [original?.id, selectedId]);
  useEffect(() => { setActiveHighlights(selected?.annotations?.map(item => item.id) ?? []); }, [selected?.id]);
  useEffect(() => { setReportText(report?.content ?? ""); }, [report?.version]);

  const post = async (body: { action: string; [key: string]: unknown }) => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/visual-audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error);
      setRecord(json.record);
      if (body.action === "steer") {
        setSteering(false);
        setSelectedId(`${json.corrected.id}-event-4`);
        openVisual("review");
      } else {
        setSelectedId(`${json.run.id}-event-4`);
        if (body.action === "start") setActiveRunId(json.run.id);
      }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const ask = async (question: string) => {
    const prompt = question.trim();
    if (!prompt || !selected || asking) return;
    askedInSession.current = true;
    setDraft(""); setError(""); setAsking(true);
    const visual = requestedVisual(prompt);
    let checkpoint: Snapshot | undefined;
    if (visual) {
      const sequence = requestedCheckpoint(prompt);
      checkpoint = sequence ? record.snapshots.find(snapshot => snapshot.runId === original?.id && snapshot.sequence === sequence) : undefined;
      if (checkpoint) setSelectedId(checkpoint.eventId);
      openVisual(visual);
    }
    try {
      const response = await fetch("/api/visual-audit/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: prompt, snapshotId: checkpoint?.id ?? selected.id }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error);
      setMessages(current => [...current, json.user, json.assistant]);
    } catch (cause) { setError((cause as Error).message); }
    finally { setAsking(false); }
  };
  const reviseReport = async (status: InvestigationReport["status"]) => {
    if (!report) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/visual-audit/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: report.id, content: reportText, status }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error);
      setRecord(json.record);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const memoryAction = async (action: "propose" | "approve") => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/visual-audit/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, reportId: report?.id, memoryId: lesson?.id }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error);
      setRecord(json.record);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  return <div className={`request-shell ${visualOpen ? "with-visual" : ""}`}>
    <aside className="request-sidebar" aria-label="Requests">
      <div className="request-brand" style={{ display: "flex", alignItems: "center", gap: 8 }}><MangekyoAvatar size={28}/>Mangekyo</div>
      <div className="sidebar-section-title">Requests</div>
      {escalatedRuns.length ? escalatedRuns.map(run => <button key={run.id} className={`request-item ${run.id === original?.id ? "active" : ""}`} onClick={() => { setActiveRunId(run.id); setSelectedId(`${run.id}-event-4`); setVisualOpen(false); }}>
        <span className="request-item-title">Deposit ownership</span>
        <span className="request-item-detail">Deposit Matching Agent · {new Date(run.createdAt).toLocaleDateString()}</span>
        <span className="request-item-status"><i /> {record.escalations.some(item => item.runId === run.id && item.status === "resolved") ? "Resolved" : "Review needed"}</span>
      </button>) : <div className="request-empty">No requests yet. Start an agent run to create one.</div>}
    </aside>

    <main className="conversation-main">
      <header className="conversation-header">
        <div><h1>{original ? "Deposit ownership review" : "Agent requests"}</h1><p>{original ? "Deposit Matching Agent asked for a decision" : "Review work that agents bring to you"}</p></div>
        <div className="conversation-header-actions">
          {original && <button className="text-action" onClick={() => openVisual("evidence")}>Open evidence</button>}
          <button className="primary" disabled={busy} onClick={() => post({ action: "start" })}>{busy ? "Running agent..." : original ? "Run agent again" : "Start agent"}</button>
        </div>
      </header>

      <div className="conversation-scroll">
        <div className="conversation-inner">
          {error && <p className="form-error" role="alert">{error}</p>}
          {original ? <>
            <section className="request-summary">
              <div className="request-summary-icon">!</div>
              <div><h2>Ownership needs review</h2><p>The agent drafted Client A for a $5,000 deposit. The bank reference and customer record point to Client B. No payment was posted.</p>
                <div className="summary-actions"><button onClick={() => openVisual("evidence")}>View evidence</button><button onClick={() => openVisual("activity")}>View agent work</button><button onClick={() => setSteering(true)} disabled={busy}>Give direction</button></div>
              </div>
            </section>
            <div className="conversation-timeline">
              {visibleMessages.map(message => <div className={`conversation-message ${message.role}`} key={message.id}>
                <span className="message-author">{message.role === "user" ? "You" : "Mangekyo"}</span>
                <p>{message.text}</p>
                {message.role === "assistant" && message.snapshotIds.length > 0 && <div className="message-sources">{message.snapshotIds.map((id, index) => <button key={id} onClick={() => selectSnapshot(id.replace("-snapshot-", "-event-"))}>View source {message.snapshotIds.length > 1 ? index + 1 : ""}</button>)}</div>}
              </div>)}
              {asking && <div className="conversation-message assistant"><span className="message-author">Mangekyo</span><p>Looking through the recorded evidence...</p></div>}
              <div ref={threadEnd} />
            </div>
          </> : <div className="conversation-welcome"><h2>Agent work appears here</h2><p>Start the monitored agent to capture its work and surface anything that needs a decision.</p></div>}
        </div>
      </div>

      {original && <div className="conversation-composer-wrap"><div className="conversation-composer-inner">
        <div className="prompt-suggestions">
          <button onClick={() => ask("Why did the agent choose Client A?")}>Why Client A?</button>
          <button onClick={() => ask("Show me the bank evidence")}>Show bank evidence</button>
          <button onClick={() => ask("Show the execution path")}>Show agent work</button>
        </div>
        <form className="conversation-composer" onSubmit={event => { event.preventDefault(); ask(draft); }}>
          <label htmlFor="request-prompt" className="sr-only">Ask about this request</label>
          <textarea id="request-prompt" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); ask(draft); } }} placeholder="Ask about this request or ask to see evidence" rows={2} />
          <button type="submit" disabled={!draft.trim() || asking} aria-label="Send message">Send</button>
        </form>
        <p>Answers use captured evidence. The agent proposal is a draft.</p>
      </div></div>}
    </main>

    {visualOpen && original && <aside className="visual-panel" aria-label="Request visuals">
      <header className="visual-header"><div><h2>Request details</h2><p>{selected?.title ?? "Recorded work"}</p></div><button onClick={() => setVisualOpen(false)} aria-label="Close details">Close</button></header>
      <div className="visual-tabs" role="tablist" aria-label="Visual views">
        {(["evidence", "activity", "review"] as const).map(tab => <button key={tab} role="tab" aria-selected={visualTab === tab} className={visualTab === tab ? "active" : ""} onClick={() => setVisualTab(tab)}>{tab === "activity" ? "Agent work" : tab === "review" ? "Review" : "Evidence"}</button>)}
      </div>
      <div className="visual-body">
        {visualTab === "evidence" && <>
          <div className="visual-navigation"><button onClick={() => { const index = allEvents.findIndex(event => event.id === selectedId); if (index > 0) setSelectedId(allEvents[index - 1].id); }}>Previous</button><button onClick={() => { const index = allEvents.findIndex(event => event.id === selectedId); if (index >= 0 && index < allEvents.length - 1) setSelectedId(allEvents[index + 1].id); }}>Next</button></div>
          <SnapshotInspector snapshot={selected} activeHighlightIds={activeHighlights} />
          {narration && <div className="visual-voice"><button disabled={!voiceAvailable} onClick={() => controller.current?.play(narration)}>Explain aloud</button><button onClick={() => controller.current?.stop()}>Stop</button><span>{voiceStatus}</span></div>}
        </>}
        {visualTab === "activity" && <ExecutionGraph events={allEvents} snapshots={record.snapshots.filter(snapshot => runIds.has(snapshot.runId))} selectedId={selectedId} onSelect={selectSnapshot} view={view} onViewChange={setView} />}
        {visualTab === "review" && <div className="review-content">
          <h3>What happened</h3><p>The original proposal chose {original.proposedOwner}. {corrected ? `The corrected run proposed ${corrected.proposedOwner}.` : "The agent is waiting for your direction."}</p>
          {corrected && <div className="review-comparison"><div><span>Original proposal</span><strong>{original.proposedOwner}</strong></div><div><span>Corrected proposal</span><strong>{corrected.proposedOwner}</strong></div></div>}
          <button className="secondary" onClick={() => setSteering(true)} disabled={busy}>Give direction to agent</button>
          {report && <section className="review-report"><h3>Investigation report</h3><span className="review-status">{report.status.replaceAll("_", " ")}</span><textarea aria-label="Investigation report" value={reportText} onChange={event => setReportText(event.target.value)} disabled={report.status === "filed"} rows={12} /><p>{report.evidenceSnapshotIds.length} recorded sources. Remaining uncertainty: {report.remainingUncertainty}</p><div className="review-actions"><button disabled={busy || report.status === "filed"} onClick={() => reviseReport(report.status)}>Save edits</button>{report.status === "draft" && <button onClick={() => reviseReport("pending_review")} disabled={busy}>Submit for review</button>}{report.status === "pending_review" && <button onClick={() => reviseReport("approved")} disabled={busy}>Approve report</button>}{report.status === "approved" && <button onClick={() => reviseReport("filed")} disabled={busy}>File report</button>}</div></section>}
          {report?.status === "filed" && <section className="review-report"><h3>Lesson for future runs</h3>{lesson ? <><p>{lesson.title}</p><p>{lesson.content}</p>{lesson.status === "pending" && <button onClick={() => memoryAction("approve")} disabled={busy}>Authorize memory</button>}{lesson.status === "approved" && <button onClick={() => post({ action: "future" })} disabled={busy}>Run with approved memory</button>}</> : <button onClick={() => memoryAction("propose")} disabled={busy}>Save lesson to memory</button>}{future && <p>Future run proposed {future.proposedOwner}.</p>}</section>}
        </div>}
      </div>
    </aside>}

    {steering && proposal && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSteering(false); }}><section className="modal" role="dialog" aria-modal="true" aria-label="Give direction to agent"><div className="panel-head"><h2>Give direction to agent</h2><button className="icon-button" onClick={() => setSteering(false)} aria-label="Close">Close</button></div><p className="muted">The agent will revisit the draft allocation using your instruction. This does not post a transaction.</p><div className="steer-context"><strong>{proposal.title}</strong>{proposal.evidence.map(item => <p key={item.id}>{item.label}: {item.value}</p>)}</div><label className="field-label" htmlFor="correction">Your instruction</label><textarea id="correction" value={instruction} onChange={event => setInstruction(event.target.value)} rows={5} /><div className="modal-actions"><button className="secondary" onClick={() => setSteering(false)}>Cancel</button><button className="primary" disabled={busy || instruction.trim().length < 12} onClick={() => post({ action: "steer", snapshotId: proposal.id, instruction, scope: "dependent_work" })}>Rerun agent</button></div></section></div>}
  </div>;
}
