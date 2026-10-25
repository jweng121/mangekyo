import "server-only";
import {retryFetch} from "./retry-fetch";
import {chatAnswerSchema} from "./chat-answer-schema";
import { parseChatSections } from "./chat-sections";
import type { InvestigationRecord, Snapshot, SnapshotChatSection } from "../../../packages/contracts";
import { auditChatInstructions, chatEvidenceContext, chatEvidenceSnapshots } from "./chat-evidence-context";
import { loadScreenshot } from "./local-store";

export interface AuditAnswer { text: string; sections?: SnapshotChatSection[]; snapshotIds: string[]; provider: "local" | "openai" | "anthropic" }
export interface AuditProvider { answer(question: string, selected: Snapshot, record: InvestigationRecord): Promise<AuditAnswer> }

const related = (selected: Snapshot, record: InvestigationRecord) => record.snapshots.filter(snapshot => snapshot.runId === selected.runId);

class LocalAuditProvider implements AuditProvider {
  async answer(question: string, selected: Snapshot, record: InvestigationRecord): Promise<AuditAnswer> {
    const snapshots = related(selected, record);
    const bank = snapshots.find(item => item.sequence === 1);
    const invoice = snapshots.find(item => item.sequence === 2);
    const customer = snapshots.find(item => item.sequence === 3);
    const proposal = snapshots.find(item => item.sequence === 4);
    const corrected = record.runs.find(item => item.parentRunId === selected.runId);
    const q = question.toLowerCase();
    let refs = [selected];
    let text = `Recorded fact: ${selected.summary} Tool response: ${selected.toolResponse ?? "none recorded"}. Agent explanation: ${selected.recordedJustification ?? "none recorded"}.`;
    if (/read|saw|found|source|document|company|customer|bank|invoice/.test(q)) {
      refs = /customer|company|client b/i.test(q) ? [customer].filter((item): item is Snapshot => !!item) : /bank|payment reference/i.test(q) ? [bank].filter((item): item is Snapshot => !!item) : /invoice/i.test(q) ? [invoice].filter((item): item is Snapshot => !!item) : [bank, invoice, customer].filter((item): item is Snapshot => !!item);
      text = `Recorded reads: ${refs.map(item => `${item.title}: ${item.observation.fields.map(field => field.value).join(", ")}`).join("; ")}. Open the cited capture to see the recorded region.`;
    }
    if (/why|disagree|begin|mistake|propose/.test(q)) { refs = [bank, invoice, customer, proposal].filter((item): item is Snapshot => !!item); text = `Recorded facts: invoice payer ${invoice?.observation.fields[0]?.value}; customer payment code ${customer?.observation.fields[0]?.value}. Agent-provided justification: ${proposal?.recordedJustification ?? "none recorded"}. Mangekyo interpretation: the invoice-first proposal conflicts with the observed payment code.`; }
    if (/change|field|write/.test(q)) { refs = snapshots.filter(item => item.sequence === 4 || item.sequence === 5); text = `The agent selected a draft owner and clicked Prepare proposal. Actual ERP response: ${snapshots.find(item => item.sequence === 5)?.toolResponse ?? "missing"}. No ledger posting was observed.`; }
    if (/compare|corrected|branch/.test(q)) { const correctedProposal = record.snapshots.find(item => item.runId === corrected?.id && item.sequence === 4); refs = [proposal, correctedProposal].filter((item): item is Snapshot => !!item); text = corrected ? `Original proposed ${record.runs.find(item => item.id === selected.runId)?.proposedOwner}; fresh corrected Chromium run proposed ${corrected.proposedOwner}. Both are draft proposals.` : "No corrected execution is recorded yet."; }
    if (/escalation|escalated/.test(q)) {
      const escalation = snapshots.find(item => item.actionType === "ESCALATE" || /human.*review|escalation/i.test(item.title));
      refs = escalation ? [escalation, ...(/other|rest|all/.test(q) ? snapshots.filter(item => item.id !== escalation.id) : [])] : [selected];
    }
    const sections = refs.map(item => ({ snapshotId: item.id, text: item.summary, annotationIds: item.annotations?.slice(0, 1).map(note => note.id) ?? [] }));
    return { text: sections.map(part => part.text).join("\n\n"), sections, snapshotIds: refs.map(item => item.id), provider: "local" };
  }
}

class OpenAiAuditProvider implements AuditProvider {
  async answer(question: string, selected: Snapshot, record: InvestigationRecord): Promise<AuditAnswer> {
    const key = process.env.OPENAI_API_KEY;
    const model = process.env.MANGEKYO_LLM_MODEL;
    if (!key || !model) throw new Error("OpenAI audit provider requires OPENAI_API_KEY and MANGEKYO_LLM_MODEL");
    const snapshots = related(selected, record);
    const refs = chatEvidenceSnapshots(selected, record);
    const screenshotId = selected.screenshot?.url.split("/").at(-1);
    const content: ({ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "low" })[] = [{ type: "input_text", text: chatEvidenceContext(question, selected, record) }];
    if (screenshotId) content.push({ type: "input_image", image_url: `data:image/png;base64,${(await loadScreenshot(screenshotId)).toString("base64")}`, detail: "low" });
    const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, store: false, instructions: auditChatInstructions, input: [{ role: "user", content }] }), signal: AbortSignal.timeout(30000) });
    const body = await response.json() as { error?: { message?: string }; output?: { type: string; content?: { type: string; text?: string }[] }[] };
    if (!response.ok) throw new Error(body.error?.message ?? `OpenAI audit request failed (${response.status})`);
    const text = body.output?.flatMap(item => item.content ?? []).filter(item => item.type === "output_text").map(item => item.text ?? "").join("\n").trim();
    if (!text) throw new Error("OpenAI audit returned no text");
    return { ...parseChatSections(text, refs), provider: "openai" };
  }
}

class AnthropicAuditProvider implements AuditProvider {
  async answer(question: string, selected: Snapshot, record: InvestigationRecord): Promise<AuditAnswer> {
    const key = process.env.ANTHROPIC_API_KEY;
    const model = process.env.MANGEKYO_LLM_MODEL;
    if (!key || !model) throw new Error("Claude audit provider requires ANTHROPIC_API_KEY and MANGEKYO_LLM_MODEL");
    const refs = chatEvidenceSnapshots(selected, record);
    const screenshotId = selected.screenshot?.url.split("/").at(-1);
    const content: ({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } })[] = [];
    if (screenshotId) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: (await loadScreenshot(screenshotId)).toString("base64") } });
    content.push({ type: "text", text: chatEvidenceContext(question, selected, record) });
    const response = await retryFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 4000, output_config:{format:{type:"json_schema",schema:chatAnswerSchema}}, system: auditChatInstructions, messages: [{ role: "user", content }] }),
    });
    const body = await response.json() as { error?: { message?: string }; content?: { type: string; text?: string }[] };
    if (!response.ok) throw new Error(body.error?.message ?? `Claude audit request failed (${response.status})`);
    const text = body.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("\n").trim();
    if (!text) throw new Error("Claude audit returned no text");
    return { ...parseChatSections(text, refs), provider: "anthropic" };
  }
}

export function auditProvider(): AuditProvider {
  const name = process.env.MANGEKYO_LLM_PROVIDER || "local";
  if (name === "local") return new LocalAuditProvider();
  if (name === "anthropic") return new AnthropicAuditProvider();
  if (name === "openai") return new OpenAiAuditProvider();
  throw new Error(`Unsupported MANGEKYO_LLM_PROVIDER: ${name}`);
}
