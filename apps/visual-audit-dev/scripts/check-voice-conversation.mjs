import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const rate=8000,samples=64000,wav=Buffer.alloc(44+samples*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),requests=[],questions=[];
 await page.route('**/api/visual-audit/chat',async route=>{
  const body=route.request().postDataJSON();questions.push(body.question);
  const response={user:{id:'test-user',runId:'test',role:'user',text:body.question,snapshotIds:[],createdAt:new Date().toISOString()},assistant:{id:'test-assistant',runId:'test',role:'assistant',text:'The recorded lookup identifies Client B.',snapshotIds:[],createdAt:new Date().toISOString()}};
  await route.fulfill({json:response});
 });
 await page.route('**/api/visual-audit/tts',route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{provider:'fish',configured:true}});
  const request=route.request().postDataJSON();requests.push(request.text);assert.equal(request.timestamps,true);
  const segments=request.text.match(/\S+/g).map((text,i)=>({text,start:.3+i*.4,end:.6+i*.4}));
  return route.fulfill({contentType:'text/event-stream',body:`data: ${JSON.stringify({audio_base64:wav.toString('base64'),chunk_seq:0,chunk_audio_offset_sec:0,alignment:{segments}})}\n\n`});
 });
 await page.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = async () => {
   const context=new AudioContext(), oscillator=context.createOscillator(), gain=context.createGain(), destination=context.createMediaStreamDestination();
   gain.gain.value=0; oscillator.frequency.value=220; oscillator.connect(gain);gain.connect(destination);oscillator.start();await context.resume();
   window.testMicGain=gain;window.testMicStopped=false;
   const track=destination.stream.getAudioTracks()[0], stop=track.stop.bind(track);
   track.stop=()=>{window.testMicStopped=true;stop();void context.close();};
   return destination.stream;
  };
  window.SpeechRecognition = class {
   start() { window.testRecognitionStarts=(window.testRecognitionStarts || 0)+1; window.testRecognition=this; this.onstart?.(); }
   stop() { window.testRecognitionStopped=true; if(window.testFinalTranscript)this.onresult?.({results:[[{transcript:window.testFinalTranscript}]]}); this.onend?.(); }
  };
 });
 await page.goto('http://localhost:3000');await page.locator('.case-row').filter({hasText:'DB Read / Client mismatch'}).click();
 await page.getByRole('button',{name:'Start walkthrough',exact:true}).click();
 const caption=page.locator('.caption-phrase');await caption.waitFor();
 await page.waitForFunction(()=>document.querySelector('.caption-phrase')?.textContent==='The agent');
 assert.equal(await caption.innerText(),'The agent');
 const title=await page.locator('.walkthrough-callout').boundingBox(),text=await caption.boundingBox();assert(text.y>=title.y+title.height);
 await page.getByRole('button',{name:'Pause walkthrough',exact:true}).click();
 await page.getByText('Listening',{exact:true}).waitFor();
 assert.equal(await page.locator('.operator-waveform.speaking').count(),0);
 await page.waitForFunction(()=>!!window.testMicGain);
 await page.evaluate(()=>window.testMicGain.gain.value=.05);
 await page.locator('.operator-waveform.speaking').waitFor();
 const quietHeight=await page.locator('.operator-waveform i').first().evaluate(node=>Number(node.style.transform.match(/scaleY\(([^)]+)\)/)[1]));
 await page.evaluate(()=>window.testMicGain.gain.value=.2);
 await page.waitForFunction(previous=>Number(document.querySelector('.operator-waveform i').style.transform.match(/scaleY\(([^)]+)\)/)[1])>previous+.1,quietHeight);

 await page.evaluate(()=>window.testRecognition.onresult({results:[[{transcript:'Why did the agent choose Client A?'}]]}));
 await page.evaluate(()=>window.testMicGain.gain.value=0);
 await page.waitForFunction(()=>document.querySelector('.walkthrough-callout strong')?.textContent==='Mangekyo');
 await page.waitForFunction(()=>document.querySelector('.caption-phrase')?.textContent?.startsWith('The recorded'));
 assert.equal(questions.length,1);assert.equal(requests.length,2);
 assert.equal(requests[1],'The recorded lookup identifies Client B.');
 assert.equal(await page.locator('.operator-waveform').count(),0,'Microphone UI stays off while the reply speaks');
 assert(await page.evaluate(()=>window.testMicStopped));
 const starts=await page.evaluate(()=>window.testRecognitionStarts);
 await page.waitForFunction(previous=>window.testRecognitionStarts>previous,starts,{timeout:15000});
 await page.getByText('Listening',{exact:true}).waitFor();
 await page.waitForTimeout(1500);assert.equal(questions.length,1,'Do not send an empty follow-up');
 await page.getByRole('button',{name:'Close walkthrough',exact:true}).click();
 // A late response must not reopen an explicitly closed island.
 let release;
 const pending=new Promise(resolve=>release=resolve);
 await page.unroute('**/api/visual-audit/chat');
 await page.route('**/api/visual-audit/chat',async route=>{await pending;await route.fulfill({json:{user:{id:'late-user',text:'More detail',snapshotIds:[]},assistant:{id:'late-answer',text:'Late answer must stay in chat.',snapshotIds:[]}}});});
 await page.getByRole('textbox',{name:'Ask Mangekyo',exact:true}).fill('More detail');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await page.getByRole('button',{name:'Close walkthrough',exact:true}).click();
 release();await page.waitForTimeout(600);
 assert.equal(requests.length,2,'No audio after close');
 assert.equal(await page.locator('.walkthrough-island.expanded').count(),0);
 console.log('Passed: spoken question -> answer TTS/captions -> automatic listening; close cancels late audio.');
} finally {await browser.close();}
