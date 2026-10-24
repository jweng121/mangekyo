import type { AnyFinanceEvent, MoneyProposal, OwnerBalance, ThreeWayCheckResult } from "@mangekyo/contracts";
import { formatCents } from "@mangekyo/finance-core/intake";

/** Money for people: tabular, real minus sign, never internal IDs. */
export function money(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "—";
  return formatCents(cents, currency).replace(/^-/, "−");
}

/** "dev-unverified:sam" → "sam"; real auth identities stay opaque but short. */
export function personName(identity: string): string {
  if (identity.startsWith("dev-unverified:")) return identity.slice("dev-unverified:".length);
  if (identity.startsWith("agent:")) return "Agent";
  if (identity.startsWith("system:") || identity.startsWith("import:")) return "System";
  return identity.length > 24 ? `${identity.slice(0, 21)}…` : identity;
}

export type Tone = "agent" | "code" | "system" | "person" | "bad";
export interface Activity { id: string; at: number; who: string; tone: Tone; text: string; sub?: string }

export interface Names { owner(id: string | null | undefined): string; deposit(sourceId: string): string; proposal(id: string | null): MoneyProposal | undefined; policy?(sourceId: string): { policyId: string; approvedBy: string | null } | undefined }

/** "Used policy P-1, approved by sam" when a proposal cites an approved policy. */
export function usedPolicy(evidence: string[], names: Names): string | null {
  for (const id of evidence) { const p = names.policy?.(id); if (p) return `Used policy ${p.policyId}${p.approvedBy ? `, approved by ${personName(p.approvedBy)}` : ""}`; }
  return null;
}

const REASON: Record<string, string> = {
  OWNER_INSUFFICIENT_FUNDS: "the owner doesn't have enough money",
  FUNDS_NOT_CLEARED: "the money hasn't cleared",
  MISSING_EVIDENCE: "no supporting document was cited",
  SELF_APPROVAL: "the requester can't approve their own request",
  RECONCILIATION_MISMATCH: "the bank and the books don't agree",
  AMOUNT_INTEGRITY: "the amounts don't add up",
  STATE: "that step isn't allowed now",
};
export const reasonWords = (codes: string[]) => [...new Set(codes)].map(code => REASON[code] ?? code.toLowerCase().replace(/_/g, " ")).join("; ");

function proposalLabel(p: MoneyProposal | undefined, names: Names): string {
  if (!p) return "a request";
  return p.kind === "payment" ? `payment of ${money(p.amountCents)} for ${names.owner(p.ownerId)}` : `${money(p.amountCents)} → ${p.shares?.map(s => names.owner(s.ownerId)).join(", ")}`;
}

/** Replaces internal record IDs in backend messages with names people use. */
export function scrubIds(text: string, names: Names): string {
  return text.replace(/\b(?:demo|erp|bank|intake)(?::[\w@-]+)+(?:\.\w+)?/g, id => {
    if (/(^|:)owner:/.test(id)) return names.owner(id);
    if (/bank:txn:/.test(id)) { const d = names.deposit(id); return d === "a deposit" ? "the bank item" : d; }
    return "a record";
  });
}

/** Plain-English activity row for any stored event. */
export function describeEvent(e: AnyFinanceEvent, names: Names): Activity {
  const row = describeRaw(e, names);
  return { ...row, text: scrubIds(row.text, names), sub: row.sub === undefined ? undefined : scrubIds(row.sub, names) };
}

function describeRaw(e: AnyFinanceEvent, names: Names): Activity {
  const base = { id: e.eventId, at: e.timestamp };
  const actor = e.actor.type === "human" ? { who: personName(e.actor.identity), tone: "person" as Tone } : null;
  if (e.type.startsWith("finance.money.")) {
    const m = e as Extract<AnyFinanceEvent, { type: `finance.money.${string}` }>;
    const p = names.proposal(m.payload.proposalId);
    const label = proposalLabel(p, names);
    switch (m.type) {
      case "finance.money.import_completed": return { ...base, who: "Import", tone: "code", text: m.payload.message.replace(/^(erp|demo) import: /, "Imported: "), sub: "Running it again changes nothing." };
      case "finance.money.auto_investigation": {
        const deposit = names.deposit(m.payload.sourceIds[0] ?? "");
        return m.payload.allowed
          ? { ...base, who: "System", tone: "system", text: `Investigation started automatically for ${deposit}` }
          : { ...base, who: "System", tone: "system", text: `Not started automatically: ${deposit}`, sub: m.payload.message.split(": ").slice(1).join(": ") };
      }
      case "finance.money.lock_checked": {
        const step = /at (request|approve|post)/.exec(m.payload.message)?.[1];
        const when = step === "request" ? " when requested" : step === "approve" ? " at approval" : step === "post" ? " at posting" : "";
        return m.payload.allowed
          ? { ...base, who: "Code · the lock", tone: "code", text: `All lock rules passed${when} for the ${label}` }
          : { ...base, who: "Code · the lock", tone: "bad", text: `Stopped the ${label}`, sub: `Because ${reasonWords(m.payload.reasonCodes)}.` };
      }
      case "finance.money.proposal_transitioned": {
        const to = /→ (\w+)/.exec(m.payload.message)?.[1] ?? "";
        const verbs: Record<string, string> = { proposed: "Created", pending_approval: "Sent for sign-off:", approved: "Approved", posted: "Posted", rejected: "Rejected", blocked: "Blocked by the lock:", on_hold: "Put on hold:", cancelled: "Cancelled" };
        const who = actor ?? (p?.requestedBy.startsWith("agent:") ? { who: "Agent", tone: "agent" as Tone } : { who: "System", tone: "system" as Tone });
        const policyNote = p ? usedPolicy(p.evidenceSourceIds, names) : null;
        return { ...base, ...who, tone: to === "blocked" ? "bad" : who.tone, text: `${verbs[to] ?? to} ${label}`, sub: to === "posted" ? "New ledger entry · nothing deleted" : policyNote ?? undefined };
      }
      case "finance.money.ledger_posted": return { ...base, ...(actor ?? { who: "System", tone: "system" as Tone }), text: m.payload.message.replace(/; three-way check is (\w+)\./, " · bank, books and owners $1"), sub: `For the ${label}` };
      case "finance.money.bank_item_recorded": return { ...base, ...(actor ?? { who: "Bank feed", tone: "code" as Tone }), text: m.payload.message.replace(/demo:[^ ]*:?bank:txn:/g, "").replace(/\(simulated\)/, "· simulated") };
      case "finance.money.policy_approved": return { ...base, ...(actor ?? { who: "System", tone: "system" as Tone }), text: m.payload.message.replace(/ The next matching investigation will use it\.$/, ""), sub: "The next matching investigation uses it." };
      case "finance.money.feed_step": return { ...base, who: "Live feed", tone: "system", text: m.payload.message, sub: "Scripted DEMO activity · mock mode" };
      case "finance.money.hold_updated": return { ...base, ...(actor ?? { who: "System", tone: "system" as Tone }), text: `Hold on the ${label}: ${m.payload.message.split(": ").slice(1).join(": ") || m.payload.message}` };
    }
  }
  const message = "payload" in e && "message" in e.payload ? e.payload.message : "";
  if (e.type === "finance.checker.completed" || e.type === "finance.checker.rejected") {
    return { ...base, who: "Agent 2 · checker", tone: e.type === "finance.checker.rejected" ? "bad" : "agent", text: e.type === "finance.checker.rejected" ? "Checker stopped a proposal" : "Checker confirmed the claims it could judge", sub: message };
  }
  const agentTypes = new Set(["finance.provider.result_received", "finance.investigation.completed", "finance.question.raised"]);
  const codeTypes = new Set(["finance.evidence.retrieved", "finance.checks.completed", "finance.validation.failed"]);
  const titles: Record<string, string> = {
    "finance.task.created": "Deposit saved for investigation", "finance.investigation.started": "Investigation started", "finance.evidence.retrieved": "Gathered evidence",
    "finance.checks.completed": "Ran the code checks", "finance.provider.started": "Sent the frozen evidence to the investigator", "finance.provider.result_received": "Investigator answered; checking it",
    "finance.validation.failed": "Rejected the investigator's answer", "finance.investigation.failed": "Investigation failed", "finance.question.raised": "Asked a question instead of guessing",
    "finance.clarification.saved": "Answer saved for the next run", "finance.investigation.resumed": "Rerunning with the saved answer", "finance.investigation.completed": "Investigation finished",
  };
  const who = actor ?? (agentTypes.has(e.type) ? { who: "Agent", tone: "agent" as Tone } : codeTypes.has(e.type) ? { who: "Code", tone: "code" as Tone } : { who: "System", tone: "system" as Tone });
  return { ...base, ...who, tone: e.type.endsWith("failed") ? "bad" : who.tone, text: titles[e.type] ?? e.type, sub: message.replace(/^SIMULATED: /, "Mock agent: ") };
}

/** Specific progress text for an active run; never "Processing…". */
export function progressText(status: string, deposit: string, external: string | null): string | null {
  switch (status) {
    case "queued": return `Queued: about to gather evidence for ${deposit}`;
    case "retrieving_evidence": return `Freezing the records the agent may see for ${deposit}`;
    case "checking": return `Running the code checks on ${deposit}`;
    case "provider_starting": return `Sending the frozen evidence for ${deposit} to the investigator`;
    case "provider_pending": return `Investigator is reading the evidence for ${deposit}${external ? " (CREAO run in progress)" : ""}`;
    case "validating": return `Checking every citation in the investigator's answer for ${deposit}`;
    default: return null;
  }
}

/** Owner status in words; colour is never the only signal. */
export function ownerStatus(b: OwnerBalance, threeWay: ThreeWayCheckResult): { tone: "ok" | "wait" | "bad" | "none"; text: string } {
  const affected = threeWay.status !== "matched" && threeWay.causes.some(c => c.severity === "mismatch" && (c.unattributed || (b.ownerId !== null && c.ownerIds.includes(b.ownerId))));
  if (b.ownerId !== null && affected) return { tone: "wait", text: "Payments on hold: books don't reconcile" };
  if (b.availableCents < 0) return { tone: "bad", text: "Overdrawn" };
  if (b.holdsCents > 0) return { tone: "wait", text: `${money(b.holdsCents)} reserved for a payment` };
  if (b.unclearedCents > 0) return { tone: "wait", text: `${money(b.unclearedCents)} waiting to clear` };
  if (b.ownerId === null) return b.postedCents > 0 ? { tone: "wait", text: "Waiting to be assigned" } : { tone: "none", text: "None open" };
  return { tone: "none", text: "Normal" };
}

/** One plain line for the first code-found mismatch cause. */
export function causeLine(threeWay: ThreeWayCheckResult, owner: (id: string) => string): string | null {
  const cause = threeWay.causes.find(c => c.severity === "mismatch");
  if (!cause) return null;
  const who = cause.unattributed ? "All payments are on hold until it's fixed." : cause.ownerIds.length ? `Payments for ${cause.ownerIds.map(owner).join(", ")} are on hold until it's fixed.` : "";
  const what: Record<string, string> = {
    BANK_TXN_WITHOUT_LEDGER_ENTRY: `${money(Math.abs(cause.amountCents ?? 0))} moved at the bank with no ledger entry.`,
    OUTSTANDING_ITEM_AGED: `A posted ${money(Math.abs(cause.amountCents ?? 0))} item still hasn't reached the bank.`,
    DUPLICATE_POSTING: "A bank transaction was recorded twice.",
    AMOUNT_MISMATCH: "A bank amount and its ledger entry differ.",
    NO_OPENING_BALANCE: "There's no bank statement for this date.",
  };
  return `Found by code: ${what[cause.code] ?? cause.message} ${who}`.trim();
}
