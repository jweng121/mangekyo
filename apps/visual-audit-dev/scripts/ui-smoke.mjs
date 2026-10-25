import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.MANGEKYO_APP_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  assert.equal((await page.goto(base, { waitUntil: "domcontentloaded" })).status(), 200);
  const record = await (await page.request.get(`${base}/api/visual-audit`)).json();
  const open = record.escalations.filter(item => item.status === "open");
  await page.waitForFunction(count => document.querySelectorAll(".case-row").length === count, open.length);
  if (open.length) {
    await page.locator(".case-row").first().click();
    assert.equal(await page.locator(".evidence-viewport").evaluate(node => getComputedStyle(node).overflowY), "visible", "snapshot must not have its own vertical scroller");
    const capture = await page.locator(".evidence-image").boundingBox();
    const viewport = await page.locator(".evidence-viewport").boundingBox();
    assert(capture.y + capture.height <= viewport.y + viewport.height, "full capture fits its page container");
    await page.evaluate(() => window.scrollTo(0, 100));
    assert(await page.evaluate(() => window.scrollY > 0), "page scrolls vertically");
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.locator(".history-caption, .history-outcome, .history-branch-label").count(), 0);
    assert(await page.locator(".history-node.completed .history-dot svg").count() > 0);
    assert((await page.locator(".snapshot-history").boundingBox()).height <= 120, "history stays compact");
    assert.equal(await page.locator(".history-node.selected.conflict").count(), 1, "open at the conflict");
    await page.locator(".annotation-row").first().click();
    await page.locator(".evidence-region.active").waitFor();
    assert.equal(await page.locator(".annotation-row.active").count(), 1);
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    assert.equal(await page.locator(".annotation-list").count(), 0, "one inspector pane at a time");
    await page.locator(".evidence-pin").first().click();
    assert.equal(await page.getByRole("tab", { name: /Annotations/ }).getAttribute("data-state"), "active", "canvas opens related annotation");
    await page.getByRole("button", { name: /Correct decision|Refine correction/, exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Correction instruction" });
    assert.equal(await composer.evaluate(node => node === document.activeElement), true);
    assert((await composer.inputValue()).includes("reference"));
    await page.getByRole("button", { name: "Case actions" }).click();
    assert.equal(await page.getByRole("menuitem", { name: "Review report" }).count(), 1);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".case-heading h1").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "mobile has no horizontal page overflow");
  }
  assert.deepEqual(errors, []);
  console.log("Review UI passed: inbox, viewport fit, compact history, two-way annotations, tabbed inspector, correction composer, menus, and mobile overflow.");
} finally { await browser.close(); }
