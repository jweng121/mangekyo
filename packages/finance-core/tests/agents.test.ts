import { describe, expect, it } from "vitest";
import { agentConfig, agentEnvNames, agentNamed, AGENT_NAMES, AGENTS, createAgentProvider, ExternalModelProvider, INSTRUCTIONS, INSTRUCTION_VERSIONS, parseAgentMode, parseModelJson } from "../src/agents";

const env = (values: Record<string, string>) => (name: string) => values[name];

describe("five agents, one mode each", () => {
  it("knows the five agents, their planned models and their old names", () => {
    expect(AGENT_NAMES).toEqual(["intake", "disbursement", "evidence_checker", "reconciler", "auditor"]);
    expect(AGENTS.intake.plannedModel).toBe("Claude Opus"); expect(AGENTS.evidence_checker.plannedModel).toBe("Gemini Pro"); expect(AGENTS.auditor.plannedModel).toBe("GPT");
    expect(agentNamed("investigator")).toBe("intake"); expect(agentNamed("checker")).toBe("evidence_checker"); expect(agentNamed("mismatch agent")).toBe("reconciler"); expect(agentNamed("Trust Compliance Auditor")).toBe("auditor"); expect(agentNamed("nobody")).toBeNull();
    for (const agent of AGENT_NAMES) { expect(INSTRUCTIONS[agent]).toContain("finance_context"); expect(INSTRUCTIONS[agent]).toContain("raw JSON"); expect(INSTRUCTIONS[agent]).toContain("sourceId"); }
    // Everyone that asks is limited to 3 questions; the Evidence Checker only judges.
    for (const agent of ["intake", "disbursement", "reconciler", "auditor"] as const) expect(INSTRUCTIONS[agent]).toMatch(/at most 3|never more than 3/i);
    expect(INSTRUCTIONS.evidence_checker).toMatch(/You ask no\s+questions/);
    expect(INSTRUCTIONS.intake).toContain("records.allocationHistoryComplete tells you whether complete allocation history");
    expect(INSTRUCTIONS.intake).toContain("records.bankTransactions: the bank-feed view of the deposit");
    expect(INSTRUCTIONS.intake).not.toContain("The current sample lacks that history");
    expect(INSTRUCTION_VERSIONS.intake).toBe("finance-investigator/v1");
  });

  it("defaults every agent to mock; old env names stay as aliases and the new name wins", () => {
    expect(parseAgentMode(undefined)).toBe("mock"); expect(parseAgentMode(" CREAO ")).toBe("creao"); expect(parseAgentMode("external")).toBe("external"); expect(parseAgentMode("bogus")).toBeNull();
    expect(agentConfig("intake", env({}))).toMatchObject({ mode: "mock", model: "mock", realRuns: 0, configured: true });
    expect(agentConfig("intake", env({ FINANCE_AGENT_MODE: "creao", CREAO_APP_ID: "app-1", CREAO_API_KEY: "capi_x" }))).toMatchObject({ mode: "creao", appId: "app-1", model: "creao:app-1", realRuns: 1, configured: true });
    expect(agentConfig("intake", env({ INTAKE_MODE: "mock", FINANCE_AGENT_MODE: "creao" })).mode).toBe("mock");
    expect(agentConfig("evidence_checker", env({ CHECKER_MODE: "creao", CREAO_CHECKER_APP_ID: "chk", CREAO_API_KEY: "capi_shared" }))).toMatchObject({ mode: "creao", appId: "chk", apiKey: "capi_shared", configured: true });
    expect(agentConfig("evidence_checker", env({ EVIDENCE_CHECKER_MODE: "creao", CREAO_EVIDENCE_CHECKER_APP_ID: "chk2", CREAO_EVIDENCE_CHECKER_API_KEY: "cr_sk_wrong" })).configured).toBe(false);
    expect(agentConfig("disbursement", env({ DISBURSEMENT_MODE: "creao" }))).toMatchObject({ configured: false, message: expect.stringContaining("CREAO_DISBURSEMENT_APP_ID") });
    expect(agentConfig("auditor", env({ AUDITOR_MODE: "external" }))).toMatchObject({ mode: "external", configured: false, model: "gpt-5", message: expect.stringContaining("AUDITOR_EXTERNAL_API_KEY") });
    expect(agentConfig("reconciler", env({ RECONCILER_MODE: "external", RECONCILER_EXTERNAL_API_KEY: "k", RECONCILER_EXTERNAL_MODEL: "claude-opus-5-5-2026" }))).toMatchObject({ mode: "external", configured: true, model: "claude-opus-5-5-2026", realRuns: 1 });
    expect(agentConfig("intake", env({ INTAKE_MODE: "nope" }))).toMatchObject({ mode: null, configured: false });
    expect(agentEnvNames("intake").mode).toEqual(["INTAKE_MODE", "FINANCE_AGENT_MODE"]);
    expect(agentEnvNames("evidence_checker").creaoApiKey).toEqual(["CREAO_EVIDENCE_CHECKER_API_KEY", "CREAO_CHECKER_API_KEY", "CREAO_API_KEY"]);
  });
});

describe("external model adapter (fake fetch; nothing real is called)", () => {
  const answer = { schemaVersion: "finance-claim-check-output/v1", verdicts: [] };
  const fakeFetch = (status: number, body: unknown, capture: { url?: string; init?: RequestInit } = {}) => (async (url: string | URL | Request, init?: RequestInit) => { capture.url = String(url); capture.init = init; return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }) as typeof fetch;

  it("sends the agent's instructions as the system prompt and finance_context as the one user message, per model family", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const claude = new ExternalModelProvider<{ a: number }>({ agent: "intake", apiKey: "sk-ant-test", model: "claude-opus-5-5", fetchImpl: fakeFetch(200, { id: "msg_1", content: [{ type: "text", text: JSON.stringify(answer) }] }, seen) });
    const result = await claude.start({ a: 1 });
    expect(result).toMatchObject({ status: "completed", externalRunId: "msg_1", output: answer });
    expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    expect((seen.init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
    const body = JSON.parse(String(seen.init?.body));
    expect(body.system).toBe(INSTRUCTIONS.intake); expect(body.messages).toEqual([{ role: "user", content: JSON.stringify({ a: 1 }) }]);
    const gem: { url?: string; init?: RequestInit } = {};
    const gemini = new ExternalModelProvider({ agent: "evidence_checker", apiKey: "g-key", model: "gemini-2.5-pro", fetchImpl: fakeFetch(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }, gem) });
    expect((await gemini.start({})).status).toBe("completed");
    expect(gem.url).toContain("generativelanguage.googleapis.com"); expect(gem.url).toContain("gemini-2.5-pro");
    expect(JSON.parse(String(gem.init?.body)).systemInstruction.parts[0].text).toBe(INSTRUCTIONS.evidence_checker);
    const oa: { url?: string; init?: RequestInit } = {};
    const gpt = new ExternalModelProvider({ agent: "auditor", apiKey: "oa-key", model: "gpt-5", fetchImpl: fakeFetch(200, { id: "chatcmpl-1", choices: [{ message: { content: JSON.stringify(answer) } }] }, oa) });
    expect(await gpt.start({})).toMatchObject({ externalRunId: "chatcmpl-1" });
    expect((oa.init?.headers as Record<string, string>).Authorization).toBe("Bearer oa-key");
    expect(JSON.parse(String(oa.init?.body)).messages[0]).toEqual({ role: "system", content: INSTRUCTIONS.auditor });
  });

  it("refuses fenced or prose answers, maps HTTP errors like CREAO, and never exposes the key", async () => {
    expect(() => parseModelJson("```json\n{}\n```")).toThrow("exactly one raw JSON object");
    expect(() => parseModelJson("Here you go: {}")).toThrow("exactly one raw JSON object");
    expect(parseModelJson(" {\"a\":1} ")).toEqual({ a: 1 });
    const fenced = new ExternalModelProvider({ agent: "intake", apiKey: "k", model: "m", fetchImpl: fakeFetch(200, { content: [{ type: "text", text: "```json\n{}\n```" }] }) });
    await expect(fenced.start({})).rejects.toMatchObject({ code: "validation_failed" });
    await expect(new ExternalModelProvider({ agent: "intake", apiKey: "k", model: "m", fetchImpl: fakeFetch(401, {}) }).start({})).rejects.toMatchObject({ code: "provider_authentication_error" });
    await expect(new ExternalModelProvider({ agent: "intake", apiKey: "k", model: "m", fetchImpl: fakeFetch(429, {}) }).start({})).rejects.toMatchObject({ code: "provider_http_429", retryable: true });
    await expect(new ExternalModelProvider({ agent: "intake", apiKey: "k", model: "m", fetchImpl: (async () => { throw new Error("socket"); }) as typeof fetch }).start({})).rejects.toMatchObject({ code: "provider_start_ambiguous" });
    expect(() => new ExternalModelProvider({ agent: "intake", apiKey: "  ", model: "m" })).toThrow("INTAKE_EXTERNAL_API_KEY");
    await expect(new ExternalModelProvider({ agent: "intake", apiKey: "k", model: "m", fetchImpl: fakeFetch(200, {}) }).poll()).rejects.toMatchObject({ code: "mock_poll_unsupported" });
  });

  it("createAgentProvider picks mock, the agent's own CREAO app, or the external model from the config", async () => {
    const mock = { mode: "mock" as const, async start() { return { status: "completed" as const, externalRunId: "mock:1", output: {} }; }, async poll() { throw new Error("no"); } };
    expect(createAgentProvider(agentConfig("intake", env({})), mock, [])).toBe(mock);
    expect(createAgentProvider(agentConfig("disbursement", env({ DISBURSEMENT_MODE: "creao", CREAO_DISBURSEMENT_APP_ID: "d", CREAO_DISBURSEMENT_API_KEY: "capi_d" })), mock, []).mode).toBe("creao");
    expect(() => createAgentProvider(agentConfig("disbursement", env({ DISBURSEMENT_MODE: "creao", CREAO_DISBURSEMENT_APP_ID: "d", CREAO_DISBURSEMENT_API_KEY: "cr_sk_account" })), mock, [])).toThrow(expect.objectContaining({ code: "configuration_error" }));
    expect(createAgentProvider(agentConfig("auditor", env({ AUDITOR_MODE: "external", AUDITOR_EXTERNAL_API_KEY: "k" })), mock, []).mode).toBe("external");
    expect(() => createAgentProvider(agentConfig("auditor", env({ AUDITOR_MODE: "bogus" })), mock, [])).toThrow("AUDITOR_MODE must be mock, creao or external");
  });
});
