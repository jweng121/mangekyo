import type { NormalizedBankTransaction, NormalizedDocument, NormalizedObligation, NormalizedOwner } from "@mangekyo/contracts";
import { formatCents } from "../intake/cents";
import { activeAllocations, type AccountLedgerState } from "../ledger";
import { INSURANCE_POLICY } from "../../fixtures/lawFirmFeed";

/** The invoice rule the mock investigator proposes. Kept here so the backtest and the mock agree on the wording. */
export const INVOICE_POLICY = "A deposit that quotes an open invoice number for the exact amount goes to that invoice's owner.";

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
