import type { FinanceAgentInput } from "@mangekyo/contracts";
import type { FinanceAgentProvider, ProviderExecution } from "./types";
import { extractCreaoReport } from "./creaoResult";
import { CreaoAppClient } from "./creaoClient";

export class CreaoFinanceAgentProvider implements FinanceAgentProvider {
  readonly mode = "creao" as const;
  private readonly client: CreaoAppClient;
  constructor(appId: string, apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 20000) {
    this.client = new CreaoAppClient(appId, apiKey, fetchImpl, timeoutMs);
  }
  async start(input: FinanceAgentInput): Promise<ProviderExecution> {
    return await this.client.start("finance_context", JSON.stringify(input));
  }
  async poll(externalRunId: string): Promise<ProviderExecution> {
    const status = await this.client.status(externalRunId);
    if (status.status !== "completed") return status;
    return { status: "completed", externalRunId, ...extractCreaoReport(status.result) };
  }
}
