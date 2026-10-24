import { FinanceProviderError, type FinanceAgentProvider } from "./types";
import { mockFinanceAgentProvider } from "./mock";
import { CreaoFinanceAgentProvider } from "./creao";

export function createFinanceAgentProvider(config: { mode: string | undefined; appId?: string; apiKey?: string }, fetchImpl?: typeof fetch): FinanceAgentProvider {
  if (config.mode === "mock") return mockFinanceAgentProvider;
  if (config.mode === "creao") return new CreaoFinanceAgentProvider(config.appId ?? "", config.apiKey ?? "", fetchImpl);
  throw new FinanceProviderError("configuration_error", "Set FINANCE_AGENT_MODE explicitly to mock or creao in the Convex deployment environment.");
}
export { FinanceProviderError } from "./types";
export type { FinanceAgentProvider, ProviderExecution } from "./types";
export { validateFinanceAgentOutput, FinanceOutputValidationError } from "./validation";
