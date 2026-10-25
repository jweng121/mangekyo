"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { MotionRoot } from "../../components/MotionRoot";
import { STATE } from "../../lib/orchestrator";
import "../../mk.css";

const RESULT = { caught: ["t-ok", "Caught"], wrong: ["t-bad", "Wrong"], pending: ["t-wait", "Still running"] } as const;

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="fig" style={{ flex: "1 1 160px", minWidth: 0 }}><span className="label">{label}</span><b className="n" style={{ fontSize: 30 }}>{value}</b>{note && <span className="meta">{note}</span>}</div>;
}

/** How well the agents did: planted mistakes with known right answers, or a synthetic batch. Read from saved state. */
export default function Scorecard() {
  const accountId = decodeURIComponent(String(useParams<{ accountId: string }>().accountId));
  const card = useQuery(api.financeScorecard.getScorecard, { accountId });
  if (card === undefined) return <MotionRoot className=""><p className="wrap empty" style={{ marginTop: 24 }}>Loading the scorecard…</p></MotionRoot>;
  if (card === null) return <MotionRoot className=""><p className="wrap empty" style={{ marginTop: 24 }}>This account isn&apos;t a scorecard run. <Link href="/desk">Back to the desk</Link></p></MotionRoot>;
  return <MotionRoot className="">
    <header className="bar"><div className="wrap bar-in">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", minWidth: 0 }}>
        <Link className="brand" href="/desk" aria-label="Back to desk"><img src="/mangekyo-logo.png" alt="" width={34} height={34} /></Link>
        <nav aria-label="Breadcrumb" style={{ fontSize: 14, color: "var(--muted)", display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0 }}><Link href="/desk">Desk</Link><span aria-hidden="true">/</span><span style={{ color: "var(--ink)", fontWeight: 600 }}>Scorecard · {card.kind === "planted" ? "planted mistakes" : "batch"}</span></nav>
      </div>
    </div></header>
    <div className="wrap proto">Mock mode · fictional DEMO data · started {new Date(card.startedAt).toLocaleString("en-US")}</div>
    <main className="wrap" style={{ display: "flex", flexDirection: "column", gap: 22, paddingBlock: "22px 64px" }}>
      {card.kind === "planted" ? <>
        <section className="eq" aria-label="Score">
          <div className="eq-status" role="status"><span style={{ color: card.summary.wrong ? "var(--bad)" : card.summary.pending ? "var(--wait)" : "var(--ok)" }}>{card.summary.line}</span></div>
          <div className="eq-row" style={{ flexWrap: "wrap" }}>
            <Tile label="Caught" value={`${card.summary.caught} of ${card.summary.total}`} />
            <Tile label="Wrong" value={String(card.summary.wrong)} note="A mistake that got through" />
            <Tile label="Asked a person" value={String(card.summary.askedPerson)} note="Caught by asking, not deciding" />
            {card.summary.pending > 0 && <Tile label="Still running" value={String(card.summary.pending)} />}
          </div>
        </section>
        <section aria-label="Planted mistakes" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Each planted mistake and its right answer</h2>
          <div className="tbl"><table>
            <thead><tr><th>Mistake</th><th>Right answer</th><th>Who should catch it</th><th>Result</th></tr></thead>
            <tbody>{card.plants.map(p => { const [tone, label] = RESULT[p.status]; return <tr key={p.key}>
              <td style={{ minWidth: 220 }}><b>{p.label}</b><br /><span style={{ fontSize: 13, color: "#33424A" }}>{p.mistake}</span></td>
              <td style={{ minWidth: 220, fontSize: 13 }}>{p.rightAnswer}</td>
              <td style={{ fontSize: 13 }}>{p.catcher === "checker" ? "Agent 2 · checker" : p.catcher === "lock" ? "The lock" : p.catcher === "investigator" ? "Investigator" : "Mismatch agent"}</td>
              <td style={{ minWidth: 180 }}><span className={`tag ${tone}`}>{label}{p.askedPerson ? " · asked a person" : ""}</span><br /><span style={{ fontSize: 13 }}>{p.detail}</span>{p.link && <><br /><Link href={p.link} style={{ fontSize: 13 }}>Open run</Link></>}</td>
            </tr>; })}</tbody>
          </table></div>
        </section>
      </> : <>
        <section className="eq" aria-label="Batch result">
          <div className="eq-status" role="status"><span style={{ color: card.summary.settled < card.summary.count ? "var(--wait)" : "var(--ok)" }}>{card.summary.line}</span></div>
          <div className="eq-row" style={{ flexWrap: "wrap" }}>
            <Tile label="Deposits" value={String(card.summary.count)} note={`${card.summary.settled} settled`} />
            <Tile label="Time taken" value={card.summary.durationMs === null ? "running" : `${(card.summary.durationMs / 1000).toFixed(1)} s`} note="Import to the last settled deposit" />
            <Tile label="Handled without a person" value={`${card.summary.pctHandled}%`} note={`${card.summary.handledWithoutPerson} ready for sign-off on the first attempt`} />
            <Tile label="Flagged" value={`${card.summary.pctFlagged}%`} note={`${card.summary.flagged} need a person, were rejected or failed`} />
            <Tile label="Matched the right answer" value={`${card.summary.matchedRightAnswer} of ${card.summary.count}`} />
          </div>
        </section>
        <section aria-label="By state" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Where every deposit settled</h2>
          <div className="tbl"><table>
            <thead><tr><th>State</th><th className="r">Deposits</th></tr></thead>
            <tbody>{Object.entries(card.byState).sort((a, b) => b[1] - a[1]).map(([state, n]) => <tr key={state}><td><span className={`tag ${STATE[state]?.tone ?? "t-code"}`}>{STATE[state]?.label ?? "Not started"}</span></td><td className="r n">{n}</td></tr>)}</tbody>
          </table></div>
          <p className="meta">Nothing posts without a person: &ldquo;handled without a person&rdquo; means the agent, checker and lock got it to sign-off on their own.</p>
        </section>
      </>}
      <Link className="btn alt" href="/desk" style={{ alignSelf: "flex-start" }}>Back to the desk</Link>
    </main>
  </MotionRoot>;
}
