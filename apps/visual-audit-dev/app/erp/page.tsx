"use client";
import { useState, type ReactNode } from "react";
import { trustClients as companies } from "../../lib/demo-trust-records";
import "./erp.css";

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) { return <div className={`paper-field ${wide ? "wide" : ""}`}><label>{label}</label><div>{children}</div></div>; }
function CheckBox({ checked = false, children }: { checked?: boolean; children: ReactNode }) { return <span className="paper-check"><i>{checked ? "\u2713" : ""}</i>{children}</span>; }
function Document({ title, code, children }: { title: string; code: string; children: ReactNode }) { return <article className="trust-paper" data-document-page><header className="paper-heading"><h1>{title}</h1><div className="paper-brand">HARBOR TRUST<small>Trust &amp; fiduciary services</small></div></header><div className="paper-office"><strong>OFFICE USE ONLY</strong><span>Document {code}</span><span>Account HT-4821</span></div>{children}<footer className="paper-footer"><span>Harbor Trust Services / Fictional training document<br/>Prepared for demonstration only. No customer funds or executed signatures.</span><span>{code} / Rev. 10/26<br/>Page 1 of 1</span></footer></article>; }

export default function ErpPage() {
  const [view, setView] = useState("bank");
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("Client A");
  const [proposal, setProposal] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const allocation = companies.find(item => item.name === owner)!;
  const visible = companies.filter(item => `${item.name} ${item.legal} ${item.code}`.toLowerCase().includes(search.toLowerCase()));
  async function saveDraft() {
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/demo-ledger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner, bankLine: "1042" }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setProposal(`Draft proposal: ${data.draft.client} for bank line 1042. No ledger write.`);
    } catch (cause) { setError((cause as Error).message); } finally { setSaving(false); }
  }
  return <main className="trust-document-workspace"><nav className="document-nav" aria-label="Source records"><strong>Harbor Trust / Source records</strong>{[["bank","Bank statement"],["invoices","Trust funding form"],["customers","Client register"],["allocation","Allocation entry"]].map(([id,label]) => <button key={id} data-testid={`nav-${id}`} onClick={() => setView(id)} aria-current={view === id ? "page" : undefined}>{label}</button>)}</nav>
    {(view === "bank" || view === "invoices") && <iframe className="erp-source-pdf" title={view === "bank" ? "Bank statement PDF" : "Trust funding instruction PDF"} src={`/api/demo-documents/${view === "bank" ? "bank" : "funding"}`}/>}
    {view === "customers" && <section className="register-page"><header><h1>Trust client register</h1><span>Read-only / Synthetic records</span></header><label htmlFor="company-search">Search client or payment reference</label><input id="company-search" data-testid="company-search" value={search} onChange={event => setSearch(event.target.value)}/><table className="paper-table"><thead><tr><th>Client</th><th>Legal entity</th><th>Payment code</th><th>Trust owner</th><th>Liability account</th><th>Funding reference</th></tr></thead><tbody>{visible.map(company => <tr key={company.id} data-testid={`company-${company.id}`}><td>{company.name}</td><td>{company.legal}</td><td data-testid={`code-${company.id}`}>{company.code}</td><td data-testid={`owner-${company.id}`}>{company.trust}</td><td>{company.account}</td><td>{company.invoice}</td></tr>)}</tbody></table></section>}
    {view === "allocation" && <Document title="Trust Receipt Allocation Worksheet" code="AL-1042">
      <p className="paper-instruction">Prepare a draft allocation. This worksheet does not authorize a trust ledger posting.</p><h2 className="paper-section">1. RECEIPT IDENTIFICATION</h2><div className="paper-grid"><Field label="Bank transaction">1042 / EFT-231042</Field><Field label="Value date">October 23, 2026</Field><Field label="Bank payment reference">B-204 / Beacon deposit</Field><Field label="Amount received">CAD 5,000.00</Field></div>
      <h2 className="paper-section">2. PROPOSED CLIENT ALLOCATION</h2><div className="paper-grid"><Field label="Client / beneficial owner" wide><select aria-label="Proposed client" data-testid="owner-select" value={owner} onChange={event => { setOwner(event.target.value); setProposal(""); }}>{companies.map(company => <option key={company.id} value={company.name}>{company.legal} ({company.name})</option>)}</select></Field><Field label="Client payment code">{allocation.code}</Field><Field label="Funding reference">{allocation.invoice}</Field><Field label="Trust liability account" wide>{allocation.account} / {allocation.trust}</Field></div>
      <h2 className="paper-section">3. PROPOSED JOURNAL / NOT POSTED</h2><table className="paper-table"><thead><tr><th>Account</th><th>Description</th><th>Debit (CAD)</th><th>Credit (CAD)</th></tr></thead><tbody><tr><td>1100-4821</td><td>Pooled client trust bank</td><td className="money">5,000.00</td><td className="money">-</td></tr><tr><td>{allocation.account}</td><td>{allocation.trust}</td><td className="money">-</td><td className="money">5,000.00</td></tr></tbody><tfoot><tr><td colSpan={2}>Totals</td><td className="money">5,000.00</td><td className="money">5,000.00</td></tr></tfoot></table>
      <h2 className="paper-section">4. REVIEW AND AUTHORIZATION</h2><div className="paper-options"><CheckBox checked>Draft preparation only</CheckBox><CheckBox>Approved for posting</CheckBox></div><div className="paper-grid"><Field label="Prepared by">Deposit Matching Agent</Field><Field label="Reviewer approval">Pending</Field></div><div className="paper-note"><p>Saving creates an allocation draft record. No cash movement, client ledger entry, or financial posting is executed.</p></div><div className="paper-actions"><button data-testid="proposal-submit" disabled={saving} onClick={saveDraft}>{saving ? "Saving..." : "Prepare proposal"}</button></div>{error && <p role="alert">{error}</p>}{proposal && <p className="paper-confirmation" data-testid="proposal-result">{proposal}</p>}
    </Document>}
  </main>;
}
