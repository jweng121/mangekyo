import { FinanceProviderError, type ProviderExecution } from "./types";

const CREAO_BASE = "https://agent.creao.ai/api/v1/apps";
export type JsonObject = Record<string, unknown>;
export const isObject = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);

/** App-scoped API Trigger client shared by every CREAO agent: one POST starts a run, GETs read its status. */
export class CreaoAppClient {
  constructor(private readonly appId: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 20000, label = "CREAO_APP_ID and an app-scoped CREAO_API_KEY") {
    if (!appId.trim() || !/^capi_\S+$/.test(apiKey)) throw new FinanceProviderError("configuration_error", `CREAO mode requires ${label} (capi_). Configure them in the Convex deployment environment.`);
  }
  async request(path: string, body?: unknown): Promise<JsonObject> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${CREAO_BASE}/${encodeURIComponent(this.appId)}/runs${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new FinanceProviderError(body === undefined ? "provider_network_error" : "provider_start_ambiguous", body === undefined ? "CREAO status could not be reached. The existing external run can be polled again." : "CREAO start timed out or lost its response. A paid run may exist; inspect CREAO before deliberately rerunning. No automatic new run was started.", body === undefined);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new FinanceProviderError("provider_authentication_error", "CREAO rejected the app-scoped credentials. Check the deployment's CREAO app ID and API key.");
      // 429 and 503 refuse a start before any run exists, so one retry is safe. Other 5xx starts may have created a paid run.
      const retryable = body === undefined ? response.status === 429 || response.status >= 500 : response.status === 429 || response.status === 503;
      throw new FinanceProviderError(`provider_http_${response.status}`, `CREAO returned HTTP ${response.status}. No simulated result was substituted.`, retryable);
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw new FinanceProviderError(body === undefined ? "provider_malformed_response" : "provider_start_ambiguous", body === undefined ? "CREAO returned invalid JSON." : "CREAO's start response was not usable JSON. A paid run may exist; inspect CREAO before rerunning."); }
    if (!isObject(value)) throw new FinanceProviderError(body === undefined ? "provider_malformed_response" : "provider_start_ambiguous", body === undefined ? "CREAO returned an unsupported response object." : "CREAO's start response had no usable run object. A paid run may exist; inspect CREAO before rerunning.");
    return value;
  }
  /** Starts a run with one string input; persists nothing itself. */
  async start(inputName: string, value: string): Promise<{ status: "pending"; externalRunId: string }> {
    const result = await this.request("", { inputs: { [inputName]: value } });
    if (typeof result.id !== "string" || !result.id.trim() || (result.appId !== undefined && result.appId !== this.appId)) throw new FinanceProviderError("provider_start_ambiguous", "CREAO accepted a request without a usable matching run ID. Inspect CREAO before rerunning.");
    // Persist the external ID before parsing any terminal payload or making another request.
    return { status: "pending", externalRunId: result.id };
  }
  /** Reads a run's status; a completed run hands back its raw result object for the caller's extractor. */
  async status(externalRunId: string): Promise<Exclude<ProviderExecution, { status: "completed" }> | { status: "completed"; externalRunId: string; result: JsonObject }> {
    const result = await this.request(`/${encodeURIComponent(externalRunId)}`);
    if (result.id !== undefined && result.id !== externalRunId) throw new FinanceProviderError("provider_malformed_response", "CREAO returned a different run ID.");
    if (result.status === "pending" || result.status === "running") return { status: "pending", externalRunId };
    if (result.status === "failed" || result.status === "cancelled") return { status: "failed", externalRunId, error: { code: `provider_${result.status}`, message: `CREAO run ${result.status}. Inspect the provider run for details; no mock result was substituted.`, retryable: false } };
    if (result.status !== "completed" || !isObject(result.result)) throw new FinanceProviderError("provider_malformed_response", "CREAO's terminal response must include a result object.");
    return { status: "completed", externalRunId, result: result.result };
  }
}
