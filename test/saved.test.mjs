import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {SavedStore} from '../saved-store.mjs';
import {SavedSessions} from '../saved-sessions.mjs';
import {RecoveryBot} from '../core.mjs';
import {OtrBot} from '../otr-core.mjs';
import {RegistrationBot} from '../registration-core.mjs';
import {BotRouter} from '../router.mjs';
import {AccessStore} from '../access.mjs';

const fields={applicationType:{value:'Fresh'},registration:{value:'000012345678'},mobile:{value:'9876543210'},board:{value:'CBSE'},year:{value:'2021'},roll:{value:'000012345'}};
async function storage(t) {
  const root=await mkdtemp(join(tmpdir(),'telespark-saved-test-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('telespark-saved-test-'));await rm(root,{recursive:true,force:true});});
  const options={directory:join(root,'records'),keyFile:join(root,'private','key')};
  const store=new SavedStore(options);await store.init();return {root,store,options};
}

test('Encrypted records/results survive restart and exclude verification fields; users cannot read each other',async t=>{
  const f=await storage(t);
  const record=await f.store.save({userId:99,module:'password',fields:{...fields,otp:{value:'DO_NOT_SAVE'},captcha:{value:'NOT_SAVED'},cookies:{value:'NEVER'}},ready:true});
  await f.store.begin(record.id,99,fields);
  await f.store.outcome(record.id,99,{status:'confirmed',result:{kind:'success',registration:'000012345678',password:'Private1@',image:Buffer.from('PRIVATE_IMAGE').toString('base64'),otp:'DO_NOT_SAVE'}});
  const raw=await readFile(join(f.options.directory,record.id+'.enc'),'utf8');
  for(const secret of ['Private1@','9876543210','000012345678','PRIVATE_IMAGE','DO_NOT_SAVE']) assert.ok(!raw.includes(secret));
  const restarted=new SavedStore(f.options);await restarted.init();const loaded=await restarted.get(record.id,99);
  assert.equal(loaded.status,'confirmed');assert.equal(loaded.result.password,'Private1@');assert.equal(loaded.fields.roll.value,'000012345');
  assert.doesNotMatch(JSON.stringify(loaded),/DO_NOT_SAVE|NOT_SAVED|NEVER/);
  await assert.rejects(restarted.get(record.id,42));await assert.rejects(restarted.get('../key',99));
  const metadata=await restarted.list();assert.doesNotMatch(JSON.stringify(metadata),/Private1|9876543210|000012345678/);
});

test('Missing/wrong keys and tampered ciphertext fail closed without replacing a key',async t=>{
  const f=await storage(t),record=await f.store.save({userId:99,module:'password',fields,ready:true});
  const key=await readFile(f.options.keyFile);
  await rm(f.options.keyFile);await assert.rejects(new SavedStore(f.options).init(),/key is missing/);
  await writeFile(f.options.keyFile,Buffer.alloc(32,4));await assert.rejects(new SavedStore(f.options).init(),/unavailable/);
  await writeFile(f.options.keyFile,key);
  const path=join(f.options.directory,record.id+'.enc');const envelope=JSON.parse(await readFile(path,'utf8'));
  envelope.ciphertext=(envelope.ciphertext[0]==='A'?'B':'A')+envelope.ciphertext.slice(1);await writeFile(path,JSON.stringify(envelope));
  await assert.rejects(new SavedStore(f.options).init(),/unavailable/);
  assert.deepEqual(await readFile(f.options.keyFile),key);
});

test('A durable submission marker prevents duplicates, stale saves and replay after restart',async t=>{
  const f=await storage(t),record=await f.store.save({userId:99,module:'password',fields,ready:true});
  await assert.rejects(f.store.begin(record.id,99,{...fields,year:{value:'2020'}}));
  const results=await Promise.allSettled([f.store.begin(record.id,99,fields),f.store.begin(record.id,99,fields)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const restarted=new SavedStore(f.options);await restarted.init();assert.equal((await restarted.get(record.id,99)).status,'attempted');
  await assert.rejects(restarted.begin(record.id,99,fields));
  await assert.rejects(restarted.save({id:record.id,userId:99,module:'password',fields,ready:true}));
  await restarted.outcome(record.id,99,{status:'uncertain',result:{kind:'unknown'}});
  await assert.rejects(restarted.begin(record.id,99,fields));
});

test('Drafts require a completed save; failed durable writes never authorize submission',async t=>{
  const f=await storage(t),record=await f.store.save({userId:99,module:'password',fields:{registration:fields.registration}});
  assert.equal(record.status,'draft');await assert.rejects(f.store.begin(record.id,99,record.fields));
  await f.store.save({id:record.id,userId:99,module:'password',fields,ready:true});
  const original=f.store.write;f.store.write=async()=>{throw new Error('disk failure');};
  await assert.rejects(f.store.begin(record.id,99,fields));
  f.store.write=original;assert.equal((await f.store.get(record.id,99)).status,'ready');
});

async function chat(t,{storageFixture,submit}={}) {
  const f=storageFixture || await storage(t);let now=Date.now(),incoming=1,outgoing=100,submits=0,opens=0;
  const sent=[],activity=[];
  const telegram={send:async(id,text,opts)=>{sent.push({id,text,opts});return {message_id:outgoing++};},photo:async(id,image,text)=>{sent.push({id,image,text});return {message_id:outgoing++};},document:async(id,image,name,text)=>{sent.push({id,image,name,text});}};
  const access=new AccessStore({adminId:42,path:join(f.root,'users.json')});await access.load();await access.change(42,99,true);
  const saves=new SavedSessions({store:f.store,telegram,access,activity:{record:async event=>activity.push(event)},clock:()=>now});
  const recovery=new RecoveryBot({telegram,saves,canUse:id=>access.canUse(id),clock:()=>now,portalFactory:()=>({open:async()=>{opens++;return Buffer.from('CAPTCHA');},close:async()=>{},submit:async()=>{submits++;return submit?submit(f.store,recovery.sessions.get(99)): {kind:'success',registration:'000012345678',password:'Private1@',slip:Buffer.from('SLIP')};}})});
  const otr=new OtrBot({telegram,canUse:id=>access.canUse(id),portalFactory:()=>{throw Error('No OTR call expected');}});
  const registration=new RegistrationBot({telegram,saves,canUse:id=>access.canUse(id),portalFactory:()=>{throw Error('No registration call expected');}});
  const router=new BotRouter({telegram,recovery,otr,registration,access,saves,enableOtr:true,clock:()=>now});
  const message=(text,id=99,extra={})=>({from:{id},chat:{id,type:'private'},message_id:incoming++,text,...extra});
  return {...f,telegram,saves,recovery,registration,router,sent,activity,access,message,say:(text,id,extra)=>router.handle(message(text,id,extra)),counts:()=>({submits,opens}),advance:ms=>{now+=ms;}};
}
async function six(f) {for(const value of ['/start','1','Fresh','000012345678','9876543210','CBSE BOARD','2021','000012345']) await f.say(value);}

test('Password flow requires /save then /psave; retrieval and restart never submit again',async t=>{
  const f=await chat(t,{submit:async(store,state)=>{assert.equal((await store.get(state.savedId,99)).status,'attempted');return {kind:'success',password:'Private1@',registration:'000012345678',slip:Buffer.from('SLIP')};}});
  await six(f);assert.deepEqual(f.counts(),{opens:0,submits:0});
  await f.say('AbC12');await f.say('/psave');assert.match(f.sent.at(-1).text,/Open \/save first/);
  await f.say('/save');await f.say('/psave');const id=f.recovery.sessions.get(99).savedId;
  assert.equal(f.recovery.sessions.get(99).phase,'captcha');
  const message=f.message('AbC12');await Promise.all([f.router.handle(message),f.router.handle(message)]);
  assert.equal(f.counts().submits,1);assert.equal((await f.store.get(id,99)).status,'confirmed');
  await f.say('/cancel');await f.say(`/psave ${id}`);assert.ok(f.sent.some(m=>m.text?.includes('Latest recovered password: Private1@')));assert.equal(f.counts().submits,1);
  const loaded=new SavedStore(f.options);await loaded.init();const restarted=await chat(t,{storageFixture:{...f,store:loaded}});
  await restarted.say(`/psave ${id}`);assert.deepEqual(restarted.counts(),{opens:0,submits:0});assert.ok(restarted.sent.some(m=>m.image?.toString()==='SLIP'));
  assert.doesNotMatch(JSON.stringify(f.activity),/Private1|9876543210|AbC12/);
});

test('Reuse makes a new record with fresh CAPTCHA; expiry preserves encrypted history and no automatic retry',async t=>{
  const f=await chat(t,{submit:async()=>({kind:'unknown'})});await six(f);await f.say('/save');await f.say('/psave');
  const oldId=f.recovery.sessions.get(99).savedId;await f.say('AbC12');assert.equal((await f.store.get(oldId,99)).status,'uncertain');
  await f.say(`/reuse ${oldId}`);assert.equal(f.recovery.sessions.get(99).phase,'save-required');assert.equal(f.counts().submits,1);
  await f.say('/psave');assert.match(f.sent.at(-1).text,/Open \/save first/);
  await f.say('/save');await f.say('/psave');const newId=f.recovery.sessions.get(99).savedId;assert.notEqual(newId,oldId);assert.equal(f.counts().opens,2);
  f.advance(21*60_000);await f.router.expire();assert.equal(f.recovery.sessions.size,0);
  assert.equal((await f.store.get(newId,99)).status,'ready');assert.equal((await f.store.get(oldId,99)).status,'uncertain');
});

test('Admin sees all statuses but only the owner can retrieve or reuse saved details; revoked users are blocked',async t=>{
  const f=await chat(t);await six(f);await f.say('/save');await f.say('/psave');const id=f.recovery.sessions.get(99).savedId;
  let before=f.sent.length;await f.say('/save',42);const adminOutput=f.sent.slice(before).map(m=>m.text).join('\n');assert.match(adminOutput,/User 99/);assert.doesNotMatch(adminOutput,/9876543210|000012345678/);
  before=f.sent.length;await f.say(`/psave ${id}`,42);await f.say(`/reuse ${id}`,42);
  assert.ok(f.sent.slice(before).every(m=>!m.text.includes('9876543210')));assert.equal(f.recovery.sessions.has(42),false);
  await f.say('/removeuser 99',42);await f.say(`/psave ${id}`);assert.match(f.sent.at(-1).text,/restricted/);
  const count=f.sent.length;await f.say(`/psave ${id}`,99,{chat:{id:-1,type:'group'}});assert.equal(f.sent.length,count);
});

test('Failure to save or mark an attempt prevents portal submission; outcome saving can retry without a second POST',async t=>{
  const f=await chat(t);await six(f);await f.say('/save');
  const original=f.store.write;f.store.write=async()=>{throw Error('PRIVATE storage error');};await f.say('/psave');assert.equal(f.counts().opens,0);
  f.store.write=original;await f.say('/psave');
  f.store.write=async()=>{throw Error('PRIVATE storage error');};await f.say('AbC12');assert.equal(f.counts().submits,0);
  f.store.write=original;
  const outcome=f.store.outcome;f.store.outcome=async()=>{throw Error('PRIVATE outcome error');};await f.say('AbC12');
  assert.equal(f.counts().submits,1);const state=f.recovery.sessions.get(99);assert.ok(state.savedOutcomePending);
  f.store.outcome=outcome;await f.say('/psave');assert.equal((await f.store.get(state.savedId,99)).status,'confirmed');assert.equal(f.counts().submits,1);
  assert.ok(f.sent.every(m=>!m.text.includes('PRIVATE storage') && !m.text.includes('PRIVATE outcome')));
});

test('Portal correction requires re-saving changed fields; invalid CAPTCHA and expired CAPTCHA never replay automatically',async t=>{
  let attempt=0;
  const f=await chat(t,{submit:async()=>++attempt===1?{kind:'correction',field:'year',message:'Correct the year'}:{kind:'captcha',message:'Wrong CAPTCHA'}});
  await six(f);await f.say('/save');await f.say('/psave');const id=f.recovery.sessions.get(99).savedId;await f.say('AbC12');
  assert.equal((await f.store.get(id,99)).status,'draft');await f.say('2020');assert.equal(f.recovery.sessions.get(99).phase,'save-required');
  await f.say('/psave');assert.equal((await f.store.get(id,99)).fields.year.value,'2020');
  f.advance(6*60_000);await f.say('AbC12');assert.equal(f.counts().submits,1);
  await f.say('AbC12');assert.equal(f.counts().submits,2);assert.equal((await f.store.get(id,99)).status,'ready');
});
