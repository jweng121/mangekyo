import type { NormalizedBankTransaction, NormalizedDocument, NormalizedObligation, NormalizedOwner } from "@mangekyo/contracts";
import { formatCents } from "../intake/cents";
import { activeAllocations, type AccountLedgerState } from "../ledger";
import { INSURANCE_POLICY } from "../../fixtures/lawFirmFeed";

/** The invoice rule the mock investigator proposes. Kept here so the backtest and the mock agree on the wording. */
export const INVOICE_POLICY = "A deposit that quotes an open invoice number for the exact amount goes to that invoice's owner.";
/** Memory that became a rule: after a person confirms one partial retainer, the pattern is proposed as a policy and backtested. */
export const PARTIAL_RETAINER_POLICY = "A client's deposit smaller than the retainer in their engagement letter is a partial retainer payment for that client.";

/** Retainer amount an engagement letter states ("Retainer: $5,000.00"), in integer cents, or null. */
export function retainerCents(text: string): number | null {
  const match = /Retainer:\s*\$(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/i.exec(text);
  return match ? Number(match[1].replace(/,/g, "")) * 100 + Number(match[2] ?? 0) : null;
}

/** The client whose engagement letter the deposit matches: linked (or named) letter, payer surname matches, deposit smaller than the retainer. */
export function partialRetainerOwner(deposit: NormalizedBankTransaction, documents: NormalizedDocument[], owners: NormalizedOwner[]): { owner: NormalizedOwner; letter: NormalizedDocument; retainerCents: number } | null {
  const surname = deposit.counterparty.trim().split(/\s+/).at(-1)?.toLowerCase() ?? "";
  if (!surname) return null;
  const letters = documents.filter(d => /engagement/i.test(d.documentType) && (deposit.documentSourceIds.includes(d.sourceId) || d.namedOwnerSourceIds.length > 0));
  for (const letter of letters) {
    const retainer = retainerCents(letter.text);
    if (retainer === null || deposit.amountCents >= retainer) continue;
    const named = owners.filter(o => letter.namedOwnerSourceIds.includes(o.sourceId) && o.name.trim().split(/\s+/).at(-1)?.toLowerCase() === surname);
    if (named.length === 1) return { owner: named[0], letter, retainerCents: retainer };
  }
  return null;
}

/** Label shown wherever an approved policy is relied on. */
export function usedPolicyLabel(policy: { policyId: string; approvedBy?: string | null }): string {
  return `Used policy ${policy.policyId}, approved by ${policy.approvedBy ?? "a person"}`;
}

interface History { deposits: NormalizedBankTransaction[]; documents: NormalizedDocument[]; obligations: NormalizedObligation[]; owners: NormalizedOwner[] }
type Rule = (deposit: NormalizedBankTransaction, history: History) => string | null;

const ownerBySource = (history: History, sourceId: string | null) => history.owners.find(o => o.sourceId === sourceId)?.ownerId ?? null;

/** Statements a backtest can execute. A statement not listed here can't be backtested. */
const RULES: Record<string, Rule> = {
  [INSURANCE_POLICY]: (deposit, history) => {
    const claim = /\bclaim\s+([A-Z]{2,}-\d+)\b/i.exec(deposit.reference)?.[1];
    if (!claim || !/insurance/i.test(deposit.counterparty)) return null;
    const named = new Set(history.documents.filter(d => d.text.toUpperCase().includes(claim.toUpperCase())).flatMap(d => d.namedOwnerSourceIds));
    return named.size === 1 ? ownerBySource(history, [...named][0]) : null;
  },
  [INVOICE_POLICY]: (deposit, history) => {
    const invoice = history.obligations.find(o => o.kind === "invoice" && o.status === "open" && !!o.reference && deposit.reference.includes(o.reference) && o.amountCents === deposit.amountCents);
    return invoice ? ownerBySource(history, invoice.ownerSourceId) : null;
  },
  [PARTIAL_RETAINER_POLICY]: (deposit, history) => partialRetainerOwner(deposit, history.documents, history.owners)?.owner.ownerId ?? null,
};

export interface BacktestCase { bankSourceId: string; label: string; predictedOwnerId: string; decidedOwnerIds: string[]; agrees: boolean }
export interface PolicyBacktest {
  statement: string;
  testable: boolean;
  /** Past deposits a person already decided (posted allocation) that this rule would have handled. */
  handled: number;
  agree: number;
  disagree: number;
  cases: BacktestCase[];
  summary: string;
  /** Any disagreement, or no executable form, means approval needs a written reason. */
  reasonRequired: boolean;
}

/** Replays a proposed rule over every past deposit a person decided. Nothing is written; the result is shown before approval. */
export function backtestPolicy(statement: string, state: AccountLedgerState, history: Omit<History, "deposits" | "owners">): PolicyBacktest {
  const clean = statement.replace(/^For human review: /, "");
  const rule = RULES[clean];
  if (!rule) return { statement: clean, testable: false, handled: 0, agree: 0, disagree: 0, cases: [], reasonRequired: true,
    summary: "Couldn't backtest: this rule has no form code can replay against past deposits. Approving it needs a written reason." };
  const full: History = { ...history, deposits: state.bankTransactions.filter(t => t.direction === "inflow"), owners: state.owners };
  const cases: BacktestCase[] = [];
  for (const deposit of full.deposits) {
    const decided = [...new Set(activeAllocations(state.entries, deposit.sourceId).map(e => e.ownerId!))];
    if (decided.length === 0) continue;
    const predicted = rule(deposit, full);
    if (!predicted) continue;
    cases.push({ bankSourceId: deposit.sourceId, label: `${formatCents(deposit.amountCents, deposit.currency)} from ${deposit.counterparty}`, predictedOwnerId: predicted, decidedOwnerIds: decided, agrees: decided.length === 1 && decided[0] === predicted });
  }
  const agree = cases.filter(c => c.agrees).length;
  const disagree = cases.length - agree;
  const noun = (n: number) => `${n} past deposit${n === 1 ? "" : "s"}`;
  return { statement: clean, testable: true, handled: cases.length, agree, disagree, cases, reasonRequired: disagree > 0,
    summary: `Would have handled ${noun(cases.length)}: ${agree} agree with what people decided, ${disagree} disagree.` };
}
