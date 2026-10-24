"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { LockResult, MoneyProposal } from "@mangekyo/contracts";
import { FinanceInvestigationView } from "@mangekyo/finance-core";
import { dollarsToCents, formatCents } from "@mangekyo/finance-core/intake";
import { api } from "../../../convex/_generated/api";

type Role = "requester" | "approver";
const DEMO_ACCOUNT = "demo:account:pool-001";

function message(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data;
  return error instanceof Error ? error.message.replace(/^.*Uncaught (ConvexError|Error): /s, "").split("\n")[0] : "Request failed.";
}

function LockView({ lock }: { lock: LockResult }) {
  return <div className={lock.allowed ? "lock allowed" : "lock blocked"} role={lock.allowed ? "status" : "alert"}>
    <strong>{lock.allowed ? `Allowed at ${lock.stage}` : `Blocked at ${lock.stage}`}</strong> · rules checked {lock.evaluated.join(", ")}
    {lock.failures.map((f, i) => <p key={i}><code>{f.rule} {f.code}</code> {f.message}{f.sourceIds.length > 0 && <> · <code>{f.sourceIds.join(", ")}</code></>}</p>)}
  </div>;
}

function DepositInvestigation({ taskId, connected }: { taskId: string; connected: boolean }) {
  const subject = useQuery(api.financeIntake.getDepositSubject, { taskId });
  const investigation = useQuery(api.financeInvestigations.getTaskInvestigation, { taskId });
  const configuration = useQuery(api.financeInvestigations.getProviderConfiguration);
  const start = useMutation(api.financeInvestigations.startInvestigation);
  const answer = useMutation(api.financeInvestigations.answerQuestion);
  if (!subject) return <p role="status">Loading deposit task…</p>;
  return <FinanceInvestigationView subject={{ ...subject, scopeKinds: ["deposit_investigation"] }} investigation={investigation} configuration={configuration} connected={connected}
    onStart={async scope => { try { await start({ taskId, scope }); } catch (error) { throw new Error(message(error)); } }}
    onAnswer={async (runId, questionId, text) => { try { await answer({ runId, questionId, answer: text }); } catch (error) { throw new Error(message(error)); } }} />;
}

export function MoneyPanel({ connected }: { connected: boolean }) {
  const accounts = useQuery(api.financeIntake.listAccounts);
  const [accountId, setAccountId] = useState(DEMO_ACCOUNT);
  // Outstanding items age against the viewer's clock; rounding to the minute keeps the subscription stable.
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  useEffect(() => { const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60_000) * 60_000), 60_000); return () => clearInterval(timer); }, []);
  const overview = useQuery(api.financeIntake.getAccountOverview, accounts?.some(a => a.accountId === accountId) ? { accountId, now: minute + 59_999 } : "skip");
  const autoSetting = useQuery(api.financeInvestigations.getAutoInvestigationSetting);
  const events = useQuery(api.finance.listMoneyEvents, accounts?.some(a => a.accountId === accountId) ? { accountId } : "skip");
  const importErp = useMutation(api.financeIntake.importErpSandbox);
  const loadDemo = useMutation(api.financeIntake.loadDemoFixture);
  const ensureTask = useMutation(api.financeIntake.ensureDepositTask);
  const requestPayment = useMutation(api.financeProposals.requestPayment);
  const approve = useMutation(api.financeProposals.approveProposal);
  const post = useMutation(api.financeProposals.postProposal);
  const reject = useMutation(api.financeProposals.rejectProposal);
  const reverse = useMutation(api.financeProposals.reversePosting);
  const simulateOutflow = useMutation(api.financeIntake.simulateUnrecordedOutflow);
  const simulateSettlement = useMutation(api.financeIntake.simulateSettlement);

  const [role, setRole] = useState<Role>("requester");
  const [names, setNames] = useState<Record<Role, string>>({ requester: "riley", approver: "sam" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastLock, setLastLock] = useState<{ proposalId: string; lock: LockResult } | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ ownerId: "", amount: "", purpose: "", evidence: [] as string[], funding: "" });
  const dev = { role, name: names[role] };

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }
  function show(result: { proposal: MoneyProposal; lock: LockResult | null; alreadyDone: boolean }) {
    if (result.lock) setLastLock({ proposalId: result.proposal.proposalId, lock: result.lock });
    setNotice(result.alreadyDone ? `${result.proposal.proposalId} was already posted; nothing changed.`
      : result.lock && !result.lock.allowed && result.proposal.status !== "blocked" ? `${result.proposal.proposalId}: action refused; it stays ${result.proposal.status}.`
      : `${result.proposal.proposalId} is now ${result.proposal.status}.`);
  }
  function submitPayment(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      let amountCents: number;
      try { amountCents = dollarsToCents(form.amount, "form"); } catch { throw new Error("Enter an amount in dollars with at most two decimals, e.g. 1250.00"); }
      show(await requestPayment({ accountId, ownerId: form.ownerId, amountCents, purpose: form.purpose, evidenceSourceIds: form.evidence, ...(form.funding ? { fundingSourceId: form.funding } : {}), dev }));
    });
  }

  const money = (cents: number | null) => cents === null ? "—" : formatCents(cents, overview?.account.currency ?? "USD");
  const ownerName = (ownerId: string | null | undefined) => ownerId === null ? "Unallocated" : overview?.owners.find(o => o.ownerId === ownerId)?.name ?? ownerId ?? "—";
  const tw = overview?.threeWay;
  const mismatches = tw?.causes.filter(c => c.severity === "mismatch") ?? [];
  const warnings = tw?.causes.filter(c => c.severity === "warning") ?? [];

  return <section aria-label="Client money">
    <h2>Client money <small>synthetic / sandbox</small></h2>
    <div className="dev-banner" role="note">
      <strong>DEV ONLY role switcher.</strong> No sign-in: identities below are unverified labels recorded on every action. The same name in both roles counts as the same person.
      <div className="row">
        <label>Acting as<select value={role} onChange={e => setRole(e.target.value as Role)}><option value="requester">Staff requester</option><option value="approver">Approver</option></select></label>
        <label>Name<input value={names[role]} onChange={e => setNames({ ...names, [role]: e.target.value })} maxLength={40} /></label>
      </div>
      <p>Recorded identity: <code>dev-unverified:{names[role].trim().toLowerCase() || "?"}</code> · role {role}</p>
    </div>

    <div className="row">
      <button disabled={busy || !connected} onClick={() => run(async () => { const r = await importErp({}); setAccountId(r.accountId); setNotice(`ERP import: ${r.inserted} inserted, ${r.updated} updated, ${r.unchanged} unchanged, ${r.entriesInserted} ledger entries, ${r.issues.length} issue(s).`); })}>Import ERP sandbox (seed 42)</button>
      <button disabled={busy || !connected} onClick={() => run(async () => { const r = await loadDemo({}); setAccountId(r.accountId); setNotice(`DEMO fixture: ${r.inserted} inserted, ${r.unchanged} unchanged, ${r.entriesInserted} ledger entries.`); })}>Load DEMO fixture</button>
      {accounts && accounts.length > 0 && <label>Account<select value={accountId} onChange={e => { setAccountId(e.target.value); setTaskId(null); }}>
        {accounts.map(a => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}</select></label>}
    </div>
    {autoSetting && <p role="note">Auto-investigation: <strong>{autoSetting.enabled ? "on" : "off"}</strong> <code>{autoSetting.code}</code> · {autoSetting.message}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {accounts?.length === 0 && <p>No accounts yet. Import the ERP sandbox or load the DEMO fixture.</p>}

    {overview && tw && <>
      <p><code>{overview.account.accountId}</code> · {overview.account.currency} · cutover {new Date(overview.account.openingAsOf).toISOString()} · dataset <code>{overview.account.datasetVersion}</code>
        {overview.account.issues.length > 0 && <> · <strong>{overview.account.issues.length} import issue(s)</strong></>}</p>

      <h3>Three numbers</h3>
      <div className={`three-numbers ${tw.status}`} role={tw.status === "matched" ? "status" : "alert"}>
        <div><span>Bank</span><strong>{money(tw.bank.adjustedCents)}</strong><small>statement {money(tw.bank.statementCents)} {tw.bank.postAnchorCents !== 0 && `+ feed ${money(tw.bank.postAnchorCents)}`} {tw.bank.reconcilingCents !== 0 && `+ reconciling ${money(tw.bank.reconcilingCents)}`} {(tw.bank.outstandingCents ?? 0) !== 0 && `+ outstanding ${money(tw.bank.outstandingCents ?? 0)}`} · cleared {money(tw.bank.clearedCents)} · pending {money(tw.bank.pendingCents)}</small></div>
        <div><span>Books</span><strong>{money(tw.bookCents)}</strong><small>sum of ledger entries</small></div>
        <div><span>Owners total</span><strong>{money(tw.ownersTotalCents)}</strong><small>includes unallocated {money(tw.unallocatedCents)}</small></div>
        <p className="verdict">{tw.status === "matched" ? "Matched" : tw.status === "mismatched" ? `Mismatched · bank − books ${money(tw.differences.bankMinusBook)} · books − owners ${money(tw.differences.bookMinusOwners)}` : "Insufficient data"}</p>
      </div>
      {(overview.reconcilingItems.length > 0 || (tw.outstanding?.length ?? 0) > 0) && <><h4>Reconciling items</h4>
        <p className="hint">Included in the adjusted bank balance. Outstanding payments and deposits in transit become mismatches after {overview.outstandingMaxDays} days unsettled.</p>
        <ul>{overview.reconcilingItems.map(r => <li key={r.sourceId}>Reconciling item {money(r.amountCents)} · {r.description} <code>{r.sourceId}</code></li>)}
          {tw.outstanding?.map(o => <li key={o.entryId}>{o.kind === "outstanding_payment" ? "Outstanding payment" : "Deposit in transit"} {money(o.amountCents)} · {ownerName(o.ownerId)} · {o.ageDays} day{o.ageDays === 1 ? "" : "s"} old{o.bankReference && <> · awaiting bank reference <code>{o.bankReference}</code></>} · <code>{o.sourceIds.join(", ")}</code></li>)}</ul></>}
      {mismatches.length > 0 && <><h4>Causes found by code</h4><ul>{mismatches.map((c, i) => <li key={i}><code>{c.code}</code> {c.message} <code>{c.sourceIds.join(", ")}</code>{c.ownerIds.length > 0 && <> · affects {c.ownerIds.map(ownerName).join(", ")}</>}{c.unattributed && <> · not attributable: all outflows blocked</>}</li>)}</ul></>}
      {warnings.length > 0 && <><h4>Warnings</h4><ul>{warnings.map((c, i) => <li key={i}><code>{c.code}</code> {c.message} <code>{c.sourceIds.join(", ")}</code></li>)}</ul></>}
      {overview.account.accountId === DEMO_ACCOUNT && <p><button className="secondary" disabled={busy || !connected} onClick={() => run(async () => { const r = await simulateOutflow({}); setNotice(r.created ? "Simulated DEMO bank outflow E-001 arrived without a ledger entry." : "E-001 already exists."); })}>DEV: simulate unrecorded bank outflow (scenario E)</button></p>}

      <h3>Owner balances</h3>
      <table><thead><tr><th>Owner</th><th>Posted</th><th>Uncleared</th><th>Holds</th><th>Available</th></tr></thead>
        <tbody>{overview.balances.map(b => <tr key={b.ownerId ?? "unallocated"}><td>{b.name}</td><td>{money(b.postedCents)}</td><td>{money(b.unclearedCents)}</td><td>{money(b.holdsCents)}</td><td><strong>{money(b.availableCents)}</strong></td></tr>)}</tbody></table>

      <h3>Deposits</h3>
      <table><thead><tr><th>Deposit</th><th>Date</th><th>Amount</th><th>From / reference</th><th>Bank</th><th>Status</th><th></th></tr></thead>
        <tbody>{overview.deposits.map(({ transaction: t, status, taskId: existing, allocatedTo }) => <tr key={t.sourceId}>
          <td><code>{t.sourceId}</code></td><td>{new Date(t.bookedAt).toISOString().slice(0, 10)}</td><td>{money(t.amountCents)}</td><td>{t.counterparty} · {t.reference}</td><td>{t.clearing}</td>
          <td><span className={`chip ${status}`}>{status === "historical" ? "in opening balance" : status.replace("_", " ")}</span>{allocatedTo.length > 0 && <> → {allocatedTo.map(ownerName).join(", ")}</>}</td>
          <td>{(status === "unallocated" || status === "proposed" || existing) && <button className="secondary" disabled={busy || !connected} onClick={() => run(async () => { const r = await ensureTask({ accountId, bankSourceId: t.sourceId }); setTaskId(r.taskId); })}>{existing ? "Open investigation" : "Investigate"}</button>}</td>
        </tr>)}</tbody></table>
      {taskId && <div className="nested"><p>Investigation task <code>{taskId}</code> <button className="secondary" onClick={() => setTaskId(null)}>Close</button></p><DepositInvestigation taskId={taskId} connected={connected} /></div>}

      <h3>Proposals and approvals</h3>
      {overview.proposals.length === 0 ? <p>No proposals yet. Allocation proposals arrive from accepted investigations; payments from the request form.</p> :
        overview.proposals.map(p => <article key={p.proposalId} className={`proposal ${p.status}`}>
          <p><span className={`chip ${p.status}`}>{p.status.replace("_", " ")}</span> <strong>{p.kind}</strong> · {money(p.amountCents)} · <code>{p.proposalId}</code></p>
          <p>{p.kind === "payment" ? <>From {ownerName(p.ownerId)} · {p.purpose}{p.fundingSourceId && <> · funded by <code>{p.fundingSourceId}</code></>}</> :
            <>Deposit <code>{p.bankSourceId}</code> → {p.shares?.map(s => `${ownerName(s.ownerId)} ${money(s.amountCents)}`).join(", ")}</>}</p>
          <p>Requested by <code>{p.requestedBy}</code>{p.approvedBy && <> · approved by <code>{p.approvedBy}</code></>} · evidence <code>{p.evidenceSourceIds.join(", ") || "none"}</code></p>
          {p.rejectionReason && <p>Rejected: {p.rejectionReason}</p>}
          {p.blockedReasons && <ul>{p.blockedReasons.map((f, i) => <li key={i}><code>{f.rule} {f.code}</code> {f.message}</li>)}</ul>}
          {p.status === "pending_approval" && <div className="row">
            <button disabled={busy || role !== "approver"} onClick={() => run(async () => show(await approve({ proposalId: p.proposalId, dev })))}>Approve</button>
            <input aria-label={`Rejection reason for ${p.proposalId}`} placeholder="Reason for rejection (required)" value={reasons[p.proposalId] ?? ""} onChange={e => setReasons({ ...reasons, [p.proposalId]: e.target.value })} disabled={role !== "approver"} />
            <button className="danger" disabled={busy || role !== "approver" || !(reasons[p.proposalId] ?? "").trim()} onClick={() => run(async () => show(await reject({ proposalId: p.proposalId, reason: reasons[p.proposalId] ?? "", dev })))}>Reject</button>
          </div>}
          {p.status === "approved" && <button disabled={busy || role !== "approver"} onClick={() => run(async () => show(await post({ proposalId: p.proposalId, dev })))}>Post to ledger</button>}
          {p.status === "posted" && role === "approver" && !overview.entries.some(e => e.reversesEntryId === p.postedEntryIds?.[0]) && <div className="row">
            <input aria-label={`Reversal reason for ${p.proposalId}`} placeholder="Reason for reversal (required)" value={reasons[p.proposalId] ?? ""} onChange={e => setReasons({ ...reasons, [p.proposalId]: e.target.value })} />
            <button className="danger" disabled={busy || !(reasons[p.proposalId] ?? "").trim()} onClick={() => run(async () => { const r = await reverse({ proposalId: p.proposalId, reason: reasons[p.proposalId] ?? "", dev }); setNotice(r.alreadyDone ? "Already reversed." : `Appended ${r.entryIds.length} reversal entries.`); })}>Reverse posting</button>
          </div>}
          {p.status === "posted" && p.kind === "payment" && overview.account.accountId === DEMO_ACCOUNT &&<button className="secondary" disabled={busy} onClick={() => run(async () => { const r = await simulateSettlement({ proposalId: p.proposalId }); setNotice(r.created ? "Simulated DEMO bank settlement arrived." : "Settlement already recorded."); })}>DEV: simulate bank settlement</button>}
          {lastLock?.proposalId === p.proposalId && <LockView lock={lastLock.lock} />}
          {(p.status === "pending_approval" || p.status === "approved") && role !== "approver" && <p className="hint">Switch to the approver role to act.</p>}
        </article>)}

      <h3>Payment request</h3>
      <form onSubmit={submitPayment}>
        <label>Owner<select required value={form.ownerId} onChange={e => setForm({ ...form, ownerId: e.target.value })}><option value="">Choose…</option>{overview.owners.map(o => <option key={o.ownerId} value={o.ownerId}>{o.name}</option>)}</select></label>
        <label>Amount ({overview.account.currency})<input required inputMode="decimal" placeholder="5000.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></label>
        <label>Purpose<input required maxLength={500} value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })} /></label>
        <label>Supporting evidence (sourceIds)<select multiple size={5} value={form.evidence} onChange={e => setForm({ ...form, evidence: [...e.target.selectedOptions].map(o => o.value) })}>
          {[...overview.documents.map(d => ({ id: d.sourceId, label: d.title })), ...overview.obligations.map(o => ({ id: o.sourceId, label: o.excerpt }))].map(o => <option key={o.id} value={o.id}>{o.label} · {o.id}</option>)}</select></label>
        <label>Funded by deposit (optional)<select value={form.funding} onChange={e => setForm({ ...form, funding: e.target.value })}><option value="">Owner balance</option>{overview.deposits.map(d => <option key={d.transaction.sourceId} value={d.transaction.sourceId}>{d.transaction.sourceId} · {money(d.transaction.amountCents)} · {d.transaction.clearing}</option>)}</select></label>
        <button type="submit" disabled={busy || !connected || role !== "requester"}>Submit payment request</button>
        {role !== "requester" && <p className="hint">Switch to the requester role to request a payment.</p>}
      </form>
      {lastLock && overview.proposals.find(p => p.proposalId === lastLock.proposalId)?.kind === "payment" && <><h4>Lock result for {lastLock.proposalId}</h4><LockView lock={lastLock.lock} />
        {lastLock.lock.facts.ownerAvailableCents !== undefined && <p>Pooled account cleared cash {money(lastLock.lock.facts.poolClearedCents as number | null)} · owner available {money(lastLock.lock.facts.ownerAvailableCents as number | null)} · requested {money(lastLock.lock.facts.requestedCents as number | null)}</p>}</>}

      <h3>Posted ledger entries</h3>
      <p>Append-only. Showing the latest {overview.entries.length}.</p>
      <table><thead><tr><th>Effective</th><th>Kind</th><th>Owner</th><th>Amount</th><th>Sources</th><th>By</th></tr></thead>
        <tbody>{overview.entries.map(e => <tr key={e.entryId}><td>{new Date(e.effectiveAt).toISOString().slice(0, 16).replace("T", " ")}</td><td>{e.kind}</td><td>{ownerName(e.ownerId)}</td><td>{money(e.amountCents)}</td><td><code>{e.sourceRefs.join(", ")}</code></td><td><code>{e.createdBy}</code></td></tr>)}</tbody></table>

      <details><summary>Money event stream ({events?.length ?? 0})</summary>
        {events?.map(e => <p key={e.eventId}>#{e.sequence} <code>{e.type}</code> {e.payload.message}{e.payload.reasonCodes.length > 0 && <> · <code>{e.payload.reasonCodes.join(", ")}</code></>}</p>)}</details>
    </>}
  </section>;
}
