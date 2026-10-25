import {chromium} from "playwright";
import assert from "node:assert/strict";
const base="http://localhost:3000";
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1512,height:1000}});
try{
 const record=await(await fetch(base+"/api/visual-audit")).json();
 const roots=record.runs.filter(r=>r.displayName&&!r.parentRunId&&record.escalations.some(e=>e.runId===r.id));assert(roots.length>=2);
 await page.route("**/api/visual-audit/stream",route=>route.abort());
 await page.route("**/api/visual-audit",async route=>{await new Promise(resolve=>setTimeout(resolve,1800));await route.fulfill({json:record});});
 await page.goto(base+"/escalations/"+roots[0].id,{waitUntil:"domcontentloaded"});
 await page.getByRole("heading",{name:"Loading review",exact:true}).waitFor();assert.equal(await page.getByText("You're all caught up.",{exact:true}).count(),0);
 await page.locator(".case-heading h1").filter({hasText:roots[0].displayName??roots[0].taskId}).waitFor();
 await page.goto(base+"/escalations/"+roots[1].id);await page.locator(".case-heading h1").filter({hasText:roots[1].displayName??roots[1].taskId}).waitFor();
 await page.goto(base+"/escalations/nonexistent-review");await page.getByRole("heading",{name:"Review unavailable",exact:true}).waitFor();assert.equal(await page.getByText("You're all caught up.",{exact:true}).count(),0);assert.equal(await page.locator('.review-workspace').count(),0);
 await page.unroute("**/api/visual-audit");await page.route("**/api/visual-audit",route=>route.fulfill({status:503,json:{error:"Test connection unavailable"}}));await page.goto(base+"/escalations/"+roots[0].id);await page.getByRole("heading",{name:"Unable to load review",exact:true}).waitFor();assert.equal(await page.getByText("You're all caught up.",{exact:true}).count(),0);
 console.log("Passed: delayed loading, saved/completed deep links, missing run without unrelated fallback, fetch error without false empty state.");
}finally{await browser.close();}
