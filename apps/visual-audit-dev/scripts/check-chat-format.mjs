import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base='http://localhost:3000';
const record=await (await fetch(`${base}/api/visual-audit`)).json();
const run=record.runs.find(run=>run.displayName==='PDF + Database Test');assert(run);
record.chatMessages.push({id:'markdown-test',runId:run.id,role:'assistant',text:'**Short answer:** Review the match.\n\n**Recorded facts**\n- Client B matches.\n- No posting.\n\n<script>alert(1)</script>',snapshotIds:[],createdAt:new Date().toISOString(),conversationId:'default'});
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 await page.route('**/api/visual-audit',route=>route.fulfill({json:record}));
 await page.route('**/api/visual-audit/stream',route=>route.fulfill({contentType:'text/event-stream',body:`data: ${JSON.stringify(record)}\n\n`}));
 await page.goto(base);await page.locator('.case-row').filter({hasText:'PDF + Database Test'}).click();
 await page.getByRole('tab',{name:'Chat',exact:true}).click();
 const message=page.locator('.chat-message-body').filter({hasText:'Short answer:'});
 await message.waitFor();assert.equal(await message.locator('strong').count(),2);assert.equal(await message.locator('li').count(),2);assert(!(await message.innerText()).includes('**'));assert.equal(await message.locator('script').count(),0);
 console.log('Saved Markdown renders correctly; raw HTML is not executed.');
}finally{await browser.close();}
