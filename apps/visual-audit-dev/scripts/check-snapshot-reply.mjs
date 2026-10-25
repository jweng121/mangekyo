import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base='http://localhost:3000';
const record=await(await fetch(`${base}/api/visual-audit`)).json();
const run=record.runs.find(item=>item.displayName==='PDF + Database Test');
const snapshots=record.snapshots.filter(item=>item.runId===run.id);
const ordered=[7,1,3].map(sequence=>snapshots.find(item=>item.sequence===sequence));
const sections=ordered.map((snapshot,index)=>({snapshotId:snapshot.id,text:['First, the escalation needs review.','Next, read the bank reference.','Finally, the lookup identifies Client B.'][index],annotationIds:snapshot.annotations?.map(item=>item.id)??[]}));
const rate=8000,samples=rate*3,wav=Buffer.alloc(44+samples*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),spoken=[];
 await page.route('**/api/visual-audit',route=>route.fulfill({json:record}));
 await page.route('**/api/visual-audit/stream',route=>route.fulfill({contentType:'text/event-stream',body:`data: ${JSON.stringify(record)}\n\n`}));
 await page.route('**/api/visual-audit/chat',route=>route.fulfill({json:{user:{id:'section-user',runId:run.id,role:'user',text:'Escalation, then bank, then lookup',snapshotIds:[],createdAt:new Date().toISOString()},assistant:{id:'section-answer',runId:run.id,role:'assistant',text:sections.map(item=>item.text).join('\n\n'),sections,snapshotIds:ordered.map(item=>item.id),createdAt:new Date().toISOString()}}}));
 await page.route('**/api/visual-audit/tts',route=>{
   if(route.request().method()==='GET') return route.fulfill({json:{provider:'fish',configured:true}});
   const text=route.request().postDataJSON().text;spoken.push(text);
   return route.fulfill({contentType:'text/event-stream',body:`data: ${JSON.stringify({audio_base64:wav.toString('base64'),chunk_seq:0,chunk_audio_offset_sec:0,alignment:{segments:text.split(' ').map((text,index)=>({text,start:index*.25,end:(index+1)*.25}))}})}\n\n`});
 });
 await page.addInitScript(()=>{window.EventSource=class { close(){} };});
 await page.goto(base);await page.locator('.case-row').filter({hasText:'PDF + Database Test'}).click();
 await page.getByRole('tab',{name:'Chat',exact:true}).click();
 await page.getByRole('textbox',{name:'Ask Mangekyo',exact:true}).fill('Escalation, then bank, then lookup');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 const reply=page.locator('.snapshot-chat-reply').last();await reply.waitFor();
 assert.deepEqual(await reply.locator('.snapshot-chat-section').evaluateAll(nodes=>nodes.map(node=>node.dataset.snapshotId)),ordered.map(item=>item.id));
 assert(await reply.locator('.snapshot-chat-section').evaluateAll(nodes=>nodes.every(node=>node.children[0].classList.contains('inline-snapshot-preview')&&node.children[1].classList.contains('chat-message-body'))));
 await page.waitForFunction(()=>document.querySelector('.evidence-structured h3')?.textContent==='Human ownership review');
 await page.locator(`[data-evidence-region="${ordered[1].annotations[0].id}"].active`).waitFor();
 assert.equal(await page.locator('.evidence-region.active').evaluate(node=>getComputedStyle(node).animationName),'narration-focus');
 await page.waitForFunction(()=>!!document.querySelector('.record-focused'));
 assert.deepEqual(spoken,sections.map(item=>item.text));
 await page.getByRole('button',{name:'Close walkthrough',exact:true}).click();
 await page.screenshot({path:new URL('../../../output/snapshot-reply-check.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),fullPage:false});
 console.log('Passed: ordered preview/text sections; escalation -> PDF highlight animation -> database highlight during speech.');
} finally { await browser.close(); }
