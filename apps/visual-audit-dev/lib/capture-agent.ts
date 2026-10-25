import "server-only";
import { readFile } from "node:fs/promises";
import { capturePdfRead, demoPdfPath } from "./pdf-evidence";
import { chromium, type Locator, type Page } from "playwright";
import type { AgentEvent, InvestigationRun, MemoryEntry, Snapshot, SteeringRequest, StructuredObservation } from "../../../packages/contracts";
import { addRun, appendCheckpoint, readInvestigation, localTenantId, saveScreenshot, updateRun } from "./local-store";

export type CaptureInput = {
  page: Page;
  run: InvestigationRun;
  sequence: number;
  parentEventIds: string[];
  parentSnapshotId?: string;
  actionType: AgentEvent["actionType"];
  title: string;
  summary: string;
  locator?: Locator;
  fieldId?: string;
  fieldLabel?: string;
  extractedValue?: string;
  toolCall: string;
  toolResponse: string;
  auditStatus?: Snapshot["auditStatus"];
  output?: Record<string, string>;
  recordedJustification?: string;
  captureScreenshot?: boolean;
  documentId?: string;
  documentVersion?: string;
  pageNumber?: number;
};

export async function createMonitoredRun(input: { tenantId: string; taskId: string; agentId: string; branchId?: string; parentRunId?: string }): Promise<InvestigationRun> {
  if (input.tenantId !== localTenantId()) throw new Error("Tenant mismatch");
  if (!input.taskId.trim() || !input.agentId.trim()) throw new Error("Task and agent are required");
  const run: InvestigationRun = { id: crypto.randomUUID(), schemaVersion: 1, tenantId: input.tenantId, taskId: input.taskId, agentId: input.agentId, branchId: input.branchId ?? "original", parentRunId: input.parentRunId, createdAt: new Date().toISOString(), status: "running" };
  await addRun(run);
  return run;
}

export async function captureStructuredCheckpoint(input: {
  run: InvestigationRun; sequence: number; actionType: AgentEvent["actionType"];
  title: string; summary: string; documentId: string; documentVersion: string;
  observation: Omit<StructuredObservation, "kind">; toolCall: string; toolResponse: string;
  recordedJustification?: string;
}): Promise<Snapshot> {
  if (input.sequence < 1 || !Number.isInteger(input.sequence)) throw new Error("Invalid checkpoint sequence");
  if (!input.documentId || !input.documentVersion) throw new Error("Document identity and version are required");
  const { run, sequence } = input;
  const timestamp = new Date().toISOString();
  const id = `${run.id}-snapshot-${sequence}`;
  const eventId = `${run.id}-event-${sequence}`;
  const evidence = input.observation.fields.map(field => ({ id: `${id}-${field.id}`, label: field.label, source: input.documentId, field: field.id, value: field.value }));
  const event: AgentEvent = { id: eventId, schemaVersion: 1, runId: run.id, taskId: run.taskId, sequence, timestamp, agentId: run.agentId, agentRole: run.agentId, actionType: input.actionType, title: input.title, summary: input.summary, parentEventIds: sequence > 1 ? [`${run.id}-event-${sequence - 1}`] : [], branchId: run.branchId, snapshotId: id, status: "completed", toolCall: input.toolCall, toolResponse: input.toolResponse };
  const snapshot: Snapshot = { id, schemaVersion: 1, eventId, runId: run.id, taskId: run.taskId, parentSnapshotId: sequence > 1 ? `${run.id}-snapshot-${sequence - 1}` : undefined, agentId: run.agentId, agentRole: run.agentId, timestamp, sequence, actionType: input.actionType, title: input.title, summary: input.summary, documentId: input.documentId, documentVersion: input.documentVersion, observation: { ...input.observation, kind: "api" }, source: input.documentId, readTargets: input.actionType === "READ" ? input.observation.fields.map(field => field.label) : [], writeTargets: input.actionType === "WRITE_CONFIRMED" ? input.observation.fields.map(field => field.label) : [], evidence, instructionVersion: "execution-adapter", policyVersion: "execution-adapter", executionStatus: "completed", auditStatus: "unreviewed", toolCall: input.toolCall, toolResponse: input.toolResponse, recordedJustification: input.recordedJustification };
  const primaryField = input.observation.fields[0];
  if (primaryField) snapshot.annotations = [{ id: `${id}:${primaryField.id}`, snapshotId: id, evidenceRef: evidence[0].id, label: primaryField.label, fieldPath: `observation.fields.${primaryField.id}`, textQuote: primaryField.value }];
  await appendCheckpoint(event, snapshot);
  return snapshot;
}

export async function captureBrowserCheckpoint(input: CaptureInput): Promise<{ event: AgentEvent; snapshot: Snapshot }> {
  const { page, run, sequence } = input;
  const eventId = `${run.id}-event-${sequence}`;
  const snapshotId = `${run.id}-snapshot-${sequence}`;
  const timestamp = new Date().toISOString();
  if (input.locator) await input.locator.scrollIntoViewIfNeeded();
  const viewport = page.viewportSize();
  const box = input.locator ? await input.locator.boundingBox() : null;
  const documentView = await page.evaluate(() => ({
    scrollX: window.scrollX, scrollY: window.scrollY,
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight),
  }));
  const documentPage = page.locator("[data-document-page]");
  const documentBounds = await documentPage.count() ? await documentPage.boundingBox() : null;
  const screenshot = input.captureScreenshot === false ? undefined : documentBounds
    ? await documentPage.screenshot({ type: "png", animations: "disabled", scale: "css" })
    : await page.screenshot({ type: "png", fullPage: true, animations: "disabled", scale: "css" });
  const artifact = screenshot ? await saveScreenshot(screenshot) : undefined;
  // PNG dimensions are authoritative; full-page regions use document coordinates.
  const screenshotDimensions = screenshot ? { width: screenshot.readUInt32BE(16), height: screenshot.readUInt32BE(20) } : { width: documentView.width, height: documentView.height };
  const documentBox = box ? { ...box, x: documentBounds ? box.x - documentBounds.x : box.x + documentView.scrollX, y: documentBounds ? box.y - documentBounds.y : box.y + documentView.scrollY } : undefined;
  const bounds = documentBox && documentBox.x >= 0 && documentBox.y >= 0 && documentBox.x + documentBox.width <= screenshotDimensions.width && documentBox.y + documentBox.height <= screenshotDimensions.height
    ? { x: documentBox.x / screenshotDimensions.width, y: documentBox.y / screenshotDimensions.height, width: documentBox.width / screenshotDimensions.width, height: documentBox.height / screenshotDimensions.height } : undefined;
  const evidenceId = `${snapshotId}-evidence`;
  const value = input.extractedValue ?? (input.locator ? (await input.locator.textContent())?.trim() ?? "" : input.toolResponse);
  const agentId = run.agentId;
  const agentRole = agentId === "deposit-matching-agent" ? "Deposit Matching Agent" : agentId;
  const event: AgentEvent = { id: eventId, schemaVersion: 1, runId: run.id, taskId: run.taskId, sequence, timestamp, agentId, agentRole, actionType: input.actionType, title: input.title, summary: input.summary, parentEventIds: input.parentEventIds, branchId: run.branchId, snapshotId, status: "completed", toolCall: input.toolCall, toolResponse: input.toolResponse, browserUrl: page.url() };
  const snapshot: Snapshot = {
    id: snapshotId, schemaVersion: 1, eventId, runId: run.id, taskId: run.taskId, agentId, agentRole, timestamp, sequence,
    parentSnapshotId: input.parentSnapshotId ?? (sequence > 1 ? `${run.id}-snapshot-${sequence - 1}` : undefined),
    documentId: input.documentId ?? page.url(), documentVersion: input.documentVersion ?? "observed", viewport: viewport ? { ...viewport, page: input.pageNumber } : undefined, targetRegion: bounds,
    actionType: input.actionType, title: input.title, summary: input.summary,
    screenshot: artifact ? { url: `/api/visual-audit/artifacts/${artifact}`, provenance: "actual", alt: `Chromium capture of ${input.title}`, capturedAt: timestamp, artifactId: artifact } : undefined,
    screenshotDimensions, browserUrl: page.url(), toolCall: input.toolCall, toolResponse: input.toolResponse,
    recordedJustification: input.recordedJustification,
    observation: { kind: documentBounds ? "document" : "browser", label: page.url(), fields: input.fieldId ? [{ id: input.fieldId, label: input.fieldLabel ?? input.fieldId, value, sourceRef: evidenceId, emphasis: input.auditStatus === "flagged" ? "conflict" : "read", bounds }] : [], output: input.output, toolInteractions: [{ tool: "Playwright", request: input.toolCall, response: input.toolResponse }] },
    source: page.url(), readTargets: input.actionType === "READ" ? [input.fieldLabel ?? input.fieldId ?? input.title] : [], writeTargets: input.actionType === "WRITE_CONFIRMED" ? [input.fieldLabel ?? input.fieldId ?? input.title] : [],
    evidence: [{ id: evidenceId, label: input.fieldLabel ?? input.title, source: page.url(), field: input.fieldId, value }],
    annotations: input.fieldId ? [{ id: `${snapshotId}:${input.fieldId}`, evidenceRef: evidenceId, snapshotId, label: input.fieldLabel ?? input.fieldId, fieldPath: `observation.fields.${input.fieldId}`, region: bounds }] : [],
    instructionVersion: run.steeringId ? "demo-agent-2-steered" : run.memoryId ? "demo-agent-1-memory-guided" : "demo-agent-1", policyVersion: "demo-no-posting-1", executionStatus: "completed", auditStatus: input.auditStatus ?? "unreviewed", memoryRefs: run.memoryId ? [run.memoryId] : undefined,
  };
  await appendCheckpoint(event, snapshot);
  return { event, snapshot };
}

const capture = captureBrowserCheckpoint;

export async function runBrowserAgent(baseUrl: string, steering?: SteeringRequest, memory?: MemoryEntry, displayName?: string): Promise<InvestigationRun> {
  const run: InvestigationRun = { displayName, id: crypto.randomUUID(), schemaVersion: 1, tenantId: localTenantId(), taskId: "bank-line-1042", agentId: "deposit-matching-agent", branchId: steering ? "corrected" : memory ? "future" : "original", parentRunId: steering?.parentRunId ?? memory?.sourceRunId, steeringId: steering?.id, memoryId: memory?.id, createdAt: new Date().toISOString(), status: "running" };
  await addRun(run);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: process.env.MANGEKYO_BROWSER_HEADLESS !== "false" });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const erpUrl = new URL("/erp", baseUrl);
    if (!["localhost", "127.0.0.1"].includes(erpUrl.hostname)) throw new Error("Demo ERP must be local");
    await page.goto(erpUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
    const bankRead = await capturePdfRead({ bytes: await readFile(demoPdfPath("bank")), filename: "trust-bank-statement.pdf", run, sequence: 1, title: "Bank payment reference", field: "bank-reference", label: "Bank reference", pattern: "1042\\s+2026-10-23\\s+([A-Z]-[0-9]+ / [A-Za-z ]+deposit)", group: 1, parentSnapshotId: steering?.checkpointSnapshotId ?? memory?.sourceSnapshotId });
    const bankReference = bankRead.value;
    const fundingRead = await capturePdfRead({ bytes: await readFile(demoPdfPath("funding")), filename: "trust-funding-instruction.pdf", run, sequence: 2, title: "Trust funding instruction", field: "invoice-customer", label: "Registered client", pattern: "Client [A-Z]\\b" });
    const invoiceName = fundingRead.value;
    const code = bankReference.split(" ")[0];
    await page.getByTestId("nav-customers").click();
    await page.getByTestId("company-search").fill(code);
    const row = page.getByTestId("company-client-b");
    await row.waitFor();
    const registerResponse = await page.request.get(new URL(`/api/demo-ledger?paymentCode=${encodeURIComponent(code)}`, baseUrl).toString());
    if (!registerResponse.ok()) throw new Error("Client register read failed");
    const register = await registerResponse.json();
    const client = register.records[0];
    if (!client) throw new Error("No matching client record");
    const owner = client.trust as string;
    const matchedCode = client.code as string;
    await captureStructuredCheckpoint({ run, sequence: 3, actionType: "READ", title: "Payment code owner", summary: `Read trust_client_register where payment_code = ${code}; the returned record identifies ${owner}.`, documentId: "trust_client_register", documentVersion: "demo-register-1", toolCall: `GET /api/demo-ledger?paymentCode=${code}`, toolResponse: JSON.stringify(register), observation: { record: register.record, label: "Trust client register / Read result", input: { paymentCode: code }, output: { recordsReturned: "1", operation: "Read", status: "200 OK" }, fields: [
      { id: "company-client-b", label: "Matching client record", value: `${matchedCode} / ${owner}`, emphasis: "read" },
      { id: "client-id", label: "Client ID", value: client.id }, { id: "legal-entity", label: "Legal entity", value: client.legal }, { id: "liability-account", label: "Trust liability account", value: client.account }, { id: "funding-reference", label: "Funding reference", value: client.invoice },
    ] } });
    await page.getByTestId("company-search").fill("");
    // Version 1 deliberately prefers the first amount-matched invoice. Steering only changes
    // the matching policy after the agent independently rereads the bank and customer record.
    const applyReferenceRule = !!steering && /reference|payment code|bank evidence|verify/i.test(steering.instruction) || !!memory && /reference|payment code/i.test(memory.content);
    const proposedOwner = applyReferenceRule && matchedCode === code ? "Client B" : invoiceName;
    const justification = applyReferenceRule ? `${steering ? "Steering" : "Approved scoped memory"} requested reference verification. Browser search matched ${matchedCode} to ${owner}; propose Client B.` : `Initial heuristic preferred amount-matched invoice INV-88 (${invoiceName}); reference ${code} was observed but not resolved.`;
    await page.getByTestId("nav-allocation").click();
    await page.getByTestId("owner-select").selectOption({ value: proposedOwner });
    const selector = page.getByTestId("owner-select");
    await capture({ page, run, sequence: 4, parentEventIds: [`${run.id}-event-3`], actionType: "PROPOSE", title: "Owner allocation proposal", summary: `Prepared ${proposedOwner} as owner for the $5,000 deposit.`, documentId: "deposit-draft-1042", documentVersion: "draft-selection", locator: selector, fieldId: "proposed-owner", fieldLabel: "Proposed owner", extractedValue: proposedOwner, toolCall: `selectOption('${proposedOwner}')`, toolResponse: `Draft selection ${proposedOwner}; no ledger write`, auditStatus: proposedOwner === "Client A" ? "flagged" : "clear", output: { proposedOwner, status: "proposal only" }, recordedJustification: justification });
    const previous = steering ? (await readInvestigation()).snapshots.find(item => item.runId === steering.parentRunId && item.sequence === 5)?.observation.record?.transactionId : undefined;
    let writeResult;
    if (previous) {
      const response = await page.request.patch(new URL("/api/demo-ledger", baseUrl).toString(), { data: { owner: proposedOwner, bankLine: "1042", draftId: previous } });
      writeResult = await response.json();
      if (!response.ok() || !writeResult.writeConfirmed) throw new Error("Allocation correction was not saved");
    } else {
      const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/demo-ledger") && response.request().method() === "POST");
      await page.getByTestId("proposal-submit").click();
      const response = await responsePromise;
      writeResult = await response.json();
      if (!response.ok() || !writeResult.writeConfirmed) throw new Error("Allocation draft was not saved");
    }
    const result = `Draft ${writeResult.draft.id} saved for ${proposedOwner}. Trust ledger not posted.`;
    await captureStructuredCheckpoint({ run, sequence: 5, actionType: "WRITE_CONFIRMED", title: "Draft proposal result", summary: result, documentId: "allocation_drafts", documentVersion: writeResult.draft.id, toolCall: `${previous ? "PATCH" : "POST"} /api/demo-ledger`, toolResponse: JSON.stringify(writeResult), observation: { record: writeResult.record, label: previous ? "Allocation correction" : "Allocation draft", input: { owner: proposedOwner, bankLine: "1042" }, output: { draftSaved: "Yes", ledgerPosted: "No", status: "Draft / pending approval" }, changes: writeResult.record.changes, fields: [
      { id: "proposal-result", label: "Draft save confirmation", value: result, emphasis: "modified" }, { id: "draft-id", label: "Draft ID", value: writeResult.draft.id }, { id: "owner", label: "Proposed client", value: proposedOwner, emphasis: "modified" }, { id: "account", label: "Trust liability account", value: writeResult.draft.liabilityAccount }, { id: "amount", label: "Amount", value: "CAD 5,000.00" }, { id: "posting", label: "Financial posting", value: "None / draft record only" },
    ] } });
    await updateRun(run.id, { status: proposedOwner === "Client A" ? "escalated" : "corrected", proposedOwner });
    return { ...run, status: proposedOwner === "Client A" ? "escalated" : "corrected", proposedOwner };
  } catch (error) {
    await updateRun(run.id, { status: "failed", proposedOwner: undefined });
    throw error;
  } finally { await browser?.close(); }
}
