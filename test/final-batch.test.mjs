import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {FinalBatch,batchReport} from '../final-batch.mjs';
import {FinalBot} from '../final-core.mjs';
import {BotRouter} from '../router.mjs';
import {SavedStore} from '../saved-store.mjs';

const candidates=n=>Array.from({length:n},(_,i)=>({row:i+2,registration:String(i+1).padStart(12,'0'),otr:'UP26-0000000001',applicationType:i%2?'Renewal':'Fresh',status:'pending'}));
async function fixture(t,{rows=candidates(2),steps=['print-ready','print-ready'],deliveryFails=false,openFails=false,timeoutMs=1000,hang=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'telespark-batch-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('telespark-batch-'));await rm(root,{recursive:true,force:true});});
  const store=new SavedStore({directory:join(root,'records'),keyFile:join(root,'key')});await store.init();
  let incoming=1,outgoing=100,now=Date.now(),admin=true,downloads=0,prints=0,locks=0,refreshes=0,active=0,maxActive=0;
  const sent=[],events=[],inputs=[],types=[],portals=[];
  const telegram={send:async(id,text,options)=>{sent.push({id,text,options});return {message_id:outgoing++};},photo:async(id,bytes,text,options)=>{sent.push({id,text,options});return {message_id:outgoing++};},document:async(id,bytes,name,caption)=>{if(deliveryFails&&name.endsWith('.pdf'))throw Error('delivery');sent.push({id,bytes,name,caption});},download:async()=>{downloads++;return Buffer.from('workbook');}};
  const access={canUse:id=>[42,99].includes(Number(id))&&(Number(id)!==42||admin),isAdmin:id=>Number(id)===42&&admin};
  const final=new FinalBot({telegram,store,canUse:access.canUse});
  const batch=new FinalBatch({telegram,isAdmin:access.isAdmin,deliver:(id,s)=>final.deliver(id,s),presets:{'Gpm preset':'SyntheticGpm@1','Deepak preset':'SyntheticDeepak@1'},parse:async()=>structuredClone(rows),clock:()=>now,timeoutMs,activity:{record:async e=>events.push(e)},portalFactory:type=>{
    types.push(type);let closed=false;
    const portal={open:async()=>{active++;maxActive=Math.max(maxActive,active);if(hang)await new Promise(()=>{});if(openFails)throw Error('network');return Buffer.from('captcha');},close:async()=>{if(!closed){closed=true;active--;}},refreshLogin:async()=>{refreshes++;return Buffer.from('refreshed');},login:async input=>{inputs.push(input);return {kind:steps.shift()||'print-ready',notice:'Portal waiting status'};},finalPdf:async()=>{prints++;return {kind:rows[0]?.incomplete?'print-error-pdf':'pdf',bytes:Buffer.from('%PDF-synthetic-fixture')};},lock:async()=>{locks++;throw Error('Batch must never lock');}};
    portals.push(portal);return portal;
  }});
  const dummy={clear:async()=>{},expire:async()=>{}};
  const router=new BotRouter({telegram,recovery:dummy,otr:dummy,final,batch,access,enableFinal:true,clock:()=>now});
  const message=(text,id=42,extra={})=>({message_id:incoming++,chat:{id,type:'private'},from:{id},text,...extra});
  const say=(text,id=42,extra)=>router.handle(message(text,id,extra));
  const upload=()=>router.handle(message(undefined,42,{document:{file_id:'file',file_name:'batch.xlsx',file_size:123}}));
  const begin=async(preset='Gpm preset')=>{await say('/finalbatch');await upload();await say('YES');await say(preset);};
  const captcha=()=>say('AbC12',42,{reply_to_message:{message_id:batch.sessions.get(42).promptId}});
  return {root,store,batch,final,router,sent,events,inputs,types,portals,message,say,upload,begin,captcha,counts:()=>({downloads,prints,locks,refreshes,active,maxActive}),advance:ms=>now+=ms,restoreDelivery:()=>deliveryFails=false,restoreOpen:()=>{openFails=false;hang=false;},revoke:()=>admin=false};
}
test('Sequential Fresh/Renewal batch sends PDFs and CSV, stores encrypted owner-only results, never locks',async t=>{
  const f=await fixture(t);await f.begin();await f.captcha();assert.equal(f.batch.sessions.get(42).phase,'captcha');await f.captcha();
  assert.equal(f.batch.sessions.get(42).phase,'done');assert.deepEqual(f.types,['Fresh','Renewal']);assert.equal(f.counts().maxActive,1);assert.equal(f.counts().active,0);assert.equal(f.counts().locks,0);
  assert.ok(f.sent.some(m=>m.name==='L0001-final-print.pdf'));assert.ok(f.sent.some(m=>m.name==='L0002-final-print.pdf'));
  const csv=f.sent.find(m=>m.name?.endsWith('.csv')).bytes.toString();assert.match(csv,/000000000001/);assert.match(csv,/L0002/);
  assert.equal(f.batch.sessions.get(42).password,undefined);assert.equal(f.batch.sessions.get(42).rows[0].otr,undefined);
  const record=await f.store.get('L0001',42);assert.ok(!JSON.stringify(record).includes('SyntheticGpm'));
  assert.ok(!(await readFile(join(f.root,'records','L0001.enc'),'utf8')).includes('000000000001'));
  await f.say('/result L0001',99);assert.match(f.sent.at(-1).text,/unavailable/);
  await f.say('/result L0001');assert.equal(f.sent.at(-1).name,'L0001-final-print.pdf');assert.equal(f.counts().prints,2);
  assert.ok(!JSON.stringify(f.events).includes('000000000001'));assert.ok(!JSON.stringify(f.events).includes('Synthetic'));
});
test('Unlocked, waiting and unsupported candidates are reported and skipped without lock or PDF',async t=>{
  const f=await fixture(t,{rows:candidates(4),steps:['lock-review','dialog-review','waiting','unsupported']});await f.begin();for(let i=0;i<4;i++)await f.captcha();
  assert.equal(f.counts().locks,0);assert.equal(f.counts().prints,0);assert.ok(f.sent.some(m=>/Not locked/.test(m.text||'')));assert.ok(f.sent.some(m=>/Portal waiting status/.test(m.text||'')));assert.equal(f.batch.sessions.get(42).phase,'done');
});
test('Password presets, per-row correction and fresh CAPTCHA retries do not change batch default',async t=>{
  const f=await fixture(t,{steps:['login-error','login-error','print-ready','print-ready']});await f.begin('Deepak preset');await f.say('/refresh');await f.captcha();
  assert.equal(f.batch.sessions.get(42).phase,'password-choice');await f.say('/retry');await f.captcha();await f.say('Other');await f.say('Correction@1');await f.captcha();await f.captcha();
  assert.deepEqual(f.inputs.map(i=>i.password),['SyntheticDeepak@1','SyntheticDeepak@1','Correction@1','SyntheticDeepak@1']);assert.equal(f.counts().refreshes,1);assert.equal(f.counts().locks,0);
});
test('Other batch password, duplicate updates/uploads and stale CAPTCHA replies',async t=>{
  const f=await fixture(t);await f.say('/finalbatch');const doc=f.message(undefined,42,{document:{file_id:'f',file_name:'x.xlsx',file_size:10}});
  await Promise.all([f.router.handle(doc),f.router.handle(doc)]);await f.upload();assert.equal(f.counts().downloads,1);
  await f.say('YES');await f.say('Other');await f.say('Other@1');const prompt=f.batch.sessions.get(42).promptId;
  const answer=f.message('AbC12',42,{reply_to_message:{message_id:prompt}});await Promise.all([f.router.handle(answer),f.router.handle(answer)]);assert.equal(f.counts().prints,1);
  await f.say('AbC12',42,{reply_to_message:{message_id:prompt}});assert.equal(f.counts().prints,1);assert.match(f.sent.at(-1).text,/latest CAPTCHA/);
  await f.captcha();assert.deepEqual(f.inputs.map(i=>i.password),['Other@1','Other@1']);
});
test('Saved incomplete PDF retry does not repeat login or print, and retrieval stays labelled',async t=>{
  const rows=candidates(1);rows[0].incomplete=true;const f=await fixture(t,{rows,deliveryFails:true});await f.begin();await f.captcha();
  assert.equal(f.batch.sessions.get(42).phase,'delivery');assert.equal(f.batch.sessions.get(42).rows[0].pdfId,'L0001');f.restoreDelivery();await f.say('/retry');
  assert.equal(f.counts().prints,1);assert.equal(f.inputs.length,1);assert.equal(f.counts().locks,0);await f.say('/cancel');await f.say('/result L0001');
  assert.match(f.sent.at(-1).name,/INCOMPLETE/);assert.match(f.sent.at(-1).caption,/not a valid/);
});
test('Network Retry/Skip, skip after failed PDF delivery retains the saved session ID',async t=>{
  const f=await fixture(t,{openFails:true,deliveryFails:true});await f.begin();assert.equal(f.batch.sessions.get(42).phase,'retry');f.restoreOpen();await f.say('/retry');await f.captcha();
  await f.say('/skip');assert.equal(f.batch.sessions.get(42).rows[0].pdfId,'L0001');assert.equal(f.batch.sessions.get(42).phase,'captcha');f.restoreDelivery();await f.captcha();
  assert.equal(f.counts().locks,0);assert.equal(f.batch.sessions.get(42).phase,'done');
});
test('Access denial, menu/cancel, 20-minute expiry, revocation and portal timeout close sessions',async t=>{
  const f=await fixture(t);await f.say('/finalbatch',99);assert.equal(f.batch.sessions.size,0);
  await f.router.handle(f.message(undefined,99,{document:{file_id:'f',file_name:'x.xlsx',file_size:10}}));assert.equal(f.counts().downloads,0);
  await f.router.handle(f.message('/finalbatch',42,{chat:{id:42,type:'group'}}));assert.equal(f.batch.sessions.size,0);
  await f.begin();const state=f.batch.sessions.get(42);await f.say('/menu');assert.equal(f.batch.sessions.size,0);assert.equal(state.password,undefined);assert.equal(state.rows.length,0);assert.equal(f.counts().active,0);
  await f.begin();f.advance(19*60_000);await f.say('/batchstatus');f.advance(2*60_000);await f.router.expire();assert.equal(f.batch.sessions.size,1);
  f.advance(21*60_000);await f.router.expire();assert.equal(f.batch.sessions.size,0);
  await f.begin();f.revoke();await f.router.expire();assert.equal(f.batch.sessions.size,0);assert.equal(f.counts().active,0);
  const g=await fixture(t,{hang:true,timeoutMs:10});await g.begin();assert.equal(g.batch.sessions.get(42).phase,'retry');assert.equal(g.counts().active,0);await g.say('/cancel');assert.equal(g.batch.sessions.size,0);
});
test('Batch method allowlist rejects lock, CSV escapes cells',async t=>{
  const f=await fixture(t);await f.begin();await assert.rejects(f.batch.call(42,f.batch.sessions.get(42),'lock'));assert.equal(f.counts().locks,0);await f.say('/cancel');
  assert.match(batchReport([{row:2,registration:'=bad',status:'test'}]).toString(),/'=bad/);
});
test('Option 5 exposes Excel batch only to admin; template is delivered and invalid upload cannot open portal',async t=>{
  const f=await fixture(t);await f.say('/start');await f.say('5');assert.ok(f.sent.at(-1).options.reply_markup.keyboard.flat().includes('Excel batch'));
  await f.say('Excel batch');await f.say('/finaltemplate');assert.equal(f.sent.at(-1).name,'Final_Print_Batch_Template.xlsx');
  await f.router.handle(f.message(undefined,42,{document:{file_id:'f',file_name:'x.xlsx',file_size:3*1024*1024}}));assert.equal(f.counts().downloads,0);assert.equal(f.portals.length,0);
  f.batch.parse=async()=>{throw Error('invalid workbook');};await f.upload();assert.equal(f.batch.sessions.get(42).phase,'upload');assert.equal(f.portals.length,0);
  await f.say('/start',99);await f.say('5',99);assert.ok(!f.sent.at(-1).options.reply_markup.keyboard.flat().includes('Excel batch'));await f.say('/cancel');
});
test('Cancellation during upload discards its late result without opening a browser',async t=>{
  const f=await fixture(t);await f.say('/finalbatch');let complete;
  f.batch.parse=()=>new Promise(resolve=>{complete=resolve;});
  const uploading=f.batch.upload(f.message(undefined,42,{document:{file_id:'f',file_name:'x.xlsx',file_size:10}}));
  while(!complete)await new Promise(resolve=>setTimeout(resolve,1));
  await f.batch.clear(42);complete(candidates(1));await uploading;assert.equal(f.batch.sessions.size,0);assert.equal(f.portals.length,0);
});
