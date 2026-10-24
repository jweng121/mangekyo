import type { LedgerEntry, NormalizedAccountBundle } from "@mangekyo/contracts";
import { createSeed } from "../../../apps/demo-erp/data/seed";
import { normalizeErpState, type ErpState } from "../src/intake/erp";
import { importLedgerEntries, type AccountLedgerState } from "../src/ledger";
import { demoMoneyBundle } from "../fixtures/demoMoney";

export const NOW = Date.UTC(2026, 9, 24, 12);

export function stateFrom(bundle: NormalizedAccountBundle, extra: Partial<AccountLedgerState> = {}): AccountLedgerState {
  return {
    account: bundle.account, owners: bundle.owners, bankTransactions: bundle.bankTransactions,
    statementBalances: bundle.statementBalances, reconcilingItems: bundle.reconcilingItems,
    entries: importLedgerEntries(bundle, 0, "import:test"), holds: [], ...extra,
  };
}

export const erpState = () => stateFrom(normalizeErpState(createSeed(42) as ErpState));
export const demoState = (extra: Partial<AccountLedgerState> = {}) => stateFrom(demoMoneyBundle(), extra);

export function entry(fields: Partial<LedgerEntry> & Pick<LedgerEntry, "entryId" | "amountCents" | "kind">): LedgerEntry {
  return { accountId: "demo:account:pool-001", ownerId: null, currency: "USD", status: "posted", sourceRefs: [], memo: "test", effectiveAt: NOW - 1000, createdAt: NOW - 1000, createdBy: "test", ...fields };
}
