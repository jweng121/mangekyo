import assert from 'node:assert/strict';
import {chromium} from 'playwright';

// Run against the local app with an active ERP escalation. All voice services are stubbed.
const base=process.env.MANGEKYO_APP_URL||'http://localhost:3000';
const workspace=await(await fetch(base+'/api/workspace')).json();
assert(workspace.simulation?.escalationRunId,'Create the ERP simulation escalation first');
const browser=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
try {
 for(const suspended of [false,true]){
  const page=await browser.newPage();let uploads=0;
  await page.addInitScript(({suspended})=>{
   const NativeContext=window.AudioContext;
   window.micOpens=0;
   navigator.mediaDevices.getUserMedia=async()=>{
    window.micOpens++;
    const ctx=new NativeContext();await ctx.resume();
    const tone=ctx.createOscillator(),gain=ctx.createGain(),destination=ctx.createMediaStreamDestination();
    gain.gain.value=.03;tone.connect(gain);gain.connect(destination);tone.start();
    setTimeout(()=>{gain.gain.value=0;},650);
    destination.stream.getTracks()[0].addEventListener('ended',()=>void ctx.close());
    return destination.stream;
   };
   if(suspended){
    window.AudioContext=class extends NativeContext {
     held=true; release=null;
     get state(){return this.held?'suspended':super.state;}
     resume(){if(this.release){this.held=false;this.release();return super.resume();}return new Promise(resolve=>{this.release=resolve;});}
    };
   }
   window.speechSynthesis.speak=u=>{setTimeout(()=>{u.onstart?.();u.onend?.();},20);};
   window.speechSynthesis.cancel=()=>{};
  },{suspended});
  await page.route('**/api/visual-audit/tts',r=>r.fulfill({json:{provider:'browser',configured:true}}));
  await page.route('**/api/visual-audit/transcribe',r=>{
   if(r.request().method()==='GET')return r.fulfill({json:{configured:true}});
   uploads++;return r.fulfill({status:422,json:{error:'No speech was detected. Please try speaking again.'}});
  });
  await page.goto(base+'/escalations/'+workspace.simulation.escalationRunId);
  await page.getByRole('button',{name:'Start walkthrough',exact:true}).click();
  if(suspended){
   await page.getByText('Opening microphone',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Reply by voice',exact:true}).click();
   await page.getByText('Listening',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>window.micOpens),1,'unlock must reuse the pending microphone');
   console.log('PASS a microphone click unlocks suspended audio');
  }else{
   await page.getByRole('button',{name:'Retry recording',exact:true}).waitFor();
   assert.equal(uploads,1);
   await page.getByRole('button',{name:'Retry recording',exact:true}).click();
   await page.waitForFunction(()=>window.micOpens===2);
   assert.equal(uploads,1,'must record again instead of immediately resending the rejected clip');
   console.log('PASS no-speech retry creates a new recording');
  }
  await page.getByRole('button',{name:'Close walkthrough',exact:true}).click();
  await page.close();
 }
}finally{await browser.close();}
