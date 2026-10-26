import { evaluatePayment, type GatewayContext } from "@mangekyo/finance-core/gateway";
import { importLedgerEntries, threeWayCheck, type AccountLedgerState } from "@mangekyo/finance-core/ledger";
import { lawFirmBundle } from "@mangekyo/finance-core/fixtures/law-firm";
import { ownerBalances, type BankRow } from "./erp-demo-model";

/** Replay the historical request at its original cutoff, before the bank paid it. */
export function evaluateHayesRequest(rows: BankRow[], clients: Array<{ id: string; name: string }>) {
  const paymentIndex = rows.findIndex(row => row.id === "cho-expert-payment");
  if (paymentIndex < 0) throw new Error("Hayes payment is missing from the ERP export");
  const payment = rows[paymentIndex];
  const prior = rows.slice(0, paymentIndex);
  const balances = ownerBalances(prior);
  const ownerCents = balances[payment.clientId ?? ""] ?? 0;
  const poolCents = prior.at(-1)?.balanceCents ?? 0;
  const amountCents = -payment.amountCents;
  const cutoff = Date.parse(`${payment.postedDate}T00:00:00Z`);
  const bundle = lawFirmBundle();
  bundle.account.openingAsOf = cutoff;
  bundle.owners = [...clients.map(client => ({
    sourceId: `hartwell:client:${client.id}`, ownerId: `hartwell:owner:${client.id}`,
    accountId: bundle.account.accountId, subAccount: "IOLTA", name: client.name,
    raw: { system: "demo" as const, recordType: "client", rawId: client.id, datasetVersion: "hartwell-2026-10" },
  })), { sourceId: "hartwell:client:firm", ownerId: "hartwell:owner:firm",
    accountId: bundle.account.accountId, subAccount: "IOLTA", name: "Hartwell & Moreno LLP",
    ownerKind: "firm", raw: { system: "demo" as const, recordType: "firm-ledger", rawId: "firm", datasetVersion: "hartwell-2026-10" } }];
  bundle.bankTransactions = [];
  bundle.openingBalances = Object.entries(balances).map(([clientId, balance]) => ({
    sourceId: `hartwell:opening:${clientId}`, accountId: bundle.account.accountId,
    ownerId: `hartwell:owner:${clientId}`, amountCents: balance, clearedCents: balance,
    asOf: cutoff, bankSourceId: null,
    raw: { system: "demo", recordType: "client-ledger", rawId: clientId, datasetVersion: "hartwell-2026-10" },
  }));
  bundle.statementBalances = [{ sourceId: `hartwell:bank:before:${payment.id}`, accountId: bundle.account.accountId,
    amountCents: poolCents, asOf: cutoff,
    raw: { system: "demo", recordType: "bank-balance", rawId: payment.id, datasetVersion: "hartwell-2026-10" } }];
  const state: AccountLedgerState = { account: bundle.account, owners: bundle.owners, bankTransactions: [],
    statementBalances: bundle.statementBalances, reconcilingItems: [],
    entries: importLedgerEntries(bundle, cutoff, "hartwell-replay"), holds: [] };
  const context: GatewayContext = { state, threeWay: threeWayCheck(state, cutoff),
    knownSourceIds: new Set([`hartwell:invoice:cho-expert-invoice`, ...bundle.owners.map(owner => owner.sourceId)]),
    proposals: [], cutoff };
  if (context.threeWay.status !== "matched") throw new Error(`Hayes replay does not reconcile at the payment cutoff: ${context.threeWay.status} ${context.threeWay.causes.map(cause => cause.code).join(", ")}`);
  const result = evaluatePayment(context, { proposalId: "hartwell:request:cho-expert-payment", ownerId: `hartwell:owner:${payment.clientId}`,
    amountCents, currency: "USD", evidenceSourceIds: ["hartwell:invoice:cho-expert-invoice"],
    requestedBy: "hartwell:riley", payoutKind: "costs" }, { stage: "request", actor: "hartwell:riley" });
  const shortageCents = Math.max(0, amountCents - ownerCents);
  if (!result.failures.some(failure => failure.rule === "L1") || result.allowed || shortageCents !== 63_000_000)
    throw new Error("Hayes ownership lock did not block the expected $630,000 shortfall");
  return { payment, poolCents, ownerCents, amountCents, shortageCents, result, threeWay: context.threeWay };
}
