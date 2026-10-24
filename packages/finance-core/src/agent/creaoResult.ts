import type { FinanceReportSource } from "@mangekyo/contracts";
import { FinanceProviderError } from "./types";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const reportFields = ["schemaVersion", "findings", "questions", "proposedAllocations", "proposedActions", "candidatePolicies"];
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

/** Extract transport envelopes only. All report content still requires strict validation. */
export function extractCreaoReport(result: Record<string, unknown>): { output: unknown; reportSource: FinanceReportSource } {
  // Do not silently prefer inline content over a potentially different JSON attachment.
  if (result.artifacts !== undefined && !Array.isArray(result.artifacts)) throw new FinanceProviderError("provider_malformed_response", "CREAO result.artifacts must be an array when present.");
  if (Array.isArray(result.artifacts) && result.artifacts.some(item => object(item) &&
    ((typeof item.type === "string" && /json/i.test(item.type)) || (typeof item.id === "string" && /\.json$/i.test(item.id))))) {
    throw new FinanceProviderError("provider_report_delivery_unsupported", "CREAO supplied a JSON artifact. Inline-only report delivery cannot rule out conflicting attachment content; return the complete report in result.text or result.chatText without a JSON attachment.");
  }
  const parsed: Array<{ output: unknown; reportSource: FinanceReportSource }> = [];
  for (const field of ["text", "chatText"] as const) {
    const value = result[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || value.length > 100000) throw new FinanceProviderError("provider_malformed_response", `CREAO result.${field} must be a string within the supported output size.`);
    let output: unknown;
    let format: FinanceReportSource["format"] = "json";
    try { output = JSON.parse(value); }
    catch {
      // CREAO concatenates conversational preamble and the final JSON in chatText.
      // Accept exactly one trailing JSON object, never a fence, array, or multiple objects.
      const start = value.indexOf("{");
      if (field !== "chatText" || start < 0 || /[\[\]`]/.test(value.slice(0, start))) continue;
      try { output = JSON.parse(value.slice(start)); format = "json_suffix"; }
      catch { throw new FinanceProviderError("validation_failed", "CREAO result.chatText must end in exactly one JSON report object; malformed or multiple reports are not accepted."); }
    }
    parsed.push({ output, reportSource: { field: `result.${field}`, format } });
  }
  const reports = parsed.filter(({ output }) => object(output) && reportFields.some(key => key in output));
  if (reports.length > 1 && reports.some(item => canonical(item.output) !== canonical(reports[0].output))) {
    throw new FinanceProviderError("provider_conflicting_reports", "CREAO result.text and result.chatText contain different report objects. No report was selected.");
  }
  // Identical reports use the documented primary field (text) for stable provenance.
  // An incomplete object is returned for precise schema diagnostics, never repaired.
  const selected = reports[0] ?? parsed[0];
  if (!selected) throw new FinanceProviderError("validation_failed", "CREAO result.text or result.chatText must contain a JSON report object without Markdown fences or trailing prose.");
  return selected;
}
