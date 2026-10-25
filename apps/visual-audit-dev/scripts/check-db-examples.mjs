import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base=process.env.MANGEKYO_APP_URL || 'http://localhost:3000';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);
 for(const [title,count] of [['DB Read / Client mismatch',1],['DB Read / Multiple records',4],['DB Read / No matching record',0]]) {
  await page.locator('.case-row').filter({hasText:title}).click();
  await page.locator('.record-view').waitFor();
  assert.equal(await page.locator('.record-view .record-fields tbody tr').count(),count);
  assert.match(await page.locator('.record-view').innerText(),/Read \/ succeeded/);
  assert.equal(await page.locator('.evidence-image').count(),0);
  if(count===0)assert.equal(await page.locator('.record-empty').innerText(),'No matching records');
  await page.getByRole('tab',{name:'Chat',exact:true}).click();
  assert(await page.getByText(/Database read example\./).count()>0);
  console.log(`${title}: ${count} rows, saved agent explanation, no image substitute`);
 }
 assert.deepEqual(errors,[]);
} finally {await browser.close();}
