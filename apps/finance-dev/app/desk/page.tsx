"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useMutation, useQuery, usePaginatedQuery } from "convex/react";
import { ConvexError } from "convex/values";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { LockResult, MoneyProposal } from "@mangekyo/contracts";
import { dollarsToCents } from "@mangekyo/finance-core/intake";
import { api } from "../../../../convex/_generated/api";
import { MotionRoot, prefersReducedMotion } from "../components/MotionRoot";
import { Money } from "../components/Money";
import AnimatedList from "../components/reactbits/AnimatedList";
import { causeLine, describeEvent, money, ownerStatus, personName, progressText, reasonWords, usedPolicy, type Activity, type Names } from "../lib/desk";
import "../mk.css";

type Acting = "sam" | "riley";
type PaymentDraft = { ownerId?: string; amount?: string; purpose?: string; fundingSourceId?: string };
const devFor = (acting: Acting) => acting === "sam" ? { role: "approver" as const, name: "sam" } : { role: "requester" as const, name: "riley" };
const isDemo = (id: string) => /^demo:account:pool-\d+$/.test(id);
const errorText = (e: unknown) => e instanceof ConvexError && typeof e.data === "string" ? e.data : e instanceof Error ? e.message.replace(/^[\s\S]*Uncaught (ConvexError|Error): /, "").split("\n")[0] : "Request failed.";

const OK = <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#0B5563" /><path d="M4.6 8.3 7 10.6l4.4-5" fill="none" stroke="#fff" strokeWidth="1.7" /></svg>;
const BAD = <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#B3261E" /><path d="M8 4.2v4.6M8 10.9v.6" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" /></svg>;

function Bars({ pool, available, requested, ownerName }: { pool: number | null; available: number; requested: number; ownerName: string }) {
  const max = Math.max(pool ?? 0, requested, 1);
  const pct = (v: number) => `${Math.max(0.6, Math.min(100, (Math.max(0, v) / max) * 100)).toFixed(2)}%`;
  const row = (label: string, value: number, color: string, valueColor?: string) => <div>
    <div className="bar-l"><span>{label}</span><span className="n" style={{ color: valueColor }}>{money(value)}</span></div>
    <div className="track"><div className="fill" style={{ width: pct(value), background: color }} /></div></div>;
  return <div className="bars">{row("Pooled account, cleared", pool ?? 0, "var(--ok)")}{row(`${ownerName}, available`, available, "var(--ink)")}{row("Requested", requested, "var(--bad)", "var(--bad)")}</div>;
}

function Card({ tone, tag, tagTone, title, children }: { tone?: "bad" | "wait"; tag: string; tagTone: string; title: ReactNode; children: ReactNode }) {
  return <article className={`card ${tone ?? ""}`}><span className={`tag ${tagTone}`}>{tag}</span><h3>{title}</h3>{children}</article>;
}

export default function Desk() {
  const accounts = useQuery(api.financeIntake.listAccounts);
  const [chosen, setChosen] = useState<string | null>(null);
  const newestDemo = accounts?.map(a => a.accountId).filter(isDemo).sort().at(-1) ?? accounts?.[0]?.accountId ?? null;
  const accountId = chosen ?? newestDemo;
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  useEffect(() => { const t = setInterval(() => setMinute(Math.floor(Date.now() / 60_000) * 60_000), 60_000); return () => clearInterval(t); }, []);
  const overview = useQuery(api.financeIntake.getAccountOverview, accountId ? { accountId, now: minute + 59_999 } : "skip");
  const desk = useQuery(api.financeDesk.getDeskData, accountId ? { accountId } : "skip");
  const activity = usePaginatedQuery(api.financeDesk.getActivity, accountId ? { accountId } : "skip", { initialNumItems: 50 });
  const config = useQuery(api.financeInvestigations.getProviderConfiguration);
  const [acting, setActing] = useState<Acting>("sam");
  const dev = devFor(acting);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [payOpen, setPayOpen] = useState<PaymentDraft | null>(null);

  const m = {
    bounce: useMutation(api.financeIntake.simulateClientBounce), duplicate: useMutation(api.financeIntake.confirmDuplicate),
    fresh: useMutation(api.financeIntake.startFreshDemoRun), outflow: useMutation(api.financeIntake.simulateUnrecordedOutflow), cleared: useMutation(api.financeIntake.simulateDepositCleared),
    settle: useMutation(api.financeIntake.simulateSettlement), record: useMutation(api.financeIntake.recordBankItem), approve: useMutation(api.financeProposals.approveProposal),
    post: useMutation(api.financeProposals.postProposal), reject: useMutation(api.financeProposals.rejectProposal), propose: useMutation(api.financeProposals.proposeAllocation),
    recheck: useMutation(api.financeProposals.recheckHeld), wait: useMutation(api.financeProposals.keepWaiting), cancel: useMutation(api.financeProposals.cancelHeld),
    resume: useMutation(api.financeProposals.continueHeld), answer: useMutation(api.financeInvestigations.answerQuestion),
    feed: useMutation(api.financeIntake.feedNext), policy: useMutation(api.financeProposals.approvePolicy), allProven: useMutation(api.financeProposals.approveAllProven),
  };
  // Live feed: play/pause steps through the scripted DEMO sequence, one import every few seconds. Mock mode only.
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing || !accountId) return;
    let stop = false;
    const tick = async () => {
      setBusy(true);
      try { const r = await m.feed({ accountId }); if (r.done) { setPlaying(false); setToast("Live feed finished. Break it, or request a payment, to keep going."); return; } }
      catch (e) { setPlaying(false); setToast(errorText(e)); return; }
      finally { setBusy(false); }
      if (!stop) timer = setTimeout(tick, 4500);
    };
    let timer = setTimeout(tick, 300);
    return () => { stop = true; clearTimeout(timer); };
  }, [playing, accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3600); return () => clearTimeout(t); }, [toast]);
  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try { await fn(); if (done) setToast(done); } catch (e) { setToast(errorText(e)); } finally { setBusy(false); }
  }
  const outcome = (r: { proposal: MoneyProposal; lock: LockResult | null; alreadyDone: boolean }) =>
    r.alreadyDone ? "Already posted. Nothing changed." : r.proposal.status === "on_hold" ? `On hold, a person will see it: ${r.proposal.hold?.message.replace(/^On hold: /, "")}`
      : r.lock && !r.lock.allowed ? `Refused: ${reasonWords(r.lock.failures.map(f => f.code))}.` : `Done: ${r.proposal.status.replace("_", " ")}.`;

  const names: Names = useMemo(() => ({
    owner: id => overview?.owners.find(o => o.ownerId === id)?.name ?? (id === null ? "Not yet assigned" : "an owner"),
    deposit: sourceId => { const t = overview?.deposits.find(d => d.transaction.sourceId === sourceId)?.transaction; return t ? `${money(t.amountCents)} from ${t.counterparty}` : "a deposit"; },
    proposal: id => overview?.proposals.find(p => p.proposalId === id),
    policy: sourceId => { const p = desk?.approvedPolicies.find(x => x.sourceId === sourceId); return p ? { policyId: p.policyId, approvedBy: p.approvedBy } : undefined; },
  }), [overview, desk]);

  const tw = overview?.threeWay;
  const matched = tw?.status === "matched";
  const slash = useRef<HTMLElement>(null);
  const eqBox = useRef<HTMLElement>(null);
  const first = useRef(true);
  useGSAP(() => {
    if (!tw || !slash.current) return;
    const reduced = prefersReducedMotion();
    const to = { scaleY: matched ? 0 : 1, xPercent: -50, rotate: 28 };
    if (reduced || first.current) gsap.set(slash.current, to);
    else {
      gsap.to(slash.current, { ...to, duration: .45, ease: matched ? "power2.in" : "back.out(2)", overwrite: "auto" });
      if (!matched) gsap.fromTo(eqBox.current, { x: -6 }, { x: 0, duration: .5, ease: "elastic.out(1,0.3)", overwrite: "auto" });
    }
    first.current = false;
  }, { dependencies: [matched, tw === undefined] });

  const proposals = overview?.proposals ?? [];
  const balances = overview?.balances ?? [];
  const available = (ownerId?: string) => balances.find(b => b.ownerId === ownerId)?.availableCents ?? 0;
  const queue: Array<{ key: string; node: ReactNode }> = [];
  const runFor = (bankSourceId?: string) => desk?.tasks.find(t => t.bankSourceId === bankSourceId)?.latestRun ?? null;
  const reasonBox = (key: string, placeholder: string) => <input aria-label={placeholder} placeholder={placeholder} value={inputs[key] ?? ""} onChange={e => setInputs({ ...inputs, [key]: e.target.value })} />;

  for (const d of overview?.deposits.filter(d => d.status === "awaiting_clearance") ?? []) queue.push({ key: `waiting:${d.transaction.sourceId}`, node:
    <Card tone="wait" tag="Bank clearance pending" tagTone="t-wait" title="Waiting for the check to clear">
      <p>{names.deposit(d.transaction.sourceId)}. The agent can review the evidence now, but cannot propose an allocation until the check clears.</p>
      {runFor(d.transaction.sourceId) && <Link className="btn alt sm" href={`/runs/${encodeURIComponent(runFor(d.transaction.sourceId)!.runId)}`}>Open run</Link>}
    </Card> });

  for (const p of proposals.filter(p => p.status === "on_hold")) queue.push({ key: p.proposalId, node:
    <Card tone="wait" tag={p.hold?.ready ? "Ready to continue · a person decides" : "On hold · needs a person"} tagTone={p.hold?.ready ? "t-ok" : "t-wait"} title={p.kind === "payment" ? `${money(p.amountCents)} for ${names.owner(p.ownerId)}` : `${money(p.amountCents)} → ${p.shares?.map(s => names.owner(s.ownerId)).join(", ")}`}>
      <p>{p.hold?.message}</p>
      <span className="meta">Held at the {p.hold?.stage} step · last {p.hold?.lastDecision.replace("_", " ")} by {personName(p.hold?.lastCheckedBy ?? "")} · no money has moved</span>
      <div className="acts">
        {p.hold?.ready && <button className="btn sm" disabled={busy} onClick={() => act(async () => setToast(outcome(await m.resume({ proposalId: p.proposalId, dev }))))}>Continue ({p.hold.stage === "approve" ? "approve" : "post"})</button>}
        <button className="btn alt sm" disabled={busy} onClick={() => act(() => m.recheck({ proposalId: p.proposalId, dev }), "Re-checked. The result is on the card.")}>Re-check now</button>
        <button className="btn alt sm" disabled={busy} onClick={() => act(() => m.wait({ proposalId: p.proposalId, dev }), "Recorded: keep waiting.")}>Keep waiting</button>
      </div>
      <div className="acts">{reasonBox(`cancel:${p.proposalId}`, "Reason to cancel (required)")}<button className="btn alt sm" disabled={busy || !(inputs[`cancel:${p.proposalId}`] ?? "").trim()} onClick={() => act(() => m.cancel({ proposalId: p.proposalId, reason: inputs[`cancel:${p.proposalId}`] ?? "", dev }), "Cancelled. Nothing moved.")}>Cancel with reason</button></div>
    </Card> });

  for (const s of desk?.checkerStopped ?? []) queue.push({ key: `checker:${s.runId}`, node:
    <Card tone="bad" tag="Agent 2 · checker stopped a proposal" tagTone="t-bad" title="A claim isn't supported by its source">
      <p>&ldquo;{s.claim}&rdquo;</p>
      {s.sourceSays && <div className="quote"><span style={{ color: "var(--muted)" }}>What the source actually says:</span><br /><span className="m">{s.sourceSays}</span></div>}
      <p>{s.reason} Nothing was proposed for {names.deposit(s.bankSourceId ?? "")} and no money moved.</p>
      <div className="acts"><Link className="btn sm" href={`/runs/${encodeURIComponent(s.runId)}`}>Open run and fix</Link></div>
    </Card> });

  for (const c of tw?.causes.filter(c => c.code === "BANK_TXN_WITHOUT_LEDGER_ENTRY") ?? []) {
    const txn = overview?.deposits.find(d => d.transaction.sourceId === c.sourceIds[0])?.transaction;
    queue.push({ key: `fix:${c.sourceIds[0]}`, node: <Card tone="bad" tag="Code · fixes the gap" tagTone="t-code" title={`Record the ${money(Math.abs(c.amountCents ?? 0))} bank item against ${c.ownerIds.map(names.owner).join(", ") || "an owner"}`}>
      <p>The bank shows money moving with no ledger entry{txn ? ` (${txn.counterparty})` : ""}. Recording it brings the books back in line. It is a correction, not a payment.</p>
      <span className="meta">Cites the bank transaction · reversible · approver only</span>
      <div className="acts"><button className="btn sm" disabled={busy} onClick={() => act(() => m.record({ accountId: accountId!, bankSourceId: c.sourceIds[0], dev }), "Recorded. Bank, books and owners re-checked.")}>Approve entry</button></div>
    </Card> });
  }

  for (const p of proposals.filter(p => p.kind === "allocation" && (p.status === "pending_approval" || p.status === "approved"))) {
    const run = p.origin.type === "agent" ? p.origin.runId : null;
    const checked = run ? desk?.tasks.find(t => t.latestRun?.runId === run)?.latestRun?.checker ?? null : null;
    const policyNote = usedPolicy(p.evidenceSourceIds, names);
    queue.push({ key: p.proposalId, node: <Card tag={p.origin.type === "agent" ? "AI proposal · needs sign-off" : "Person's proposal · needs sign-off"} tagTone={p.origin.type === "agent" ? "t-ai" : "t-wait"} title={`${money(p.amountCents)} → ${p.shares?.map(s => names.owner(s.ownerId)).join(", ")}`}>
      {policyNote && <span className="tag t-ok">{policyNote}</span>}
      <p>{names.deposit(p.bankSourceId ?? "")}. {p.status === "approved" ? `Approved by ${personName(p.approvedBy ?? "")}; posting re-runs every lock rule.` : "Every lock rule passed when it was proposed. Nothing posts until a person approves and posts it."}</p>
      <span className="meta">Cites {p.evidenceSourceIds.length} source{p.evidenceSourceIds.length === 1 ? "" : "s"}{checked ? ` · checker confirmed ${checked.supported} of ${checked.total} claim${checked.total === 1 ? "" : "s"}` : ""} · requested by {personName(p.requestedBy)}</span>
      <div className="acts">
        {p.status === "pending_approval"
          ? <button className="btn sm" disabled={busy} onClick={() => act(async () => setToast(outcome(await m.approve({ proposalId: p.proposalId, dev }))))}>Approve allocation</button>
          : <button className="btn sm" disabled={busy} onClick={() => act(async () => setToast(outcome(await m.post({ proposalId: p.proposalId, dev }))))}>Post to ledger</button>}
        {run && <Link className="btn alt sm" href={`/runs/${encodeURIComponent(run)}`}>Open run</Link>}
      </div>
      {p.status === "pending_approval" && <div className="acts">{reasonBox(`reject:${p.proposalId}`, "Reason to reject (required)")}<button className="btn alt sm" disabled={busy || !(inputs[`reject:${p.proposalId}`] ?? "").trim()} onClick={() => act(() => m.reject({ proposalId: p.proposalId, reason: inputs[`reject:${p.proposalId}`] ?? "", dev }), "Rejected. The reason is saved for the next run.")}>Reject</button></div>}
    </Card> });
  }

  for (const p of proposals.filter(p => p.kind === "payment" && (p.status === "pending_approval" || p.status === "approved"))) queue.push({ key: p.proposalId, node:
    <Card tag={p.status === "approved" ? "Payment approved · ready to post" : "Payment request · needs a second person"} tagTone="t-wait" title={`${money(p.amountCents)} for ${names.owner(p.ownerId)}`}>
      <p>Requested by {personName(p.requestedBy)} for &ldquo;{p.purpose}&rdquo;. {names.owner(p.ownerId)} has {money(available(p.ownerId))} available after this is reserved. All lock rules passed.</p>
      <div className="acts">
        {p.status === "pending_approval"
          ? <button className="btn sm" disabled={busy} onClick={() => act(async () => setToast(outcome(await m.approve({ proposalId: p.proposalId, dev }))))}>Approve payment</button>
          : <button className="btn sm" disabled={busy} onClick={() => act(async () => setToast(outcome(await m.post({ proposalId: p.proposalId, dev }))))}>Post payment</button>}
      </div>
      {p.status === "pending_approval" && <div className="acts">{reasonBox(`reject:${p.proposalId}`, "Reason to reject (required)")}<button className="btn alt sm" disabled={busy || !(inputs[`reject:${p.proposalId}`] ?? "").trim()} onClick={() => act(() => m.reject({ proposalId: p.proposalId, reason: inputs[`reject:${p.proposalId}`] ?? "", dev }), "Rejected with your reason.")}>Reject</button></div>}
    </Card> });

  for (const q of desk?.questions ?? []) queue.push({ key: q.questionId, node:
    <Card tag="The agent stopped to ask" tagTone="t-wait" title={q.question}>
      <p>It asked instead of guessing. Your answer is saved as a clarification and the next attempt sees it; it is not a financial approval.</p>
      <label className="field">Your answer{reasonBox(`answer:${q.questionId}`, "Type the answer")}</label>
      <div className="acts">
        {overview?.account.datasetVersion === "law-firm-demo-v1" && q.questionId.endsWith(":question:duplicate-or-installment") && <button className="btn sm" disabled={busy || acting !== "riley"} onClick={() => act(() => m.duplicate({ accountId: accountId!, bankSourceId: q.bankSourceId!, dev }), "Duplicate decision saved. Approve its refund-payable allocation as sam before requesting the refund.")}>Mark duplicate for refund as riley</button>}
        <button className="btn sm" disabled={busy || !(inputs[`answer:${q.questionId}`] ?? "").trim()} onClick={() => act(() => m.answer({ runId: q.runId, questionId: q.questionId, answer: inputs[`answer:${q.questionId}`] ?? "" }), "Saved. The agent reruns with your answer.")}>Save answer and resume{config?.mode === "creao" ? " (starts a CREAO run)" : ""}</button>
        <Link className="btn alt sm" href={`/runs/${encodeURIComponent(q.runId)}`}>Open run</Link>
      </div>
    </Card> });

  const owners = overview?.owners ?? [];
  for (const d of overview?.deposits.filter(d => d.status === "unallocated" && !runFor(d.transaction.sourceId)) ?? []) {
    const key = `assign:${d.transaction.sourceId}`;
    queue.push({ key, node: <Card tag="Deposit not assigned yet" tagTone="t-code" title={`${money(d.transaction.amountCents)} from ${d.transaction.counterparty}`}>
      <p>Reference {d.transaction.reference}. {config?.mode === "creao" ? "Automatic investigation is off in CREAO mode, so a person assigns it or starts an investigation from /dev." : "No investigation has run for it."}</p>
      <div className="acts">
        <select aria-label="Owner to assign to" value={inputs[key] ?? ""} onChange={e => setInputs({ ...inputs, [key]: e.target.value })}><option value="">Choose owner…</option>{owners.map(o => <option key={o.ownerId} value={o.ownerId}>{o.name}</option>)}</select>
        <button className="btn alt sm" disabled={busy || !inputs[key]} onClick={() => act(async () => setToast(outcome(await m.propose({ accountId: accountId!, bankSourceId: d.transaction.sourceId, shares: [{ ownerId: inputs[key]!, amountCents: d.transaction.amountCents }], evidenceSourceIds: [d.transaction.sourceId, ...d.transaction.documentSourceIds], purpose: `Assigned by ${dev.name}`, dev }))))}>Propose allocation</button>
      </div>
      <span className="meta">The proposal still needs an approver and passes every lock rule again when posted.</span>
    </Card> });
  }

  for (const p of proposals.filter(p => p.kind === "payment" && p.status === "blocked").slice(0, 3)) {
    const l1 = p.blockedReasons?.some(f => f.rule === "L1");
    const l2 = p.blockedReasons?.some(f => f.rule === "L2");
    const funding = overview?.deposits.find(d => d.transaction.sourceId === p.fundingSourceId)?.transaction;
    queue.push({ key: p.proposalId, node: <Card tone="bad" tag={`Blocked by the lock · ${p.blockedReasons?.map(f => `rule ${f.rule}`).join(", ")}`} tagTone="t-bad" title={`${money(p.amountCents)} for ${names.owner(p.ownerId)} can't go out`}>
      {l1 && <Bars pool={tw?.bank.clearedCents ?? null} available={available(p.ownerId)} requested={p.amountCents} ownerName={names.owner(p.ownerId)} />}
      <p>Requested by {personName(p.requestedBy)}. {l2 && funding ? `At request time, the ${money(funding.amountCents)} ${funding.counterparty.replace(" Insurance", "")} check hadn't cleared yet.` : l1 ? `The account holds ${money(tw?.bank.adjustedCents)}, but ${names.owner(p.ownerId)} has ${money(available(p.ownerId))}. Paying this would use other clients' money.` : `Stopped because ${reasonWords(p.blockedReasons?.map(f => f.code) ?? [])}.`} This request stays blocked in the history.</p>
      {l2 && funding?.clearing === "cleared" && <button className="btn alt sm" disabled={busy || acting !== "riley"} onClick={() => setPayOpen({ ownerId: p.ownerId, amount: (p.amountCents / 100).toFixed(2), purpose: "Delgado client share after clearing", fundingSourceId: p.fundingSourceId })}>Make a new request as riley</button>}
    </Card> });
  }

  const refundOwner = owners.find(o => o.name === "Bayview Title (refund payable)");
  if (refundOwner && available(refundOwner.ownerId) > 0) queue.push({ key: "bayview-refund", node:
    <Card tag="Confirmed duplicate" tagTone="t-wait" title="Return Bayview's duplicate wire">
      <p>The duplicate is assigned to Bayview as a refund payable. Riley requests the refund; sam approves and posts it through every payment lock.</p>
      <button className="btn sm" disabled={busy || acting !== "riley"} onClick={() => setPayOpen({ ownerId: refundOwner.ownerId, amount: "40000.00", purpose: "Refund confirmed duplicate to Bayview Title" })}>Request refund as riley</button>
    </Card> });

  for (const pol of desk?.policies ?? []) queue.push({ key: `${pol.runId}:${pol.policyId}`, node:
    <Card tag="AI · proposed policy" tagTone="t-ai" title={`“${pol.statement.replace(/^For human review: /, "")}”`}>
      <p>Based on a deposit the investigator matched. Once approved, the next matching investigation uses it and says so; it never approves money by itself.</p>
      <div className="acts"><button className="btn sm" disabled={busy} onClick={() => act(async () => { const r = await m.policy({ runId: pol.runId, candidatePolicyId: pol.policyId, dev }); setToast(`Policy ${r.policyId} saved. The agent uses it on the next matching deposit.`); })}>Approve policy</button><Link className="btn alt sm" href={`/runs/${encodeURIComponent(pol.runId)}`}>Open run</Link></div>
    </Card> });

  const working = (desk?.tasks ?? []).flatMap(t => {
    const text = t.latestRun ? progressText(t.latestRun.status, names.deposit(t.bankSourceId ?? ""), null) : null;
    return text ? [text] : [];
  });
  const feed: Activity[] = activity.results.map(e => describeEvent(e, names));
  const cause = tw ? causeLine(tw, names.owner) : null;
  const pool = tw?.bank.clearedCents ?? null;

  return <MotionRoot className="">
    <header className="bar"><div className="wrap bar-in">
      <Link className="brand" href="/" aria-label="Mangekyo home"><img src="/mangekyo-logo.png" alt="" width={34} height={34} />Mangekyo</Link>
      <div className="ctl">
        <label>Acting as (dev only)<select aria-label="Acting as (dev only)" value={acting} onChange={e => setActing(e.target.value as Acting)}><option value="sam">sam, approver</option><option value="riley">riley, requester</option></select></label>
        <label>Account<select aria-label="Account" value={accountId ?? ""} onChange={e => setChosen(e.target.value)}>{accounts?.map(a => <option key={a.accountId} value={a.accountId}>{a.name.replace("Sandbox ERP pooled trust accounts (TRUST-01 + TRUST-02)", "Sandbox ERP (seed 42)")}</option>)}</select></label>
        {accountId && isDemo(accountId) && <button className="btn alt" disabled={busy || desk?.feed.mode !== "mock" || (desk?.feed.stepsDone ?? 0) >= (desk?.feed.total ?? 7)} title={desk?.feed.mode !== "mock" ? "Mock mode only: in CREAO mode investigations cost money" : undefined} onClick={() => setPlaying(!playing)}>
          {desk?.feed.mode !== "mock" ? "Live feed (mock only)" : (desk?.feed.stepsDone ?? 0) >= (desk?.feed.total ?? 7) ? "Feed finished" : playing ? "Pause live feed" : desk?.feed.stepsDone ? `Resume live feed (${desk.feed.stepsDone}/${desk.feed.total})` : "Start live feed"}</button>}
        {accountId && isDemo(accountId) && <button className="btn alt" disabled={busy || playing || desk?.feed.mode !== "mock" || (desk?.feed.stepsDone ?? 0) >= (desk?.feed.total ?? 7)} onClick={() => act(async () => { const result = await m.feed({ accountId }); setToast(result.done ? "Live feed finished." : "One scripted step saved."); })}>Next step</button>}
        {accountId && isDemo(accountId) && <select aria-label="Break it" value="" disabled={busy} onChange={e => {
          const v = e.target.value;
          if (v === "outflow") void act(() => m.outflow({ accountId }), "A wire left the bank with no ledger entry.");
          if (v === "bounce") void act(() => m.bounce({ accountId, dev }), "The bank returned the deposit. Sam must approve the return entry.");
          if (v === "overpay") { setActing("riley"); setPayOpen({ ownerId: owners.find(o => o.name.includes("Owner X"))?.ownerId, amount: "5000.00" }); }
          if (v === "clear") { const d = overview?.deposits.find(x => x.transaction.clearing === "pending"); if (d) void act(() => m.cleared({ bankSourceId: d.transaction.sourceId }), "The pending deposit cleared."); }
        }}><option value="">Break it…</option>{overview?.account.datasetVersion === "law-firm-demo-v1" ? <option value="bounce">Client check bounces</option> : <option value="outflow">Wire leaves with no ledger entry</option>}<option value="overpay">Request more than an owner has</option><option value="clear">A pending deposit clears</option></select>}
        <button className="btn alt" disabled={busy} onClick={() => act(async () => { const r = await m.fresh({}); setChosen(r.accountId); }, "Fresh DEMO run loaded. Earlier runs are unchanged.")}>Fresh DEMO run</button>
        <button className="btn" onClick={() => setPayOpen({})}>New payment</button>
      </div>
    </div></header>
    <div className="wrap proto">{config?.mode === "creao" ? "CREAO mode · investigations cost money" : config?.mode === "mock" && overview?.account.datasetVersion === "law-firm-demo-v1" ? "Sample data · fictional law firm · agents simulated" : config?.mode === "mock" ? "Sample data · agents simulated" : "Provider mode not configured"}</div>

    <main className="wrap desk">
      {!overview || !tw ? <p className="empty">{accounts?.length === 0 ? "No accounts yet. Use Fresh DEMO run to load one." : "Loading the account…"}</p> : <>
        <section className="eq" aria-label="Reconciliation" ref={eqBox}>
          <div className="eq-status" role="status">{matched ? OK : BAD}<span style={{ color: matched ? "var(--ok)" : "var(--bad)" }}>{matched ? "Matched · every dollar has an owner" : tw.status === "insufficient_data" ? "Can't reconcile yet: no bank statement" : `Doesn't reconcile: ${money(Math.abs(tw.differences.bankMinusBook ?? tw.differences.bookMinusOwners))} gap`}</span></div>
          <div className="eq-row">
            <div className="fig"><span className="label">Bank, adjusted</span><b className="n"><Money cents={tw.bank.adjustedCents} /></b></div>
            <div className="op" aria-hidden="true">=<i className="slash" ref={slash} /></div>
            <div className="fig"><span className="label">Books</span><b className="n"><Money cents={tw.bookCents} /></b></div>
            <div className="op" aria-hidden="true">=</div>
            <div className="fig"><span className="label">Every owner, added up</span><b className="n"><Money cents={tw.ownersTotalCents} /></b></div>
          </div>
          {cause && <p className="eq-note">{cause}</p>}
          {(overview.reconcilingItems.length > 0 || (tw.outstanding?.length ?? 0) > 0) && <div>
            <span className="eyebrow">Reconciling items</span>
            <ul className="recon">
              {overview.reconcilingItems.map(r => <li key={r.sourceId}><span>{r.detailed ? "Timing adjustment" : "Timing adjustment, reported without line items · flagged, not hidden"}</span><span className="n">{money(r.amountCents)}</span></li>)}
              {tw.outstanding?.map(o => <li key={o.entryId}><span>{o.kind === "outstanding_payment" ? "Outstanding payment" : "Deposit in transit"} · {names.owner(o.ownerId)} · {o.ageDays === 0 ? "today" : `${o.ageDays} day${o.ageDays === 1 ? "" : "s"} old`} · not yet at the bank (limit {overview.outstandingMaxDays} days)</span><span className="n">{money(o.amountCents)}</span></li>)}
            </ul></div>}
          <div className="counts"><span><b className="n">{desk?.counts.autoStarted ?? 0}</b> started automatically</span><span><b className="n">{queue.length}</b> waiting on a person</span><span><b className="n">{desk?.counts.blocked ?? 0}</b> blocked by the lock</span><span><b className="n">{desk?.counts.posted ?? 0}</b> posted after sign-off</span></div>
        </section>

        <div className="cols">
          <section className="col-side" aria-label="Needs a person">
            <div className="colhead"><h2>Needs a person <span className="m" style={{ fontSize: 14, color: "var(--muted)" }}>{queue.length}</span></h2>
              <button className="btn alt sm" disabled={busy || !proposals.some(p => p.kind === "allocation" && p.status === "pending_approval" && usedPolicy(p.evidenceSourceIds, names))} onClick={() => act(async () => { const r = await m.allProven({ accountId: accountId!, dev }); setToast(`Approved ${r.approved.length} proven item${r.approved.length === 1 ? "" : "s"} as ${dev.name}. ${r.skipped.length} still need one-by-one review.`); })}>Approve all proven items</button></div>
            {queue.length === 0 ? <div className="empty">Nothing needs a person right now.</div> : queue.map(item => <div key={item.key}>{item.node}</div>)}
          </section>
          <section className="col-main" aria-label="Activity">
            <div className="colhead"><h2>Activity</h2><span className="m" style={{ fontSize: 12, color: "var(--muted)" }}>Newest first · from saved events</span></div>
            <div className="feed" aria-live="polite">
              {working.map(text => <div key={text} className="working">{text}</div>)}
              {feed.length === 0 ? <p className="empty" style={{ margin: "12px 0" }}>No activity yet.</p> :
                <AnimatedList items={feed.map(a => ({ id: a.id, title: a.text }))} animation="none" frame={false} theme="light" showGradients={false} selectOnHover={false} enableArrowNavigation={false} maxHeight={560} gap={0} width="100%"
                  renderItem={(_, index) => { const a = feed[index]; return <div className="ev"><span className="tm">{new Date(a.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span><div className="tx"><b>{a.text}</b>{a.sub && <span className="sub">{a.sub}</span>}<span className={`who ${a.tone}`}>{a.who}</span></div></div>; }} />}
            </div>
            {activity.status !== "Exhausted" && <button className="btn alt sm" disabled={activity.status !== "CanLoadMore"} onClick={() => activity.loadMore(50)}>{activity.status === "LoadingMore" ? "Loading activity" : "Load older activity"}</button>}
          </section>
        </div>

        <section aria-label="Owners" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="colhead"><h2 style={{ fontSize: 18, margin: 0 }}>Owners</h2><span style={{ fontSize: 13, color: "var(--muted)" }}>Pooled account cleared cash: <b className="n"><Money cents={pool} /></b></span></div>
          <div className="tbl"><table>
            <thead><tr><th>Owner</th><th className="r">Posted</th><th className="r">Not cleared</th><th className="r">Available</th><th>Status</th></tr></thead>
            <tbody>{balances.map(b => { const s = ownerStatus(b, tw); return <tr key={b.ownerId ?? "unallocated"}>
              <td style={b.ownerId === null ? { color: "var(--muted)" } : undefined}>{b.ownerId === null ? "Not yet assigned" : b.name}</td>
              <td className="r n"><Money cents={b.postedCents} /></td><td className="r n">{money(b.unclearedCents)}</td><td className="r n" style={{ fontWeight: 700 }}><Money cents={b.availableCents} /></td>
              <td>{s.tone === "none" ? <span style={{ color: "var(--muted)", fontSize: 13 }}>{s.text}</span> : <span className={`tag t-${s.tone}`}>{s.text}</span>}</td></tr>; })}</tbody>
          </table></div>
        </section>
      </>}
    </main>
    {payOpen && overview && <PaymentDialog accountId={accountId!} acting={acting} initial={payOpen} overview={overview} onClose={() => setPayOpen(null)} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </MotionRoot>;
}

type Overview = NonNullable<ReturnType<typeof useQuery<typeof api.financeIntake.getAccountOverview>>>;

function PaymentDialog({ accountId, acting, initial, overview, onClose }: { accountId: string; acting: Acting; initial: PaymentDraft; overview: Overview; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useMutation(api.financeProposals.requestPayment);
  const [ownerId, setOwnerId] = useState(initial.ownerId ?? overview.owners[0]?.ownerId ?? "");
  const ownerName = overview.owners.find(o => o.ownerId === ownerId)?.name ?? "";
  const docsFor = (name: string) => overview.documents.filter(d => d.title.includes(name) || d.excerpt.includes(name));
  const [amount, setAmount] = useState(initial.amount ?? "1000.00");
  const [purpose, setPurpose] = useState(initial.purpose ?? "Settlement distribution");
  const [doc, setDoc] = useState("");
  const [result, setResult] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  const reduced = () => prefersReducedMotion();
  useEffect(() => { setDoc(docsFor(ownerName)[0]?.sourceId ?? ""); }, [ownerName]); // eslint-disable-line react-hooks/exhaustive-deps
  useGSAP(() => {
    dialog.current?.showModal();
    if (!reduced()) gsap.fromTo(dialog.current, { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: .25, ease: "power2.out", overwrite: "auto" });
  }, []);
  function close() {
    if (reduced()) { dialog.current?.close(); onClose(); return; }
    gsap.to(dialog.current, { y: 16, opacity: 0, duration: .2, ease: "power2.in", overwrite: "auto", onComplete: () => { dialog.current?.close(); onClose(); } });
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    let cents: number;
    try { cents = dollarsToCents(amount, "form"); } catch { setResult(<p style={{ color: "var(--bad)", margin: 0 }}>Enter an amount like 1250.00 (at most two decimals).</p>); return; }
    setBusy(true);
    try {
      const r = await request({ accountId, ownerId, amountCents: cents, purpose, evidenceSourceIds: doc ? [doc] : [], ...(initial.fundingSourceId ? { fundingSourceId: initial.fundingSourceId } : {}), dev: devFor(acting) });
      const l1 = r.lock?.failures.some(f => f.rule === "L1");
      const avail = overview.balances.find(b => b.ownerId === ownerId)?.availableCents ?? 0;
      setResult(r.proposal.status === "blocked" ? <div className="card bad" style={{ padding: 14 }}>
        <span className="tag t-bad">Blocked by the lock · {r.lock?.failures.map(f => `rule ${f.rule}`).join(", ")}</span>
        {l1 && <Bars pool={overview.threeWay.bank.clearedCents} available={avail} requested={cents} ownerName={ownerName} />}
        <p>{l1 ? `To send this, ${ownerName} needs ${money(cents - Math.max(0, avail))} more in cleared funds. The pool's cash belongs to other owners.` : `Stopped because ${reasonWords(r.lock?.failures.map(f => f.code) ?? [])}.`}</p></div>
        : <p style={{ margin: 0, color: "var(--ok)" }}>Allowed. Sent to a second person for approval.</p>);
    } catch (err) { setResult(<p style={{ color: "var(--bad)", margin: 0 }}>{errorText(err)}</p>); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} aria-labelledby="payTitle" onCancel={e => { e.preventDefault(); close(); }}>
    <form className="dlg" onSubmit={submit}>
      <h2 id="payTitle" style={{ margin: 0, fontSize: 20 }}>Request a payment</h2>
      <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>Requested as <b>{acting === "sam" ? "sam, approver" : "riley, requester"}</b>. The lock checks the owner&apos;s own money, not the pool&apos;s.</p>
      {acting === "sam" && <p style={{ margin: 0, fontSize: 13, color: "var(--wait)" }}>Requests need the requester role; switch &ldquo;Acting as&rdquo; to riley.</p>}
      <label className="field">Owner<select value={ownerId} onChange={e => { setOwnerId(e.target.value); setResult(null); }}>{overview.owners.map(o => <option key={o.ownerId} value={o.ownerId}>{o.name}</option>)}</select></label>
      <label className="field">Amount (USD)<input inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setResult(null); }} /></label>
      <label className="field">Purpose<input value={purpose} onChange={e => setPurpose(e.target.value)} /></label>
      <label className="field">Supporting document<select value={doc} onChange={e => setDoc(e.target.value)}><option value="">None (the lock will refuse)</option>{overview.documents.map(d => <option key={d.sourceId} value={d.sourceId}>{d.title}</option>)}</select></label>
      {result}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="btn" type="submit" disabled={busy || acting !== "riley"}>Check and request</button><button className="btn alt" type="button" onClick={close}>Close</button></div>
    </form>
  </dialog>;
}
