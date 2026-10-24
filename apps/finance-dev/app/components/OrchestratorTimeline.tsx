import { actorWords, eventTitle, STATE, triggerWords, type TimelineEvent } from "../lib/orchestrator";

const DOT = { transition: ["var(--ok-soft)", "var(--ok)"], retry: ["var(--wait-soft)", "var(--wait)"], budget_check: ["#E9EEF1", "#33424A"], bad: ["var(--bad)", "#fff"] } as const;

/** The orchestrator's saved steps for one deposit (or mismatch): states, retries and budget checks, with who or what caused each. */
export function OrchestratorTimeline({ state, events, retries, highlightRunId }: { state: string; events: TimelineEvent[]; retries: number; highlightRunId?: string }) {
  const current = STATE[state] ?? { label: state, tone: "t-code" as const };
  const budgetChecks = events.filter(e => e.kind === "budget_check").length;
  return <section className="card" aria-label="Orchestrator" style={{ padding: "6px 20px 10px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 14 }}>
      <h2 style={{ fontSize: 18, margin: 0 }}>Orchestrator</h2>
      <span className={`tag ${current.tone}`}>Now: {current.label}</span>
    </div>
    <p style={{ margin: "4px 0", fontSize: 13, color: "var(--muted)" }}>One orchestrator per deposit. {events.length} saved step{events.length === 1 ? "" : "s"} · {retries} automatic retr{retries === 1 ? "y" : "ies"} · {budgetChecks} budget check{budgetChecks === 1 ? "" : "s"}. Each step is an event with a snapshot.</p>
    {events.map(e => {
      const bad = e.to === "failed" || e.to === "rejected" || e.budget?.allowed === false;
      const [bg, fg] = bad ? DOT.bad : DOT[e.kind];
      return <div key={e.eventId} className="step" style={highlightRunId && e.runId && e.runId !== highlightRunId ? { opacity: .62 } : undefined}>
        <span className="dot" style={{ background: bg, color: fg }} aria-label={e.kind === "retry" ? "retry" : e.kind === "budget_check" ? "budget check" : bad ? "stopped" : "state change"}>{e.sequence}</span>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <b style={bad ? { color: "var(--bad)" } : undefined}>{eventTitle(e)}</b>
            <span className="m" style={{ fontSize: 12, color: "var(--muted)" }}>{actorWords(e.actor)} · {triggerWords(e.trigger)} · {new Date(e.timestamp).toLocaleTimeString("en-US")}</span>
          </div>
          <span style={{ fontSize: 14, color: "#33424A", overflowWrap: "anywhere" }}>{e.reason.message.replace(/^SIMULATED: /, "Mock agent: ")}</span>
          {e.budget && e.budget.needed > 0 && <span className="meta">Real runs: {e.budget.usedToday} of {e.budget.limits.perDay} today · {e.budget.usedForDeposit} of {e.budget.limits.perDeposit} for this deposit · this attempt needs {e.budget.needed}</span>}
          <span className="ids">snapshot {e.snapshotId ?? "none"}{e.runId ? ` · ${e.runId}` : ""}</span>
        </div>
      </div>;
    })}
  </section>;
}
