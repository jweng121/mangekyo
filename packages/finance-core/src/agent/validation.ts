import { FINANCE_OUTPUT_VERSION, type FinanceAgentInput, type FinanceAgentOutput } from "@mangekyo/contracts";
import { runDeterministicChecks } from "../checks";
import { FinanceProviderError } from "./types";

export class FinanceOutputValidationError extends FinanceProviderError {
  constructor(public readonly details: Array<{ path: string; reason: string }>) {
    super("validation_failed", `${details[0]?.path ?? "$"}: ${details[0]?.reason ?? "Provider output failed validation."}`);
  }
}
function invalid(message: string, path = "$"): never { throw new FinanceOutputValidationError([{ path, reason: message }]); }
function object(value: unknown, keys: string[], path = "$"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected a JSON object.", path);
  const result = value as Record<string, unknown>;
  const details = keys.filter(key => !(key in result)).map(key => ({ path: path + "." + key, reason: "Required field is missing." }));
  // Unknown key names may themselves contain secrets; report their position, never their text.
  Object.keys(result).forEach((key, index) => { if (!keys.includes(key)) details.push({ path: path + "[property#" + index + "]", reason: "Unsupported field; only contract fields are allowed." }); });
  if (details.length) throw new FinanceOutputValidationError(details.slice(0, 50));
  return result;
}
function text(value: unknown, max = 4000, path = "$"): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid("Expected a nonempty string of at most " + max + " characters.", path);
}
function array(value: unknown, path = "$"): unknown[] {
  if (!Array.isArray(value) || value.length > 50) invalid("Expected an array with at most 50 items.", path);
  return value;
}

/** Strict decoding plus referential and financial validation; never trusts a model's arithmetic. */
export function validateFinanceAgentOutput(value: unknown, input: FinanceAgentInput): FinanceAgentOutput {
  const root = object(value, ["schemaVersion", "outcome", "summary", "findings", "questions", "proposedAllocations", "proposedActions", "candidatePolicies"]);
  if (root.schemaVersion !== FINANCE_OUTPUT_VERSION) invalid("Expected finance-investigation-output/v1.", "$.schemaVersion");
  if (!["findings", "needs_information", "proposal_ready"].includes(String(root.outcome))) invalid("Unsupported outcome.", "$.outcome");
  text(root.summary, 4000, "$.summary");
  const sources = new Set([
    ...input.records.transactions.map(row => row.sourceId), ...input.records.documents.map(row => row.sourceId),
    ...input.records.invoices.map(row => row.sourceId), ...input.records.agreements.map(row => row.sourceId),
    ...input.humanClarifications.map(row => row.sourceId), ...input.approvedPolicies.map(row => row.sourceId),
    ...input.records.timingDifferences.map(row => row.sourceId),
    ...[input.records.bankBalance, input.records.controlBalance, ...(input.records.ownerBalances ?? [])].flatMap(row => row ? [row.sourceId] : []),
  ]);
  const sourceRefs = (value: unknown, path: string, required = true) => {
    const refs = array(value, path);
    if (required && refs.length === 0) invalid("A supported finding or proposal requires a supplied source reference.", path);
    for (const [index, ref] of refs.entries()) { const refPath = `${path}[${index}]`; text(ref, 300, refPath); if (!sources.has(ref)) invalid("Citation does not exist in the frozen provider context.", refPath); }
  };
  const checkUnique = (rows: unknown[], field: string, path: string) => {
    const seen = new Set<unknown>();
    for (const [index, row] of rows.entries()) {
      const id = (row as Record<string, unknown>)[field]; text(id, 200, `${path}[${index}].${field}`);
      if (seen.has(id)) invalid("Provider result contains duplicate identifiers.", `${path}[${index}].${field}`); seen.add(id);
    }
  };
  const findings = array(root.findings, "$.findings");
  for (const [index, row] of findings.entries()) {
    const path = `$.findings[${index}]`;
    const item = object(row, ["findingId", "summary", "sourceRefs"], path);
    text(item.findingId, 200, `${path}.findingId`); text(item.summary, 4000, `${path}.summary`); sourceRefs(item.sourceRefs, `${path}.sourceRefs`);
  }
  checkUnique(findings, "findingId", "$.findings");
  const questions = array(root.questions, "$.questions");
  for (const [index, row] of questions.entries()) {
    const path = `$.questions[${index}]`;
    const item = object(row, ["key", "question", "sourceRefs"], path);
    text(item.key, 100, `${path}.key`); if (!/^[a-zA-Z0-9_-]+$/.test(item.key)) invalid("Question keys must use letters, digits, underscores, or hyphens.", `${path}.key`);
    text(item.question, 4000, `${path}.question`); sourceRefs(item.sourceRefs, `${path}.sourceRefs`, false);
  }
  checkUnique(questions, "key", "$.questions");
  const allocations = array(root.proposedAllocations, "$.proposedAllocations");
  for (const [index, row] of allocations.entries()) {
    const path = `$.proposedAllocations[${index}]`;
    const item = object(row, ["proposalId", "transactionId", "ownerId", "amountCents", "currency", "evidenceSourceIds"], path);
    for (const key of ["proposalId", "transactionId", "ownerId", "currency"]) text(item[key], 300, `${path}.${key}`);
    if (typeof item.amountCents !== "number" || !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0) invalid("Allocation amount must be positive integer cents.", `${path}.amountCents`);
    sourceRefs(item.evidenceSourceIds, `${path}.evidenceSourceIds`);
  }
  const actions = array(root.proposedActions, "$.proposedActions");
  for (const [index, row] of actions.entries()) {
    const path = `$.proposedActions[${index}]`;
    const item = object(row, ["kind", "description", "sourceRefs"], path);
    if (item.kind !== "request_evidence") invalid("Only evidence-request actions are supported; financial execution is disabled.", `${path}.kind`);
    text(item.description, 4000, `${path}.description`); sourceRefs(item.sourceRefs, `${path}.sourceRefs`, false);
  }
  const policies = array(root.candidatePolicies, "$.candidatePolicies");
  for (const [index, row] of policies.entries()) {
    const path = `$.candidatePolicies[${index}]`;
    const item = object(row, ["policyId", "statement", "sourceRefs", "status"], path);
    text(item.policyId, 200, `${path}.policyId`); text(item.statement, 4000, `${path}.statement`); sourceRefs(item.sourceRefs, `${path}.sourceRefs`, false);
    if (item.status !== "proposed") invalid("Candidate policies cannot be approved by a provider.", `${path}.status`);
  }
  checkUnique(policies, "policyId", "$.candidatePolicies");
  if (root.outcome === "needs_information" && questions.length === 0) invalid("A needs_information result requires a specific question.", "$.questions");
  if (root.outcome !== "needs_information" && questions.length > 0) invalid("Open questions require a needs_information outcome.", "$.outcome");
  if (allocations.length > 0 && root.outcome !== "proposal_ready") invalid("Proposed allocations require an explicit proposal_ready outcome for human review.", "$.outcome");
  if (root.outcome === "proposal_ready" && allocations.length === 0 && actions.length === 0 && policies.length === 0) invalid("proposal_ready requires an explicit proposal for human review.", "$.outcome");
  const output = value as FinanceAgentOutput;
  const checks = runDeterministicChecks(input.records, input.scope, output.proposedAllocations);
  if (checks.amounts.status === "failed" || checks.proposedAllocations.status === "failed" || (allocations.length > 0 && checks.proposedAllocations.status !== "passed")) invalid("Proposed allocations fail deterministic financial checks or require missing allocation history.", "$.proposedAllocations");
  return output;
}
