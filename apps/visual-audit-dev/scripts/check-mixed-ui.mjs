import { chromium } from 'playwright';
const browser=await chromium.launch({headless:true});
try {
const page=await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://localhost:3000');
await page.locator('.case-row').filter({hasText:'PDF + Database Test'}).click();
console.log(await page.locator('.history-node').evaluateAll(nodes=>nodes.map(n=>n.textContent)));
await page.locator('.history-node').filter({hasText:'Client read'}).first().click();
await page.locator('.record-view').waitFor();
await page.screenshot({path:'../../output/pdf/record-read-ui.png'});
console.log('READ',await page.locator('.record-view').innerText());
await page.locator('.history-node').filter({hasText:'Draft saved'}).last().click();
await page.locator('.record-diff').waitFor();
await page.screenshot({path:'../../output/pdf/record-update-ui.png'});
console.log('UPDATE',await page.locator('.record-diff').innerText());
await page.locator('.history-node').filter({hasText:'Bank'}).first().click();
await page.locator('.pdf-source-bar a').waitFor();
const pdf=await page.request.get(new URL(await page.locator('.pdf-source-bar a').getAttribute('href'), 'http://localhost:3000').href);
if(!(await pdf.body()).subarray(0,5).equals(Buffer.from('%PDF-'))) throw Error('Missing original PDF');
await page.screenshot({path:'../../output/pdf/pdf-evidence-ui.png'});
await page.getByRole('button', {name:'Hide case list', exact:true}).first().click();
await page.setViewportSize({width:390,height:844});
await page.locator('.history-node').filter({hasText:'Client read'}).first().click();
if (!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))) {console.log(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+2 && getComputedStyle(n).position!=='absolute').map(n=>({tag:n.tagName,cls:n.className,width:n.getBoundingClientRect().width,right:n.getBoundingClientRect().right})).slice(0,30)));throw Error('Mobile page overflow');};
console.log('errors',errors);if(errors.length)throw Error(errors.join('\n'));
} finally {await browser.close();}




