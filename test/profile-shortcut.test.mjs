import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {SavedStore} from '../saved-store.mjs';
import {SavedSessions} from '../saved-sessions.mjs';
import {BotRouter} from '../router.mjs';
import {PolyBot} from '../poly-core.mjs';
import {FinalBot} from '../final-core.mjs';
import {RecoveryBot} from '../core.mjs';

async function fixture(t,{loginError=false,openFails=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'telespark-profile-shortcut-'));
  t.after(async()=>{
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));
    assert.ok(basename(root).startsWith('telespark-profile-shortcut-'));
    await rm(root,{recursive:true,force:true});
  });
  const store=new SavedStore({directory:join(root,'records'),keyFile:join(root,'key')});await store.init();
  const fields={registration:{value:'000012345678'},otr:{value:'UP26-0000000050'},password:{value:'SyntheticHidden@1'},profileSuffix:{value:'50'}};
  const record=await store.save({userId:99,module:'poly',fields,ready:false});
  let time=Date.now(),incoming=0,outgoing=100,allowed=true;
  const calls=[],sent=[],events=[];
  const access={canUse:id=>allowed&&[99,42].includes(Number(id)),isAdmin:id=>Number(id)===42};
  const telegram={
    send:async(id,text,options)=>{sent.push({id,text,options});return {message_id:++outgoing};},
    photo:async(id,bytes,text)=>{sent.push({id,text,bytes});return {message_id:++outgoing};},
    document:async()=>{},
  };
  const activity={record:async event=>events.push(event)};
  const portalFactory=(module)=>(type,route)=>({
    answers:new Map(),closed:false,
    open:async()=>{calls.push({method:'open',module,type,route});if(openFails)throw Error('network');return Buffer.from('synthetic-captcha');},
    close:async()=>{calls.push({method:'close',module});},
    login:async credentials=>{calls.push({method:'login',module,credentials});return loginError?{kind:'login-error'}:module==='poly'?{kind:'dashboard'}:{kind:'lock-review',identity:'Synthetic applicant',token:'synthetic'};},
    choose:async()=>({kind:'review',stage:'fee',review:['Synthetic fee'],token:'synthetic'}),
    lock:async()=>{calls.push({method:'lock'});return {kind:'waiting'};},
  });
  const saves=new SavedSessions({store,telegram,access,activity,clock:()=>time});
  const poly=new PolyBot({store,telegram,canUse:access.canUse,portalFactory:portalFactory('poly'),clock:()=>time});
  const final=new FinalBot({store,telegram,canUse:access.canUse,portalFactory:portalFactory('final'),clock:()=>time});
  const recovery=new RecoveryBot({telegram,canUse:access.canUse,clock:()=>time,portalFactory:()=>({open:async details=>{calls.push({method:'recovery-open',details:{...details}});return Buffer.from('synthetic');},close:async()=>{}})});
  const service=module=>({sessions:new Map(),clear:async()=>{},expire:async()=>{},start:async(id,input)=>{calls.push({module,method:'start',input});}});
  const otr=service('otr'),registration=service('registration'),batch=service('final-batch');
  const router=new BotRouter({telegram,access,activity,saves,poly,final,recovery,otr,registration,batch,enablePoly:true,enableOtr:true,enableFinal:true,clock:()=>time});
  const message=(text,id=99)=>({text,from:{id},chat:{id,type:'private'},message_id:++incoming});
  const say=(text,id)=>router.handle(message(text,id));
  return {router,saves,store,poly,final,recovery,fields,record,calls,sent,events,message,say,advance:ms=>time+=ms,revoke:()=>{allowed=false;}};
}

test('Profile at start retains all five options and fills Poly login with no USE SAVED confirmations',async t=>{
  const f=await fixture(t);await f.say('/saveuser50');
  assert.equal(f.router.sessions.get(99).module,'menu');
  assert.equal(f.sent.at(-1).options.reply_markup.keyboard.length,5);
  for(const text of ['3','1','Fresh','OBC'])await f.say(text);
  assert.equal(f.poly.sessions.get(99).phase,'login-captcha');
  assert.deepEqual(f.poly.sessions.get(99).credentials,{registration:f.fields.registration.value,otr:f.fields.otr.value,password:f.fields.password.value});
  assert.equal(f.calls.filter(c=>c.method==='open').length,1);
  assert.equal(f.calls.filter(c=>c.method==='login').length,0);
  assert.doesNotMatch(JSON.stringify(f.sent)+JSON.stringify(f.events),/SyntheticHidden@1|USE SAVED/);
  await f.say('AbC12');
  assert.equal(f.poly.sessions.get(99).phase,'confirm');
  assert.equal(f.poly.sessions.get(99).reuse.password,undefined);
  assert.match(f.sent.at(-1).text,/YES/);
});

test('Shortcut during Poly login preserves action, Fresh/Renewal and OBC and goes straight to CAPTCHA',async t=>{
  const f=await fixture(t);
  for(const text of ['/start','3','2','Renewal','OBC'])await f.say(text);
  const command=f.message('/saveuser50');
  await Promise.all([f.router.handle(command),f.router.handle(command)]);
  assert.equal(f.poly.sessions.get(99).phase,'login-captcha');
  assert.equal(f.poly.sessions.get(99).operation,'certificates');
  assert.deepEqual(f.calls.find(c=>c.method==='open'),{method:'open',module:'poly',type:'Renewal',route:'obc'});
  assert.equal(f.calls.filter(c=>c.method==='open').length,1);
  await f.say('/back');assert.equal(f.poly.sessions.get(99).phase,'login');assert.equal(f.poly.sessions.get(99).index,2);
  assert.equal(f.poly.sessions.get(99).credentials.password,undefined);
});

test('Final Print reuses selected profile, asks type once, and still requires explicit lock YES',async t=>{
  const f=await fixture(t);
  for(const text of ['/saveuser50','5','Fresh'])await f.say(text);
  assert.equal(f.final.sessions.get(99).phase,'captcha');
  assert.equal(f.calls.filter(c=>c.method==='lock').length,0);
  await f.say('AbC12');
  assert.equal(f.final.sessions.get(99).phase,'confirm');
  assert.equal(f.final.sessions.get(99).reuse.password,undefined);
  assert.equal(f.calls.filter(c=>c.method==='lock').length,0);
  await f.say('YES');assert.equal(f.calls.filter(c=>c.method==='lock').length,1);
});

test('Final Print shortcut preserves already selected Renewal type',async t=>{
  const f=await fixture(t);
  for(const text of ['/start','5','Renewal','/saveuser50'])await f.say(text);
  assert.equal(f.final.sessions.get(99).phase,'captcha');
  assert.equal(f.calls.find(c=>c.method==='open').type,'Renewal');
});

test('Password recovery reuses registration but still asks missing mobile and school details',async t=>{
  const f=await fixture(t);
  for(const text of ['/saveuser50','1','Fresh'])await f.say(text);
  assert.equal(f.recovery.sessions.get(99).details.registration,f.fields.registration.value);
  assert.equal(f.recovery.sessions.get(99).index,2);
  assert.match(f.sent.at(-1).text,/mobile/);
  for(const text of ['9000000000','UP BOARD','2024','00012345'])await f.say(text);
  assert.equal(f.recovery.sessions.get(99).phase,'captcha');
  assert.equal(f.calls.filter(c=>c.method==='recovery-open').length,1);
});

test('OTR registration gets only the saved OTR; OTR recovery asks mobile; saved dashboard stays available',async t=>{
  const f=await fixture(t);
  for(const text of ['/saveuser50','2','2'])await f.say(text);
  assert.deepEqual(f.calls.find(c=>c.module==='registration').input,{'ContentPlaceHolder1_TextBox3':f.fields.otr});
  for(const text of ['/menu','2','1'])await f.say(text);
  assert.equal(f.calls.find(c=>c.module==='otr').input,'recover');
  assert.ok(f.sent.some(s=>s.text.includes('does not store')));
  await f.say('/menu');await f.say('4');
  assert.ok(f.sent.some(s=>s.text.includes('Saved sessions —')));
  assert.equal(f.calls.filter(c=>c.method==='open').length,0);
});

test('Owner isolation, revocation, cancellation and inactivity clear selected profile',async t=>{
  const f=await fixture(t);
  await f.say('/saveuser50',42);assert.equal(f.saves.selectedProfiles.has(42),false);
  await f.say('/saveuser50');await f.say('/cancel');assert.equal(f.saves.selectedProfiles.has(99),false);
  await f.say('/saveuser50');f.advance(21*60_000);await f.router.expire();assert.equal(f.saves.selectedProfiles.has(99),false);
  await f.say('/saveuser50');f.revoke();await f.router.expire();assert.equal(f.saves.selectedProfiles.has(99),false);
  assert.doesNotMatch(JSON.stringify(f.sent)+JSON.stringify(f.events),/SyntheticHidden@1/);
});

test('Active batch cannot be replaced; missing profile does not clear current form',async t=>{
  const f=await fixture(t);
  f.router.sessions.set(99,{module:'final-batch',updated:Date.now()});
  await f.say('/saveuser50');assert.equal(f.router.sessions.get(99).module,'final-batch');
  assert.equal(f.saves.selectedProfiles.size,0);
  await f.say('/menu');await f.say('3');await f.say('/saveuser51');
  assert.equal(f.router.sessions.get(99).module,'poly');
});

test('Rejected saved password asks correction without an automatic login loop',async t=>{
  const f=await fixture(t,{loginError:true});
  for(const text of ['/saveuser50','3','1','Fresh','OBC','AbC12'])await f.say(text);
  assert.equal(f.poly.sessions.get(99).phase,'login');
  assert.equal(f.poly.sessions.get(99).index,2);
  assert.equal(f.poly.sessions.get(99).reuse.password,undefined);
  assert.equal(f.calls.filter(c=>c.method==='login').length,1);
  for(const text of ['/menu','5','Fresh','AbC12'])await f.say(text);
  assert.equal(f.final.sessions.get(99).phase,'password-choice');
  assert.equal(f.calls.filter(c=>c.method==='login').length,2);
});

test('Failed CAPTCHA preparation closes session without leaking saved credentials',async t=>{
  const f=await fixture(t,{openFails:true});
  for(const text of ['/saveuser50','3','1','Fresh','OBC'])await f.say(text);
  assert.equal(f.poly.sessions.get(99).phase,'blocked');
  assert.equal(f.poly.sessions.get(99).credentials.password,undefined);
  assert.equal(f.poly.sessions.get(99).reuse.password,undefined);
  assert.doesNotMatch(JSON.stringify(f.sent),/SyntheticHidden@1/);
  assert.equal(f.calls.filter(c=>c.method==='login').length,0);
});
