import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.MANGEKYO_APP_URL || "http://localhost:3000";
const record = await (await fetch(`${base}/api/visual-audit`)).json();
const escalation = [...record.escalations].reverse().find(item => item.status === "open");
assert(escalation, "Run a demo escalation before the review UI smoke check");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  assert.equal((await page.goto(`${base}/escalations/${encodeURIComponent(escalation.runId)}`, { waitUntil: "domcontentloaded" })).status(), 200);
  await page.locator(".annotation-row").first().waitFor();
  await page.locator(".annotation-row").first().click();
  assert.equal(await page.locator(".annotation-row.active").count(), 1);
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  assert.equal(await page.locator(".annotation-list").count(), 0);
  await page.getByRole("tab", { name: /Annotations/ }).click();
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await page.locator(".walkthrough-island.expanded").waitFor();
  await page.getByRole("button", { name: "Close walkthrough" }).click();
  assert.equal(await page.locator(".walkthrough-island.expanded").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".annotation-row").first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "mobile has no horizontal page overflow");
  assert.deepEqual(errors, []);
  console.log("Review UI passed: escalation, annotations, inspector tabs, walkthrough controls, and mobile width.");
} finally { await browser.close(); }
