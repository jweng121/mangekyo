// Run against an isolated MANGEKYO_LOCAL_DATA_DIR. This creates and resolves a demo case.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import path from "node:path";

const base = process.env.MANGEKYO_APP_URL;
if (!base) throw new Error("Set MANGEKYO_APP_URL to the isolated test server");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() { this.onstart?.(); this.onresult?.({ results: [[{ transcript: "Verify the bank payment reference." }]] }); this.onend?.(); }
      stop() { this.onend?.(); }
    };
  });
  const started = await page.request.post(`${base}/api/visual-audit`, { data: { action: "start" }, timeout: 90000 });
  assert.equal(started.status(), 200, await started.text());
  const { run } = await started.json();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator(".case-row").first().waitFor();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Dictate message", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "Ask Mangekyo" }).inputValue(), "Verify the bank payment reference.");
  await page.route("**/api/visual-audit/chat", async route => { await new Promise(resolve => setTimeout(resolve, 700)); await route.continue(); });
  await page.getByRole("textbox", { name: "Ask Mangekyo" }).fill("Why was this decision flagged?");
  const chatResponse = page.waitForResponse(response => response.url().endsWith("/api/visual-audit/chat") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.locator(".thinking-indicator").waitFor();
  assert.equal((await chatResponse).status(), 200);
  await page.locator(".conversation-message.assistant").first().waitFor();
  await page.getByRole("tab", { name: /Annotations/ }).click();
  await page.getByRole("button", { name: "Correct decision", exact: true }).click();
  const steeringResponse = page.waitForResponse(response => response.url().endsWith("/api/visual-audit") && response.request().method() === "POST", { timeout: 90000 });
  await page.getByRole("button", { name: "Send correction", exact: true }).click();
  assert.equal((await steeringResponse).status(), 200);
  await page.locator(".history-node.corrected.selected").waitFor();
  assert(await page.locator(".evidence-image img").count() > 0, "correction opens an actual capture");
  await page.getByRole("button", { name: "Compare evidence", exact: true }).click();
  assert.equal(await page.locator(".comparison-pane").count(), 2);
  await page.screenshot({ path: path.join(tmpdir(), "mangekyo-review-flow-comparison.png") });
  await page.getByRole("button", { name: "Close comparison", exact: true }).click();
  // Keep report and memory review working before closing the exception.
  await page.getByRole("button", { name: "Case actions" }).click();
  await page.getByRole("menuitem", { name: "Review report" }).click();
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await page.getByRole("button", { name: "Approve report", exact: true }).click();
  await page.getByRole("button", { name: "File report", exact: true }).click();
  await page.getByRole("button", { name: "Prepare lesson for review", exact: true }).click();
  await page.getByRole("button", { name: "Approve lesson", exact: true }).click();
  await page.getByText("Approved and available for matching tasks", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close report", exact: true }).click();
  await page.getByRole("button", { name: "Approve & resolve", exact: true }).click();
  await page.locator(".conversation-message.assistant").filter({ hasText: "Marked as resolved" }).waitFor();
  assert.equal(await page.getByLabel("Case status").inputValue(), "resolved");
  await page.reload();
  await page.getByLabel("Case status").selectOption("resolved");
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await page.locator(".conversation-message.assistant").filter({ hasText: "Marked as resolved" }).waitFor();
  const record = await (await page.request.get(`${base}/api/visual-audit`)).json();
  assert.equal(record.escalations.find(item => item.runId === run.id).status, "resolved");
  assert.equal(record.memoryRecords.at(-1).status, "approved");
  assert.equal(record.chatMessages.filter(item => item.runId === run.id && item.text.startsWith("Marked as resolved")).length, 1);
  const rejected = await page.request.post(`${base}/api/visual-audit/resolve`, { data: { runId: run.id } });
  assert.equal(rejected.status(), 400);
  const afterRetry = await (await page.request.get(`${base}/api/visual-audit`)).json();
  assert.equal(afterRetry.chatMessages.filter(item => item.runId === run.id && item.text.startsWith("Marked as resolved")).length, 1);
  assert.deepEqual(errors, []);
  console.log("Isolated review flow passed: real captures, chat thinking state, dictation lifecycle, correction, branch selection, comparison, report, memory, and persistent resolution.");
} finally { await browser.close(); }
