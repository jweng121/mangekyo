import type { FinanceAgentInput, FinanceAgentMode, FinanceReportSource, InvestigationError } from "@mangekyo/contracts";

export type ProviderExecution =
  | { status: "pending"; externalRunId: string }
  | { status: "completed"; externalRunId: string; output: unknown; reportSource?: FinanceReportSource }
  | { status: "failed"; externalRunId: string; error: InvestigationError };

export interface FinanceAgentProvider {
  mode: FinanceAgentMode;
  start(input: FinanceAgentInput): Promise<ProviderExecution>;
  poll(externalRunId: string): Promise<ProviderExecution>;
}

export class FinanceProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message); this.name = "FinanceProviderError";
  }
}
