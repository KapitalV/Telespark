import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RecoveryBot} from '../core.mjs';
import {OtrBot} from '../otr-core.mjs';
import {RegistrationBot} from '../registration-core.mjs';
import {PolyBot} from '../poly-core.mjs';
import {PolyPortal} from '../poly-portal.mjs';
import {OBC_SECTIONS} from '../poly-obc-schema.mjs';
import {FinalBot} from '../final-core.mjs';
import {FinalBatch} from '../final-batch.mjs';
import {SavedSessions} from '../saved-sessions.mjs';
import {BotRouter} from '../router.mjs';
import {safeActivity} from '../activity.mjs';

function fixture() {
  let incoming=1,outgoing=100,now=Date.now(),opens=0,closed=0;
  const sent=[],events=[],telegram={send:async(id,text,options)=>{sent.push({id,text,options});return {message_id:outgoing++};},photo:async(id,image,text)=>{sent.push({id,text,image});return {message_id:outgoing++};},document:async()=>{throw Error('No document should be delivered by navigation');}};
  const clock=()=>now,access={canUse:id=>Number(id)===42,isAdmin:id=>Number(id)===42},canUse=access.canUse;
  const unexpected=()=>{throw Error('Navigation must not submit, verify or lock');};
  const portalFactory=()=>({open:async()=>{opens++;return Buffer.from('test CAPTCHA');},close:async()=>{closed++;},submit:unexpected,login:unexpected,lock:unexpected,finalPdf:unexpected});
  const store={save:async()=>({id:'D0001'})};
  const recovery=new RecoveryBot({telegram,portalFactory,canUse,clock});
  const otr=new OtrBot({telegram,portalFactory,canUse,clock});
  const registration=new RegistrationBot({telegram,portalFactory,canUse,clock});
  const poly=new PolyBot({telegram,portalFactory,store,canUse,clock});
  const final=new FinalBot({telegram,portalFactory,store,canUse,clock,defaultPassword:'Synthetic1@'});
  const batch=new FinalBatch({telegram,isAdmin:canUse,portalFactory,clock,presets:{Preset:'Synthetic1@'}});
  const saves=new SavedSessions({telegram,store,access,clock,defaultProfilePassword:'Synthetic1@'});
  const activity={record:async event=>events.push(safeActivity(event,new Date(now).toISOString()))};
  const router=new BotRouter({telegram,recovery,otr,registration,poly,final,batch,saves,access,activity,enableOtr:true,enablePoly:true,enableFinal:true,clock});
  const bots={password:recovery,otr,registration,poly,final,'final-batch':batch};
  const message=(text,extra={})=>({message_id:incoming++,from:{id:42},chat:{id:42,type:'private'},text,...extra});
  const say=(text,extra)=>router.handle(message(text,extra));
  const select=(module,state)=>{router.sessions.set(42,{module,updated:now});const s={updated:now,lastMessageId:0,values:{},credentials:{},...state};bots[module].sessions.set(42,s);return s;};
  return {telegram,sent,events,router,recovery,otr,registration,poly,final,batch,saves,select,say,message,advance:ms=>{now+=ms;},counts:()=>({opens,closed})};
}

function editablePortal(current,stage='academic') {
  const portal=new PolyPortal({sections:structuredClone(OBC_SECTIONS)}),fields=portal.sections[stage].fields;
  portal.stage=stage;const edits=[];
  for(const field of fields.slice(0,fields.findIndex(field=>field.key===current))) portal.answers.set(field.key,{value:'synthetic',display:'Synthetic answer'});
  portal.read=async()=>{
    const field=fields.find(field=>!field.computed&&!portal.answers.has(field.key));
    return field?{kind:'field',stage,field:{...field,options:['choice','radio'].includes(field.type)?[{value:'synthetic',label:field.defaultLabel||'Synthetic choice'}]:undefined,suggestion:field.autoDefault?'synthetic':undefined},token:1}:{kind:'review',stage,review:['Synthetic review'],token:2};
  };
  const edit=portal.edit.bind(portal);portal.edit=async key=>{edits.push(key);return edit(key);};
  portal.fill=async()=>{throw Error('A reopened field must be answered explicitly');};
  portal.close=async()=>{portal.closed=true;};
  return {portal,edits,step:async()=>portal.read()};
}

test('Typed-only back is in help, absent from menus, authorized, deduplicated and logged without answers',async()=>{
  const f=fixture();await f.say('/start');assert.doesNotMatch(JSON.stringify(f.sent),/\/back/);
  await f.say('/help');assert.match(f.sent.at(-1).text,/\/back — previous editable input/);
  await f.say('3');await f.say('1');await f.say('Fresh');assert.equal(f.poly.sessions.get(42).phase,'category');
  const command=f.message('/back');await Promise.all([f.router.handle(command),f.router.handle(command)]);
  assert.equal(f.poly.sessions.get(42).phase,'type');
  assert.ok(f.events.some(event=>event.action==='/back'));assert.ok(f.events.some(event=>event.reason==='duplicate'));
  const count=f.sent.length;await f.say('/back',{chat:{id:42,type:'group'}});assert.equal(f.sent.length,count);
  await f.say('/back',{from:{id:99}});assert.match(f.sent.at(-1).text,/restricted/);assert.equal(f.poly.sessions.get(42).phase,'type');
  assert.equal(f.sent.filter(message=>message.options?.reply_markup?.keyboard).some(message=>JSON.stringify(message.options).includes('/back')),false);
});

test('Password recovery backs through dependent questions, clears later answers and invalidates the CAPTCHA',async()=>{
  const f=fixture();for(const answer of ['/start','1','Fresh','000012345678','0000000000']) await f.say(answer);
  await f.say('/back');let s=f.recovery.sessions.get(42);assert.equal(s.index,2);assert.deepEqual(s.details,{applicationType:'Fresh',registration:'000012345678'});
  for(const answer of ['0000000000','UP BOARD','2021','000001']) await f.say(answer);
  assert.equal(s.phase,'captcha');await f.say('/back');assert.equal(s.phase,'questions');assert.equal(s.index,5);assert.equal(s.details.roll,undefined);assert.equal(s.portal,undefined);assert.ok(f.counts().closed);
  for(let n=0;n<6;n++) await f.say('/back');assert.equal(f.router.sessions.get(42).module,'menu');assert.equal(f.recovery.sessions.size,0);
  assert.doesNotMatch(JSON.stringify(f.events),/000012345678|0000000000/);
});

test('OTR backs inside the current verification step but never requests another OTP',async()=>{
  const f=fixture(),fields=[{key:'otp',type:'otp',label:'OTP'},{key:'captcha',type:'captcha',label:'CAPTCHA'}];
  const s=f.select('otr',{phase:'questions',mode:'recover',index:1,values:{otp:'000123'},step:{kind:'form',stage:'otp',fields,action:{kind:'verify-otp'},image:Buffer.from('test image')},portal:{submit:()=>assert.fail('No OTP submission'),resend:()=>assert.fail('No OTP resend')}});
  await f.say('/back');assert.equal(s.index,0);assert.deepEqual(s.values,{});assert.equal(f.sent.at(-1).text.includes('OTP'),true);
  await f.say('/back');assert.equal(s.index,0);assert.match(f.sent.at(-1).text,/Completed requests cannot be undone/);
  s.phase='confirm';s.values={otp:'000123',captcha:'AbC12'};await f.say('/back');assert.equal(s.phase,'questions');assert.equal(s.index,1);assert.equal(s.values.captcha,undefined);
});

test('Poly login and category navigation clears later credentials without logging in',async()=>{
  const f=fixture();for(const answer of ['/start','3','1','Fresh','OBC','000012345678','UP26-0000000050','TemporaryOnly1@']) await f.say(answer);
  const s=f.poly.sessions.get(42);assert.equal(s.phase,'login-captcha');await f.say('/back');
  assert.equal(s.phase,'login');assert.equal(s.index,2);assert.equal(s.credentials.password,undefined);assert.equal(s.portal,undefined);
  await f.say('/back');assert.equal(s.index,1);assert.equal(s.credentials.otr,undefined);assert.equal(s.credentials.registration,'000012345678');
  await f.say('/back');assert.equal(s.index,0);assert.deepEqual(s.credentials,{});
  await f.say('/back');assert.equal(s.phase,'category');await f.say('/back');assert.equal(s.phase,'type');
  assert.equal(f.counts().opens,1);assert.doesNotMatch(JSON.stringify(f.events),/TemporaryOnly1@/);
});

test('Poly back reopens a default for manual correction, clears dependent answers and skips computed percentage',async()=>{
  for(const [current,previous] of [['txt_uptu_counsellingRegisterNo','ddl_uptu_type'],['Gridview1_grid_txt_affiliating_0','Gridview1_grid_txt_Obtain_0']]) {
    const f=fixture(),p=editablePortal(current),s=f.select('poly',{phase:'questions',portal:p.portal,step:await p.step(),reuse:{},autoDefaultAttempted:new Set(['academic:'+previous])});
    await f.say('/back');assert.deepEqual(p.edits,[previous]);assert.equal(s.step.field.key,previous);assert.equal(s.phase,'questions');assert.equal(s.manualEditKey,previous);
    assert.equal(p.portal.answers.has(current),false);assert.equal(p.portal.answers.has(previous),false);
    await f.say('/back');assert.notEqual(s.step.field.key,previous);assert.equal(s.phase,'questions');
  }
});

test('Poly confirmation/CAPTCHA can return to review or a field; completed and uncertain states cannot replay',async()=>{
  const f=fixture(),p=editablePortal('txt_refundAmt','fee');p.portal.answers.set('txt_refundAmt',{value:'11010',display:'11010'});
  const s=f.select('poly',{phase:'captcha',portal:p.portal,step:await p.step(),reuse:{},credentials:{registration:'000012345678'}});
  await f.say('/back');assert.equal(s.phase,'confirm');assert.match(f.sent.at(-1).text,/Send YES/);
  await f.say('/back');assert.equal(s.phase,'questions');assert.equal(s.step.field.key,'txt_refundAmt');
  for(const phase of ['unknown','done','record','blocked']) {s.phase=phase;const count=p.edits.length;await f.say('/back');assert.equal(p.edits.length,count);assert.equal(s.phase,phase);}
  s.phase='questions';s.pendingOutcome={status:'uncertain'};await f.say('/back');assert.equal(s.pendingOutcome.status,'uncertain');
});

test('Saved-user back and help work before storage, without showing or retaining the entered password',async()=>{
  const f=fixture();for(const answer of ['/saveuser','UP26-0000000050','000012345678','OTHER PASSWORD']) await f.say(answer);
  const profile=f.saves.userProfiles.get(42);assert.equal(profile.phase,'password');await f.say('/help');assert.equal(profile.phase,'password');assert.match(f.sent.at(-1).text,/\/back/);
  await f.say('/back');assert.equal(profile.phase,'password-choice');await f.say('/back');assert.equal(profile.phase,'registration');assert.equal(profile.fields.registration,undefined);
  await f.say('/back');assert.equal(profile.phase,'otr');assert.deepEqual(profile.fields,{});await f.say('/back');assert.equal(f.saves.hasUserProfile(42),false);
});

test('Final print backs through login questions and never reopens a completed lock review',async()=>{
  const f=fixture();for(const answer of ['/start','5','Fresh','000012345678','UP26-0000000050','Other','TemporaryOnly1@']) await f.say(answer);
  const s=f.final.sessions.get(42);await f.say('/back');assert.equal(s.phase,'password');assert.equal(s.credentials.password,undefined);assert.equal(s.portal,undefined);
  await f.say('/back');assert.equal(s.phase,'password-choice');await f.say('/back');assert.equal(s.phase,'otr');assert.equal(s.credentials.otr,undefined);
  s.phase='confirm';s.lockId='L0001';await f.say('/back');assert.equal(s.phase,'confirm');assert.equal(f.counts().opens,1);
});

test('Batch back changes only current candidate password input, preserving index, reports and batch default',async()=>{
  const f=fixture(),s=f.select('final-batch',{phase:'captcha',index:1,rows:[{status:'PDF sent',pdfId:'L0001'},{status:'pending'}],password:'BatchOnly1@',rowPassword:'CandidateOnly1@',portal:{close:async()=>{}}});
  await f.say('/back');assert.equal(s.phase,'password-choice');assert.equal(s.perRow,true);assert.equal(s.index,1);assert.equal(s.password,'BatchOnly1@');assert.equal(s.rowPassword,'CandidateOnly1@');assert.equal(s.rows[0].pdfId,'L0001');
  s.phase='captcha';s.passwordStep='password';await f.say('/back');assert.equal(s.phase,'password');assert.equal(s.perRow,true);assert.equal(s.password,'BatchOnly1@');
  s.phase='delivery';s.delivery={pdfId:'L0002'};await f.say('/back');assert.equal(s.phase,'delivery');assert.equal(s.delivery.pdfId,'L0002');assert.equal(s.index,1);
});

test('Navigation failures, expiry and pending durable outcomes do not bypass the stop boundary',async()=>{
  const f=fixture(),p=editablePortal('ddl_CurrentCourse_Branch');p.portal.edit=async()=>{throw Error('NEVER_EXPOSE_OTP_OR_PASSWORD');};
  const s=f.select('poly',{phase:'questions',portal:p.portal,step:await p.step(),reuse:{}});await f.say('/back');assert.equal(s.phase,'blocked');assert.equal(p.portal.closed,true);assert.doesNotMatch(f.sent.at(-1).text,/NEVER_EXPOSE/);
  f.advance(21*60_000);await f.say('/back');assert.equal(f.poly.sessions.size,0);assert.equal(f.router.sessions.has(42),false);
  await f.say('/back extra');assert.match(f.sent.at(-1).text,/without arguments/);
});

test('A failed reopened-prompt delivery closes its portal and releases the busy flag without exposing raw errors',async()=>{
  const f=fixture(),p=editablePortal('ddl_CurrentCourse_Branch');
  const s=f.select('poly',{phase:'questions',portal:p.portal,step:await p.step(),reuse:{}});
  const send=f.telegram.send;let fail=true;
  f.telegram.send=async(...args)=>{if(fail){fail=false;throw Error('NEVER_EXPOSE_DELIVERY_DETAILS');}return send(...args);};
  await f.say('/back');assert.equal(s.phase,'blocked');assert.equal(s.busy,false);assert.equal(p.portal.closed,true);assert.doesNotMatch(f.sent.at(-1).text,/NEVER_EXPOSE/);
});
