// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { FinanceAgentInput } from "@mangekyo/contracts";
import { CreaoFinanceAgentProvider } from "../src/agent/creao";
import { extractCreaoReport } from "../src/agent/creaoResult";
import { validateFinanceAgentOutput } from "../src/agent/validation";

const response = JSON.parse(readFileSync(new URL("./fixtures/creao-attempt5.json", import.meta.url), "utf8"));
const input: FinanceAgentInput = JSON.parse(readFileSync(new URL("./fixtures/creao-attempt5-input.json", import.meta.url), "utf8"));

it("retrieves the actual attempt 5 chatText report using only GET and the same strict validators", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
  const provider = new CreaoFinanceAgentProvider("test-app", "capi_test", fetcher);
  const result = await provider.poll("existing-run");
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw Error("Expected completed");
  expect(result.reportSource).toEqual({ field: "result.chatText", format: "json_suffix" });
  const report = validateFinanceAgentOutput(result.output, input);
  expect(report.outcome).toBe("needs_information");
  expect(report.findings).toHaveLength(5);
  expect(report.questions).toHaveLength(5);
  expect(report.proposedAllocations).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error" });
  const altered = structuredClone(report);
  altered.findings[0].sourceRefs = ["unsupported"];
  expect(() => validateFinanceAgentOutput(altered, input)).toThrow("Citation does not exist");
});

it("rejects conflicting reports instead of preferring a valid-looking alternative", () => {
  const report = extractCreaoReport(response.result).output as Record<string, unknown>;
  expect(() => extractCreaoReport({ text: JSON.stringify({ ...report, summary: "Different" }), chatText: JSON.stringify(report) })).toThrow("different report objects");
  expect(extractCreaoReport({ text: JSON.stringify(report), chatText: JSON.stringify(report) }).reportSource.field).toBe("result.text");
});

it("does not repair truncated JSON or select between multiple chat reports", () => {
  for (const chatText of ['Preface {"schemaVersion":', 'Preface {} {}', '```json\n{}\n```']) {
    expect(() => extractCreaoReport({ chatText })).toThrow();
  }
});

it("does not fetch an arbitrary artifact URL or silently ignore a JSON attachment", () => {
  expect(() => extractCreaoReport({ ...response.result, artifacts: [{ id: "report.json", type: "application/json", url: "https://untrusted.invalid" }] })).toThrow("JSON artifact");
});
