import assert from "node:assert/strict";
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import path from "node:path";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, "speechSynthesis", { value: { speak(utterance) { window.testUtterance = utterance; utterance.onstart?.(); }, cancel() {}, pause() {}, resume() {} } });
  });
  await page.route("**/api/visual-audit/tts", route => route.fulfill({ json: { provider: "browser" } }));
  await page.goto(process.env.MANGEKYO_APP_URL || "http://localhost:3000");
  await page.locator(".case-row").first().waitFor();
  await page.getByRole("button", { name: "Expand chat", exact: true }).click();
  assert((await page.locator(".review-inspector").boundingBox()).width > 500);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const firstId = await page.getByLabel("Chat title").inputValue();
  assert.equal(await page.locator(".conversation-message").count(), 0);
  // Stub chat transport so this UI check never writes to the user's case data.
  await page.route("**/api/visual-audit/chat", async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.conversationId, firstId);
    const record = await (await page.request.get(new URL("/api/visual-audit", page.url()).href)).json();
    const snapshot = record.snapshots.find(item => item.id === body.snapshotId);
    const common = { runId: snapshot.runId, conversationId: body.conversationId, conversationTitle: body.conversationTitle, snapshotIds: [snapshot.id], createdAt: new Date().toISOString(), provider: "local" };
    await route.fulfill({ json: { user: { ...common, id: "test-user", role: "user", text: body.question }, assistant: { ...common, id: "test-assistant", role: "assistant", text: "Read the linked evidence." } } });
  });
  await page.getByRole("textbox", { name: "Ask Mangekyo" }).fill("Explain this ownership decision");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("Read the linked evidence.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Chat title").locator("option:checked").textContent(), "Explain this ownership decision");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  assert.equal(await page.locator(".conversation-message").count(), 0);
  await page.getByLabel("Chat title").selectOption(firstId);
  await page.getByText("Read the linked evidence.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Collapse chat", exact: true }).click();
  await page.getByRole("button", { name: "Start walkthrough", exact: true }).click();
  await page.locator(".walkthrough-callout").waitFor();
  await page.locator(".evidence-callout-line path").waitFor({ state: "attached" });
  async function checkCalloutPlacement() {
    await page.locator(".evidence-callout-card").waitFor({ state: "visible" });
    const geometry = await page.locator(".evidence-callout-card").evaluate(card => {
      const bounds = card.getBoundingClientRect();
      const image = card.closest(".evidence-stage").querySelector(".evidence-image");
      const frame = image.getBoundingClientRect();
      const overlaps = Array.from(image.querySelectorAll("[data-evidence-region], .evidence-pin")).some(region => {
        const r = region.getBoundingClientRect();
        return bounds.left < r.right && bounds.right > r.left && bounds.top < r.bottom && bounds.bottom > r.top;
      });
      return { inside: bounds.left >= frame.left && bounds.right <= frame.right && bounds.top >= frame.top && bounds.bottom <= frame.bottom, overlaps };
    });
    assert(geometry.inside, "callout stays inside the snapshot");
    assert(!geometry.overlaps, "callout avoids highlighted regions and their badges");
  }
  await checkCalloutPlacement();
  assert((await page.evaluate(() => window.testUtterance.text)).startsWith((await page.locator(".walkthrough-caption").textContent()).trim()));
  const explanation = (await page.locator(".walkthrough-caption").textContent()).trim();
  await page.getByRole("tab", { name: /Annotations/ }).click();
  assert((await page.locator(".annotation-list").textContent()).includes(explanation));
  await page.getByRole("button", { name: "Pause walkthrough", exact: true }).click();
  await page.getByRole("button", { name: "Resume walkthrough", exact: true }).click();
  assert.equal(await page.locator(".walkthrough-progress").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Next walkthrough step", exact: true }).count(), 0);
  await page.evaluate(() => window.testUtterance.onboundary?.({ charIndex: 15 }));
  assert.equal(await page.locator(".walkthrough-caption .speaking").count(), 0);
  const before = await page.locator(".history-node.selected").getAttribute("aria-label");
  await page.evaluate(() => window.testUtterance.onend?.());
  await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
  assert.equal(await page.locator(".history-node.selected").getAttribute("aria-label"), before, "speech completion must not advance automatically");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  assert.notEqual(await page.locator(".history-node.selected").getAttribute("aria-label"), before);
  await checkCalloutPlacement();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await page.getByRole("textbox", { name: "Ask Mangekyo" }).focus();
  await page.getByRole("button", { name: "Resume walkthrough", exact: true }).waitFor();
  const pin = page.locator(".evidence-pin").first();
  assert.notEqual(await pin.evaluate(e => getComputedStyle(e).backgroundColor), "rgba(0, 0, 0, 0)");
  assert.equal(await pin.evaluate(e => getComputedStyle(e).borderWidth), "0px");
  const dock = await page.locator(".walkthrough-layer").boundingBox();
  const canvas = await page.locator(".evidence-canvas").boundingBox();
  assert(dock.y + dock.height <= canvas.y + 1, "floating island remains above evidence");
  const controls = await page.locator(".canvas-tools").boundingBox();
  assert(dock.y + dock.height < controls.y, "dock must not overlap zoom controls");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(tmpdir(), "mangekyo-walkthrough.png") });
  await page.getByRole("button", { name: "Close walkthrough", exact: true }).click();
  await page.locator(".walkthrough-callout").waitFor({ state: "hidden" });
  await page.waitForTimeout(450);
  assert.equal(Math.round((await page.locator(".walkthrough-island").boundingBox()).width), 68);
  assert.equal(Math.round((await page.locator(".walkthrough-island").boundingBox()).height), 38);
  await page.getByRole("button", { name: "Start walkthrough", exact: true }).click();
  await page.waitForTimeout(500);
  assert((await page.locator(".walkthrough-island").boundingBox()).width > 400);
  await page.getByRole("button", { name: "Close walkthrough", exact: true }).click();
  await page.reload();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  assert(await page.getByLabel("Chat title").locator(`option[value="${firstId}"]`).count());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Expand chat", exact: true }).click();
  assert.equal(Math.round((await page.locator(".review-inspector").boundingBox()).width), 390);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".chat-expanded").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Chat expansion, separate conversations, titles, reload persistence, synchronized speech/captions, callout geometry, annotation parity, playback controls, and mobile passed.");
} finally { await browser.close(); }
