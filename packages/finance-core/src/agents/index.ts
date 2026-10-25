import type { AgentMode, AgentModelPlan, AgentName, AgentRunProvenance } from "@mangekyo/contracts/orchestration";
import { AGENT_ALIASES } from "@mangekyo/contracts/orchestration";
import { FinanceProviderError, type ProviderExecution } from "../agent/types";
import { CreaoAppClient, isObject } from "../agent/creaoClient";
import { extractCreaoReport } from "../agent/creaoResult";
import { INSTRUCTIONS } from "./instructions";

export { INSTRUCTIONS, INSTRUCTION_VERSIONS } from "./instructions";
export type { AgentMode, AgentName, AgentModelPlan, AgentRunProvenance };

/**
 * The five trust agents. Each has its own mode (<AGENT>_MODE), its own CREAO app (CREAO_<AGENT>_APP_ID / _API_KEY)
 * and its own external model (<AGENT>_EXTERNAL_API_KEY, optional <AGENT>_EXTERNAL_MODEL / _URL). Old names stay as aliases.
 */
export const AGENTS: Record<AgentName, AgentModelPlan & { aliases: string[]; family: "anthropic" | "google" | "openai"; defaultModelId: string }> = {
  intake: { agent: "intake", label: "Trust Intake", plannedModel: "Claude Opus", defaultModelId: "claude-opus-5-5", family: "anthropic", envPrefix: "INTAKE", aliases: ["investigator", "Agent 1"] },
  disbursement: { agent: "disbursement", label: "Disbursement", plannedModel: "Claude Opus", defaultModelId: "claude-opus-5-5", family: "anthropic", envPrefix: "DISBURSEMENT", aliases: [] },
  evidence_checker: { agent: "evidence_checker", label: "Evidence Checker", plannedModel: "Gemini Pro", defaultModelId: "gemini-2.5-pro", family: "google", envPrefix: "EVIDENCE_CHECKER", aliases: ["checker", "claim checker", "Agent 2"] },
  reconciler: { agent: "reconciler", label: "Three-Way Reconciler", plannedModel: "Claude Opus", defaultModelId: "claude-opus-5-5", family: "anthropic", envPrefix: "RECONCILER", aliases: ["mismatch agent"] },
  auditor: { agent: "auditor", label: "Trust Compliance Auditor", plannedModel: "GPT", defaultModelId: "gpt-5", family: "openai", envPrefix: "AUDITOR", aliases: [] },
};
export const AGENT_NAMES = Object.keys(AGENTS) as AgentName[];

/** Resolves an agent name or any of its old names. */
export function agentNamed(name: string): AgentName | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, "-");
  return AGENT_ALIASES[key] ?? (AGENT_NAMES.includes(key as AgentName) ? (key as AgentName) : null);
}

/** Every environment variable an agent reads, so the Convex app can declare them and the docs can list them. */
export function agentEnvNames(agent: AgentName): { mode: string[]; creaoAppId: string[]; creaoApiKey: string[]; externalApiKey: string; externalModel: string; externalUrl: string } {
  const p = AGENTS[agent].envPrefix;
  return {
    mode: agent === "intake" ? [`${p}_MODE`, "FINANCE_AGENT_MODE"] : agent === "evidence_checker" ? [`${p}_MODE`, "CHECKER_MODE"] : [`${p}_MODE`],
    creaoAppId: agent === "intake" ? [`CREAO_${p}_APP_ID`, "CREAO_APP_ID"] : agent === "evidence_checker" ? [`CREAO_${p}_APP_ID`, "CREAO_CHECKER_APP_ID"] : [`CREAO_${p}_APP_ID`],
    creaoApiKey: agent === "intake" ? [`CREAO_${p}_API_KEY`, "CREAO_API_KEY"] : agent === "evidence_checker" ? [`CREAO_${p}_API_KEY`, "CREAO_CHECKER_API_KEY", "CREAO_API_KEY"] : [`CREAO_${p}_API_KEY`],
    externalApiKey: `${p}_EXTERNAL_API_KEY`, externalModel: `${p}_EXTERNAL_MODEL`, externalUrl: `${p}_EXTERNAL_URL`,
  };
}

export type EnvReader = (name: string) => string | undefined;
const first = (read: EnvReader, names: string[]) => { for (const n of names) { const v = read(n)?.trim(); if (v) return v; } return undefined; };

/** mock (default when unset), creao or external. Anything else is a configuration error with no silent fallback. */
export function parseAgentMode(raw: string | undefined): AgentMode | null {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "") return "mock";
  return value === "mock" || value === "creao" || value === "external" ? value : null;
}

export interface AgentConfig {
  agent: AgentName;
  mode: AgentMode | null;
  configured: boolean;
  /** What is recorded as `model` on every run: "mock", "creao:<appId>" or the external model ID. Never a key. */
  model: string;
  appId: string | null;
  apiKey: string | null;
  externalUrl: string | null;
  message: string;
  /** Real (paid) runs this agent costs per attempt in this mode: 0 for mock, 1 otherwise. */
  realRuns: 0 | 1;
}

/** Reads one agent's configuration from the environment. Keys are returned for the adapter only and must never be persisted. */
export function agentConfig(agent: AgentName, read: EnvReader): AgentConfig {
  const names = agentEnvNames(agent);
  const def = AGENTS[agent];
  const mode = parseAgentMode(first(read, names.mode));
  const base = { agent, appId: null as string | null, apiKey: null as string | null, externalUrl: null as string | null };
  if (mode === null) return { ...base, mode, configured: false, model: "unconfigured", realRuns: 0, message: `${names.mode[0]} must be mock, creao or external (unset means mock). ${def.label} will not start until it is fixed.` };
  if (mode === "mock") return { ...base, mode, configured: true, model: "mock", realRuns: 0, message: `${def.label} simulated: deterministic mock behind the provider interface. No external model runs.` };
  if (mode === "creao") {
    const appId = first(read, names.creaoAppId) ?? null;
    const apiKey = first(read, names.creaoApiKey) ?? null;
    const configured = !!appId && /^capi_\S+$/.test(apiKey ?? "");
    return { ...base, mode, appId, apiKey, configured, model: `creao:${appId ?? "unset"}`, realRuns: 1,
      message: configured ? `${def.label} on CREAO app ${appId}. Each attempt is one real run.` : `${names.mode[0]}=creao needs ${names.creaoAppId[0]} and an app-scoped key in ${names.creaoApiKey[0]} (capi_). Runs fail and need a person until then.` };
  }
  const apiKey = read(names.externalApiKey)?.trim() || null;
  const model = read(names.externalModel)?.trim() || def.defaultModelId;
  const externalUrl = read(names.externalUrl)?.trim() || null;
  return { ...base, mode, apiKey, externalUrl, configured: !!apiKey, model, realRuns: 1,
    message: apiKey ? `${def.label} on external model ${model} (${def.plannedModel}). Each attempt is one real run.` : `${names.mode[0]}=external needs ${names.externalApiKey}. Runs fail and need a person until then.` };
}

export function provenance(agent: AgentName, config: Pick<AgentConfig, "mode" | "model">, instructionVersion: string): AgentRunProvenance {
  return { agent, mode: config.mode ?? "mock", model: config.model, instructionVersion };
}

/* ---------- External model adapter: one HTTP call per run, same provider interface as CREAO ---------- */

const ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  openai: "https://api.openai.com/v1/chat/completions",
} as const;

export interface ExternalProviderOptions { agent: AgentName; apiKey: string; model: string; url?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number; instructions?: string }

/** Takes the model's text and returns its one JSON object. Fences, prose and several objects are refused; nothing is repaired. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) throw new FinanceProviderError("validation_failed", "The model must return exactly one raw JSON object: no Markdown fences, no prose before or after.");
  try { return JSON.parse(trimmed); } catch { throw new FinanceProviderError("validation_failed", "The model's answer was not valid JSON."); }
}

/**
 * Calls Claude, Gemini or GPT directly with the agent's instructions as the system prompt and finance_context as the one user message.
 * The call is synchronous, so start() returns a completed execution; poll() is never needed. Keys come from env and are never persisted.
 */
export class ExternalModelProvider<I> {
  readonly mode = "external" as const;
  private readonly family: "anthropic" | "google" | "openai";
  constructor(private readonly options: ExternalProviderOptions) {
    if (!options.apiKey.trim()) throw new FinanceProviderError("configuration_error", `${agentEnvNames(options.agent).externalApiKey} is not set.`);
    this.family = AGENTS[options.agent].family;
  }
  private request(body: unknown): { url: string; headers: Record<string, string> } {
    const { apiKey, model, url } = this.options;
    void body;
    if (this.family === "anthropic") return { url: url ?? ENDPOINTS.anthropic, headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" } };
    if (this.family === "google") return { url: url ?? `${ENDPOINTS.google}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, headers: { "content-type": "application/json" } };
    return { url: url ?? ENDPOINTS.openai, headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" } };
  }
  private body(context: string): unknown {
    const system = this.options.instructions ?? INSTRUCTIONS[this.options.agent];
    const { model } = this.options;
    if (this.family === "anthropic") return { model, max_tokens: 8000, system, messages: [{ role: "user", content: context }] };
    if (this.family === "google") return { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: context }] }], generationConfig: { responseMimeType: "application/json" } };
    return { model, messages: [{ role: "system", content: system }, { role: "user", content: context }], response_format: { type: "json_object" } };
  }
  /** The model's reply text, from the family's response shape. */
  static replyText(family: "anthropic" | "google" | "openai", value: unknown): string {
    if (!isObject(value)) throw new FinanceProviderError("provider_malformed_response", "The model returned an unsupported response object.");
    if (family === "anthropic") {
      const content = Array.isArray(value.content) ? value.content.find(c => isObject(c) && c.type === "text") : null;
      if (isObject(content) && typeof content.text === "string") return content.text;
    } else if (family === "google") {
      const candidate = Array.isArray(value.candidates) ? value.candidates[0] : null;
      const parts = isObject(candidate) && isObject(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
      const text = parts.map(p => isObject(p) && typeof p.text === "string" ? p.text : "").join("");
      if (text) return text;
    } else {
      const choice = Array.isArray(value.choices) ? value.choices[0] : null;
      if (isObject(choice) && isObject(choice.message) && typeof choice.message.content === "string") return choice.message.content;
    }
    throw new FinanceProviderError("provider_malformed_response", "The model's response had no text to read.");
  }
  async start(input: I): Promise<ProviderExecution> {
    const context = JSON.stringify(input);
    const { url, headers } = this.request(null);
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(this.body(context)), redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000) });
    } catch {
      throw new FinanceProviderError("provider_start_ambiguous", "The external model call timed out or lost its response. A paid call may have happened; no automatic new call was made.");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new FinanceProviderError("provider_authentication_error", "The external model provider rejected the API key.");
      throw new FinanceProviderError(`provider_http_${response.status}`, `The external model provider returned HTTP ${response.status}. No simulated result was substituted.`, response.status === 429 || response.status === 503);
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw new FinanceProviderError("provider_malformed_response", "The external model provider returned invalid JSON."); }
    const text = ExternalModelProvider.replyText(this.family, value);
    if (text.length > 100_000) throw new FinanceProviderError("provider_malformed_response", "The model's answer exceeds the supported output size.");
    const id = isObject(value) && typeof value.id === "string" ? value.id : `external:${this.options.model}:${Date.now()}`;
    return { status: "completed", externalRunId: id, output: parseModelJson(text), reportSource: { field: "result.text", format: "json" } };
  }
  async poll(): Promise<ProviderExecution> { throw new FinanceProviderError("mock_poll_unsupported", "External model calls complete in one request; there is nothing to poll."); }
}

/** A CREAO app behind the same interface, with the agent's own app ID and key, and the report fields its output must carry. */
export class CreaoAgentProvider<I> {
  readonly mode = "creao" as const;
  private readonly client: CreaoAppClient;
  constructor(agent: AgentName, appId: string, apiKey: string, private readonly reportFields: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs = 20_000) {
    const names = agentEnvNames(agent);
    this.client = new CreaoAppClient(appId, apiKey, fetchImpl, timeoutMs, `${names.creaoAppId[0]} and an app-scoped ${names.creaoApiKey[0]}`);
  }
  async start(input: I): Promise<ProviderExecution> { return await this.client.start("finance_context", JSON.stringify(input)); }
  async poll(externalRunId: string): Promise<ProviderExecution> {
    const status = await this.client.status(externalRunId);
    if (status.status !== "completed") return status;
    return { status: "completed", externalRunId, ...extractCreaoReport(status.result, this.reportFields) };
  }
}

export interface AgentProvider<I> { mode: AgentMode; start(input: I): Promise<ProviderExecution>; poll(externalRunId: string): Promise<ProviderExecution> }

/** The provider for an agent in its configured mode. The mock is supplied by the agent's own module. */
export function createAgentProvider<I>(config: AgentConfig, mock: AgentProvider<I>, reportFields: readonly string[], options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): AgentProvider<I> {
  if (config.mode === "mock") return mock;
  if (config.mode === "creao") return new CreaoAgentProvider<I>(config.agent, config.appId ?? "", config.apiKey ?? "", reportFields, options.fetchImpl, options.timeoutMs);
  if (config.mode === "external") return new ExternalModelProvider<I>({ agent: config.agent, apiKey: config.apiKey ?? "", model: config.model, url: config.externalUrl, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
  throw new FinanceProviderError("configuration_error", config.message);
}
