import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base='http://localhost:3000';const browser=await chromium.launch();const page=await browser.newPage();
const state=async()=>await(await fetch(base+'/api/workspace')).json();
try{
 await page.goto(base+'/desk');await page.locator('.ws-header h1').waitFor();await page.waitForTimeout(1800);
 assert.equal(await page.locator('.ws-demo-controls').count(),0);
 await page.keyboard.press('Control+Alt+Digit0');await page.waitForTimeout(800);
 assert.equal((await state()).simulation.phase,'disconnected');
 await page.getByRole('textbox',{name:'Search Overview'}).focus();await page.keyboard.press('Control+Alt+Digit1');await page.waitForTimeout(500);assert.equal((await state()).simulation.phase,'disconnected');await page.getByRole('heading',{name:'Overview',exact:true}).click();
 await page.keyboard.press('Control+Alt+Digit1');let data;
 for(let n=0;n<120;n++){await page.waitForTimeout(500);data=await state();if(data.simulation.phase==='connected')break;}
 assert.equal(data.simulation.phase,'connected');assert.equal(data.bank.transactions.length,170);
 await page.keyboard.press('Control+Alt+Digit2');await page.waitForTimeout(3500);assert.equal((await state()).simulation.phase,'receiving');
 await page.keyboard.press('Control+Alt+Digit0');await page.waitForTimeout(12000);data=await state();assert.equal(data.simulation.phase,'disconnected');assert.equal(data.bank.closing,0);assert.equal(data.bank.transactions.length,0);assert.equal(data.clients.length,0);assert.equal(data.documents.length,0);assert.equal(data.drafts.length,0);assert.equal(data.simulation.runIds.length,0);assert(data.record.runs.length>0,'Saved reviews preserved');
 await page.reload();await page.locator('.ws-header h1').waitFor();assert.equal((await state()).simulation.imported,0);console.log('Passed: shortcuts, no controls, typing guard, live connection, incoming data, reset during processing, empty restored workspace, persistence, preserved reviews.');
}finally{await browser.close()}
