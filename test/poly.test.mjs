import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {PolyBot} from '../poly-core.mjs';
import {SavedStore} from '../saved-store.mjs';
import {SavedSessions} from '../saved-sessions.mjs';
import {BotRouter} from '../router.mjs';
import {POLY_SECTIONS,normalizePoly,percentage} from '../poly-schema.mjs';
import {projectFields} from '../saved-schema.mjs';
import {safeActivity} from '../activity.mjs';

async function fixture(t,{result={kind:'complete',stage:'form'},enabled=true,timeoutMs=1000,pdfFails=false,chooseStep}={}) {
  const root=await mkdtemp(join(tmpdir(),'telespark-poly-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('telespark-poly-'));await rm(root,{recursive:true,force:true});});
  const store=new SavedStore({directory:join(root,'records'),keyFile:join(root,'key')});await store.init();
  let now=Date.now(),incoming=1,outgoing=100,submits=0,opens=0,logins=0,documents=0,closed=0,failDelivery=false,pdfRequests=0;
  const sent=[],events=[],access={canUse:id=>[42,99].includes(Number(id)),isAdmin:id=>Number(id)===42};
  const telegram={send:async(id,text,options)=>{sent.push({id,text,options});return {message_id:outgoing++};},photo:async(id,bytes,text)=>{sent.push({id,bytes,text});return {message_id:outgoing++};},document:async(id,bytes,name)=>{documents++;if(failDelivery) throw Error('delivery failed');sent.push({id,bytes,name});}};
  let step={kind:'review',stage:'fee',review:['Fee: 11010'],declaration:'Synthetic declaration for test only',token:1};
  const poly=new PolyBot({telegram,store,canUse:access.canUse,clock:()=>now,timeoutMs,portalFactory:()=>{
    let registration;
    const portal={closed:false,answers:new Map([['txt_refundAmt',{value:'11010',display:'11010'}]]),open:async()=>{opens++;return Buffer.from('captcha');},login:async details=>{registration=details.registration;logins++;return {kind:'dashboard'};},choose:async operation=>{
      if(operation==='pdf') {pdfRequests++;if(pdfFails) throw Error('PDF failed');return {kind:'pdf',bytes:Buffer.from('%PDF-synthetic-test-only '+registration),pages:1};}
      return chooseStep?chooseStep(operation):step;
    },home:async()=>({kind:'dashboard'}),captcha:async()=>Buffer.from('fresh-captcha'),refreshLogin:async()=>Buffer.from('fresh-login'),values:()=>({}),fill:async()=>step,submit:async()=>{submits++;return typeof result==='function'?result():result;},close:async()=>{closed++;portal.closed=true;}};
    portal.read=async()=>step;return portal;
  }});
  const activity={record:async e=>events.push(safeActivity(e,new Date(now).toISOString()))};
  const saves=new SavedSessions({telegram,store,access,activity,clock:()=>now});
  const dummy={clear:async()=>{},expire:async()=>{},sessions:new Map()};
  const router=new BotRouter({telegram,poly,recovery:dummy,otr:dummy,registration:dummy,access,saves,activity,enablePoly:enabled,clock:()=>now});
  const message=(text,extra={})=>({message_id:incoming++,from:{id:99},chat:{id:99,type:'private'},text,...extra});
  const say=(text,extra)=>router.handle(message(text,extra));
  const login=async(operation='1')=>{for(const value of ['/start','3',operation,'000012345678','UP26-0000000001','TemporarySecret1@','AbC12']) await say(value);};
  return {root,store,poly,router,saves,sent,events,access,say,message,login,step:v=>{step=v;},advance:ms=>{now+=ms;},failDelivery:v=>{failDelivery=v;},counts:()=>({submits,opens,logins,documents,closed,pdfRequests})};
}

test('Poly validation preserves leading zeros and validates percentage/account confirmation',()=>{
  assert.equal(percentage('447','600'),'74.50');assert.equal(percentage('1','3'),'33.33');
  for(const [got,total] of [['601','600'],['1','0'],['-1','600'],['x','600']]) assert.throws(()=>percentage(got,total));
  assert.equal(normalizePoly({type:'digits'},'000123'),'000123');
  assert.equal(normalizePoly({type:'account-confirm'},'000123',{txt_std_accno:'000123'}),'000123');
  assert.throws(()=>normalizePoly({type:'account-confirm'},'123',{txt_std_accno:'000123'}));
  const fields=projectFields('poly',{registration:{value:'000012345678'},password:{value:'NEVER'},otp:{value:'NEVER'},captcha:{value:'NEVER'},cookies:{value:'NEVER'},txt_std_accno_Re:{value:'NEVER'}});
  assert.deepEqual(Object.keys(fields),['registration']);
  assert.equal(POLY_SECTIONS.fee.fields[0].defaultValue,'11010');
});

test('Menu is gated; authorized private users only; cancel and expiry close browser',async t=>{
  const f=await fixture(t,{enabled:false});await f.say('/start');await f.say('3');assert.match(f.sent.at(-1).text,/disabled/);assert.equal(f.counts().opens,0);
  f.router.enablePoly=true;await f.login();assert.equal(f.poly.sessions.get(99).phase,'confirm');
  const before=f.sent.length;await f.say('CONFIRM',{chat:{id:99,type:'group'}});assert.equal(f.sent.length,before);
  await f.say('/cancel');assert.equal(f.poly.sessions.size,0);assert.ok(f.counts().closed);
  await f.login();f.advance(21*60_000);await f.router.expire();assert.equal(f.poly.sessions.size,0);
});

test('Every section saves before submission; duplicate messages cannot post twice; secrets never saved/logged',async t=>{
  const f=await fixture(t);await f.login();const s=f.poly.sessions.get(99);
  assert.equal(s.credentials.password,undefined);assert.equal(s.phase,'confirm');const recordId=s.savedId;
  assert.equal(recordId,'D0001');
  await f.say('YES');const message=f.message('CaPt1');await Promise.all([f.router.handle(message),f.router.handle(message)]);
  assert.equal(f.counts().submits,1);assert.equal((await f.store.get(recordId,99)).status,'confirmed');
  const raw=await readFile(join(f.root,'records',recordId+'.enc'),'utf8');assert.doesNotMatch(raw,/11010|000012345678|TemporarySecret/);
  assert.doesNotMatch(JSON.stringify(f.events),/TemporarySecret|CaPt1|AbC12|000012345678|UP26-/);
});

test('Uncertain and timed-out submissions are durable and cannot be replayed',async t=>{
  for(const result of [{kind:'unknown'},()=>new Promise(()=>{})]) {
    const f=await fixture(t,{result,timeoutMs:20});await f.login();const recordId=f.poly.sessions.get(99).savedId;
    await f.say('CONFIRM');await f.say('CaPt1');assert.equal(f.poly.sessions.get(99).phase,'unknown');
    assert.equal((await f.store.get(recordId,99)).status,'uncertain');await f.say('CaPt1');await f.say('/retry');assert.equal(f.counts().submits,1);
  }
});

test('CAPTCHA rejection permits a fresh answer only; refresh never submits',async t=>{
  let count=0;const f=await fixture(t,{result:()=>++count===1?{kind:'captcha-error'}:{kind:'complete',stage:'form'}});
  await f.login();await f.say('CONFIRM');await f.say('/refresh');assert.equal(f.counts().submits,0);
  await f.say('Wrong');assert.equal(f.poly.sessions.get(99).phase,'captcha');await f.say('Fresh');assert.equal(f.counts().submits,2);
});

test('Certificate mismatch stops without verifying; MATCH is required',async t=>{
  const f=await fixture(t);f.step({kind:'record',stage:'income',record:'Synthetic certificate record',token:3});await f.login('2');
  await f.say('CONFIRM');assert.equal(f.counts().submits,0);await f.say('MISMATCH');assert.equal(f.poly.sessions.get(99).phase,'unsupported');assert.equal(f.counts().submits,0);
});

test('PDF persists before Telegram delivery; restart/ownership/retrieval never contact portal',async t=>{
  const f=await fixture(t);f.failDelivery(true);await f.login('3');const s=f.poly.sessions.get(99),id=s.savedId;
  assert.ok(s.result);assert.equal((await f.store.get(id,99)).result.kind,'pdf');const counts=f.counts();
  f.failDelivery(false);await f.say(`/result ${id}`);assert.ok(f.sent.at(-1).name.endsWith('.pdf'));assert.equal(f.counts().opens,counts.opens);
  const before=f.sent.length;await f.say(`/result ${id}`,{from:{id:42},chat:{id:42,type:'private'}});assert.match(f.sent.at(-1).text,/unavailable/);assert.equal(f.sent.slice(before).some(m=>m.name),false);
  await f.say('/cancel');await f.store.init();await f.say(`/save ${id}`);assert.ok(f.sent.some(m=>m.name?.endsWith('.pdf')));
  await f.say(`/reuse ${id}`);assert.equal(f.poly.sessions.get(99).phase,'poly-menu');assert.equal(f.counts().submits,0);
});

test('Failed storage marker prevents submission; uncertain outcome save can retry without submitting',async t=>{
  const f=await fixture(t);await f.login();await f.say('CONFIRM');const begin=f.store.begin.bind(f.store);f.store.begin=async()=>{throw Error('disk failure');};
  await f.say('CaPt1');assert.equal(f.counts().submits,0);f.store.begin=begin;
  await f.login();await f.say('CONFIRM');const outcome=f.store.outcome.bind(f.store);f.store.outcome=async()=>{throw Error('disk failure');};
  await f.say('CaPt1');const s=f.poly.sessions.get(99);assert.equal(f.counts().submits,1);assert.ok(s.pendingOutcome);assert.equal((await f.store.get(s.savedId,99)).status,'attempted');
  f.store.outcome=outcome;await f.say('/save');assert.equal((await f.store.get(s.savedId,99)).status,'confirmed');assert.equal(f.counts().submits,1);
});

test('PDF saving can recover from failure before creation or after the durable marker',async t=>{
  for(const method of ['save','begin','outcome']) {
    const f=await fixture(t),original=f.store[method].bind(f.store);f.store[method]=async()=>{throw Error('storage failure');};
    await f.login('3');const s=f.poly.sessions.get(99);assert.ok(s.result);assert.equal(f.counts().documents,0);
    f.store[method]=original;await f.say('/save');await f.say('/result');
    assert.equal((await f.store.get(s.savedId,99)).result.kind,'pdf');assert.equal(f.counts().documents,1);assert.equal(f.counts().opens,1);assert.equal(f.counts().submits,0);
  }
});

test('Selections paginate/filter live options and stale replies do not fill',async t=>{
  const f=await fixture(t);f.step({kind:'field',stage:'bank',field:{key:'ddl_bankname',label:'Bank',type:'choice',options:Array.from({length:100},(_,i)=>({value:String(i+1),label:`Bank ${i}`}))},token:1});
  await f.login();await f.say('/search Bank 9');assert.ok(f.sent.at(-1).options.reply_markup.keyboard.some(r=>r[0].includes('Bank 99')));
  await f.say('1',{reply_to_message:{message_id:1}});assert.match(f.sent.at(-1).text,/older step/);
});

test('Completed form continues into certificates and confirmed certificates automatically save/send the PDF',async t=>{
  let verified=false;
  const record={kind:'record',stage:'caste',record:'Synthetic verified candidate',token:5};
  const f=await fixture(t,{chooseStep:operation=>operation==='fill'?{kind:'complete',stage:'form'}:record,result:()=>{verified=true;return {kind:'complete',stage:'certificates'};}});
  await f.login();assert.equal(f.poly.sessions.get(99).phase,'record');assert.equal(f.counts().pdfRequests,0);
  const message=f.message('MATCH');await Promise.all([f.router.handle(message),f.router.handle(message)]);
  assert.ok(verified);assert.equal(f.counts().submits,1);assert.equal(f.counts().pdfRequests,1);assert.equal(f.counts().documents,1);
  const s=f.poly.sessions.get(99);assert.equal(s.phase,'done');assert.ok(s.pdfPersisted);
  const saved=await f.store.get(s.savedId,99);assert.equal(saved.result.kind,'pdf');assert.equal(saved.fields.registration.value,'000012345678');
  assert.ok(f.sent.find(m=>m.name)?.bytes.toString().includes('000012345678'));assert.equal(f.sent.find(m=>m.name).id,99);
});

test('Already-verified certificates automatically print, and two authorized users receive their own PDF only',async t=>{
  const f=await fixture(t,{chooseStep:()=>({kind:'complete',stage:'certificates'})});
  for(const [id,registration] of [[99,'000012345678'],[42,'000098765432']]) {
    const extra={from:{id},chat:{id,type:'private'}};
    for(const answer of ['/start','3','2',registration,'UP26-0000000001','TemporarySecret1@','AbC12']) await f.say(answer,extra);
  }
  assert.equal(f.counts().submits,0);assert.equal(f.counts().pdfRequests,2);
  const documents=f.sent.filter(m=>m.name);assert.equal(documents.length,2);
  assert.ok(documents.find(m=>m.id===99).bytes.toString().includes('000012345678'));
  assert.ok(documents.find(m=>m.id===42).bytes.toString().includes('000098765432'));
  assert.notEqual(f.poly.sessions.get(42).savedId,f.poly.sessions.get(99).savedId);
  await assert.rejects(f.store.get(f.poly.sessions.get(99).savedId,42));
});

test('PDF download/delivery failure after verification never repeats certificate verification',async t=>{
  for(const pdfFails of [true,false]) {
    const f=await fixture(t,{pdfFails,result:{kind:'complete',stage:'certificates'}});
    f.step({kind:'record',stage:'caste',record:'Synthetic candidate',token:8});await f.login('2');
    if(!pdfFails) f.failDelivery(true);
    await f.say('MATCH');assert.equal(f.counts().submits,1);assert.equal(f.counts().pdfRequests,1);
    if(pdfFails) {assert.match(f.sent.at(-1).text,/verification is confirmed, but PDF preparation failed/);await f.say('/retry');}
    else {f.failDelivery(false);await f.say('/result');assert.equal(f.counts().documents,2);}
    assert.equal(f.counts().submits,1);assert.equal(f.counts().pdfRequests,1);
  }
});
