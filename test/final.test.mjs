import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {FinalBot} from '../final-core.mjs';
import {BotRouter} from '../router.mjs';
import {SavedStore} from '../saved-store.mjs';

async function fixture(t,{initial='lock-review',result='print-ready',deliveryFails=false,timeoutMs=1000,lockFails=false,portalError=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'telespark-final-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('telespark-final-'));await rm(root,{recursive:true,force:true});});
  const store=new SavedStore({directory:join(root,'records'),keyFile:join(root,'key')});await store.init();
  let incoming=1,outgoing=100,locks=0,pdfs=0,refreshes=0,closed=0,now=Date.now();const sent=[],events=[],types=[];
  const telegram={send:async(id,text,options)=>{sent.push({id,text,options});return {message_id:outgoing++};},photo:async(id,image,text)=>{sent.push({id,text,image});return {message_id:outgoing++};},document:async(id,bytes,name)=>{if(deliveryFails)throw Error('delivery');sent.push({id,bytes,name});}};
  const final=new FinalBot({telegram,store,canUse:id=>[42,99].includes(Number(id)),activity:{record:async e=>events.push(e)},defaultPassword:'Synthetic1@',clock:()=>now,timeoutMs,portalFactory:type=>{
    types.push(type);return {open:async()=>Buffer.from('captcha'),close:async()=>{closed++;},refreshLogin:async()=>{refreshes++;return Buffer.from('fresh');},login:async input=>{assert.ok(input.password);return {kind:initial,identity:'Registration 000012345678',token:'review'};},lock:async()=>{locks++;if(lockFails)await new Promise(()=>{});return {kind:result};},finalPdf:async()=>{pdfs++;return portalError?{kind:'print-error-pdf',bytes:Buffer.from('%PDF-synthetic-portal-error-fixture-only')}:{bytes:Buffer.from('%PDF-synthetic-final-fixture-only')};}};
  }});
  const dummy={clear:async()=>{},expire:async()=>{}};
  const router=new BotRouter({telegram,recovery:dummy,otr:dummy,final,enableFinal:true,allowedUserId:'42',access:{canUse:id=>[42,99].includes(Number(id))},clock:()=>now});
  const message=(text,id=42)=>({message_id:incoming++,chat:{id,type:'private'},from:{id},text});
  const say=(text,id=42)=>router.handle(message(text,id));
  const login=async(type='Fresh',id=42)=>{for(const answer of ['/start','5',type,'000012345678','UP26-0000000001','Use default password','AbC12'])await say(answer,id);};
  return {root,store,final,router,sent,events,types,message,say,login,counts:()=>({locks,pdfs,refreshes,closed}),advance:ms=>now+=ms,delivery:()=>{deliveryFails=false;}};
}
test('Option 5, Fresh/Renewal, explicit YES and duplicate protection; secrets absent from saved records',async t=>{
  const f=await fixture(t);await f.login('Renewal');assert.deepEqual(f.types,['Renewal']);assert.equal(f.counts().locks,0);
  assert.equal(f.final.sessions.get(42).credentials.password,undefined);
  await f.say('NO');assert.equal(f.counts().locks,0);
  const yes=f.message('YES');await Promise.all([f.router.handle(yes),f.router.handle(yes)]);
  assert.equal(f.counts().locks,1);assert.equal(f.counts().pdfs,1);assert.ok(f.sent.some(m=>m.name==='L0002-final-print.pdf'));
  const record=await f.store.get('L0001',42);assert.equal(record.status,'confirmed');assert.ok(!JSON.stringify(record).includes('Synthetic1@'));
  const raw=await readFile(join(f.root,'records','L0002.enc'),'utf8');assert.ok(!raw.includes('000012345678'));
  assert.ok(!JSON.stringify(f.events).includes('Synthetic1@'));await f.say('YES');assert.equal(f.counts().locks,1);
});

test('Requested error print is delivered and retained as incomplete, including owner-only retries',async t=>{
  const f=await fixture(t,{initial:'print-ready',portalError:true});await f.login();
  assert.match(f.sent.at(-1).text,/Incomplete portal printout/);
  assert.ok(f.sent.some(m=>m.name==='L0001-INCOMPLETE-portal-error.pdf'));
  const record=await f.store.get('L0001',42);assert.equal(record.result.incomplete,true);assert.equal(record.status,'uncertain');
  assert.equal(f.final.sessions.get(42).phase,'done');assert.equal(f.counts().locks,0);
  await f.say('YES');assert.equal(f.counts().pdfs,1);assert.equal(f.counts().locks,0);
  await f.say('/cancel');await f.say('/result L0001');assert.equal(f.sent.at(-1).name,'L0001-INCOMPLETE-portal-error.pdf');
  await f.say('/result L0001',99);assert.match(f.sent.at(-1).text,/unavailable/);
});
test('Error print delivery failure retries the same PDF without relocking or regeneration',async t=>{
  const f=await fixture(t,{initial:'print-ready',portalError:true,deliveryFails:true});await f.login();
  f.delivery();await f.say('/result');assert.equal(f.counts().pdfs,1);assert.equal(f.counts().locks,0);
  assert.ok(f.sent.some(m=>m.name==='L0001-INCOMPLETE-portal-error.pdf'));
});
test('Available final print skips locking; saved PDF owner isolation and delivery retry never relock',async t=>{
  const f=await fixture(t,{initial:'print-ready',deliveryFails:true});await f.login();assert.equal(f.counts().locks,0);
  f.delivery();await f.say('/result');assert.equal(f.counts().pdfs,1);
  await f.say('/cancel');await f.say('/result L0001');assert.ok(f.sent.at(-1).name);
  await f.say('/result L0001',99);assert.match(f.sent.at(-1).text,/unavailable/);assert.equal(f.counts().locks,0);
});
test('Waiting and unknown outcomes do not download or repeat lock; timeout is durable',async t=>{
  for(const result of ['waiting','unknown']) {
    const f=await fixture(t,{result});await f.login();await f.say('YES');await f.say('YES');
    assert.equal(f.counts().locks,1);assert.equal(f.counts().pdfs,0);
    assert.equal((await f.store.get('L0001',42)).status,result==='waiting'?'confirmed':'uncertain');
  }
  const f=await fixture(t,{lockFails:true,timeoutMs:15});await f.login();await f.say('YES');await f.say('YES');
  assert.equal(f.counts().locks,1);assert.equal((await f.store.get('L0001',42)).status,'attempted');
});
test('Other password, refresh, malformed identity, cancellation and timeout cleanup',async t=>{
  const f=await fixture(t);for(const a of ['/start','5','Fresh','bad'])await f.say(a);
  assert.equal(f.final.sessions.get(42).phase,'registration');
  for(const a of ['000012345678','UP26-0000000001','Other','Different1@','/refresh'])await f.say(a);
  assert.equal(f.counts().refreshes,1);await f.say('/cancel');assert.equal(f.final.sessions.size,0);assert.ok(f.counts().closed);
  await f.login();f.advance(21*60_000);await f.router.expire();assert.equal(f.final.sessions.size,0);
});
