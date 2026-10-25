import { FinanceProviderError, type FinanceAgentProvider } from "./types";
import { mockFinanceAgentProvider } from "./mock";
import { CreaoFinanceAgentProvider } from "./creao";

export function createFinanceAgentProvider(config: { mode: string | undefined; appId?: string; apiKey?: string; timeoutMs?: number }, fetchImpl?: typeof fetch): FinanceAgentProvider {
  if (config.mode === "mock") return mockFinanceAgentProvider;
  if (config.mode === "creao") return new CreaoFinanceAgentProvider(config.appId ?? "", config.apiKey ?? "", fetchImpl, config.timeoutMs);
  throw new FinanceProviderError("configuration_error", "Set FINANCE_AGENT_MODE explicitly to mock or creao in the Convex deployment environment.");
}
export { FinanceProviderError } from "./types";
export type { FinanceAgentProvider, ProviderExecution } from "./types";
export { validateFinanceAgentOutput, FinanceOutputValidationError } from "./validation";
export { CreaoAppClient } from "./creaoClient";
export { extractCreaoReport, INVESTIGATION_REPORT_FIELDS } from "./creaoResult";
export { mockFinanceAgentProvider, mockInvestigation } from "./mock";
