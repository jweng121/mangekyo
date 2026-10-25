import { chromium } from "playwright";
import { tmpdir } from "node:os";
import path from "node:path";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => console.log(`pageerror: ${error.message}`));
  await page.goto(process.env.MANGEKYO_APP_URL || "http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.locator(".case-row").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(tmpdir(), "mangekyo-review-desktop.png") });
  console.log(await page.evaluate(() => ({ height: innerHeight, documentHeight: document.documentElement.scrollHeight, canvas: document.querySelector(".evidence-canvas").getBoundingClientRect().toJSON(), image: document.querySelector(".evidence-image").getBoundingClientRect().toJSON() })));
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await page.screenshot({ path: path.join(tmpdir(), "mangekyo-review-chat.png") });
  await page.getByRole("button", { name: "Compare evidence", exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(tmpdir(), "mangekyo-review-comparison.png") });
  await page.getByRole("button", { name: "Close comparison", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Hide case list", exact: true }).first().click();
  await page.screenshot({ path: path.join(tmpdir(), "mangekyo-review-mobile.png"), fullPage: true });
  console.log(path.join(tmpdir(), "mangekyo-review-desktop.png"));
} finally { await browser.close(); }
