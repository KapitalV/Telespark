import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {RegistrationBot,normalizeRegistrationAnswer} from '../registration-core.mjs';
import {RegistrationPortal,REGISTRATION_FIELDS} from '../registration-portal.mjs';
import {BotRouter} from '../router.mjs';
import {OTR_ORIGIN} from '../otr-schema.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {SavedStore} from '../saved-store.mjs';
import {SavedSessions} from '../saved-sessions.mjs';

test('Registration validates OTR, optional roll letters, leading zeros, exact years and matching passwords',()=>{
  assert.equal(normalizeRegistrationAnswer({type:'otr'},'up26-0000000001'),'UP26-0000000001');
  assert.throws(()=>normalizeRegistrationAnswer({type:'otr'},'1234567890'));
  assert.equal(normalizeRegistrationAnswer({type:'prefix'},'none'),'');
  assert.equal(normalizeRegistrationAnswer({type:'prefix'},'ab'),'AB');
  assert.equal(normalizeRegistrationAnswer({type:'roll'},'000001'),'000001');
  assert.throws(()=>normalizeRegistrationAnswer({type:'roll'},'12A'));
  for (const bad of ['short','PASSWORD1@','password1@','Password12','Password@']) assert.throws(()=>normalizeRegistrationAnswer({type:'password'},bad));
  assert.equal(normalizeRegistrationAnswer({type:'password'},'Example1@'),'Example1@');
  assert.throws(()=>normalizeRegistrationAnswer({type:'password-confirm'},'Other1@','Example1@'));
  assert.equal(normalizeRegistrationAnswer({options:[{label:'2021',value:'year2021'}]},'2021'),'year2021');
});

function chat(portal,options={}) {
  let outgoing=100,incoming=1,now=Date.now();
  const sent=[];
  const telegram={send:async (_id,text,opts)=>{sent.push({text,opts});return {message_id:outgoing++};},photo:async (_id,image,text,opts)=>{sent.push({text,image,opts});return {message_id:outgoing++};},document:async(_id,image,name,text)=>{sent.push({text,image,name});}};
  const saves=options.store?new SavedSessions({store:options.store,telegram,access:{canUse:id=>String(id)==='42',isAdmin:id=>String(id)==='42'},clock:()=>now}):undefined;
  const bot=new RegistrationBot({telegram,portalFactory:()=>portal,allowedUserId:'42',clock:()=>now,timeoutMs:10_000,saves,...options});
  const dummy={clear:async()=>{},expire:async()=>{},start:async()=>{throw Error('Wrong module');}};
  const router=new BotRouter({telegram,registration:bot,otr:dummy,recovery:dummy,saves,allowedUserId:'42',enableOtr:true,clock:()=>now});
  const message=(text,extra={})=>({message_id:incoming++,from:{id:42},chat:{id:42,type:'private'},text,...extra});
  return {bot,router,sent,telegram,message,say:(text,extra)=>router.handle(message(text,extra)),advance:ms=>{now+=ms;}};
}

test('Jalaun selection uses the live value and stops if missing or repeatedly discarded',async()=>{
  for (const available of [false,true]) {
    const submitted=[];
    const field={id:'ContentPlaceHolder1_ddl_district',key:'district',type:'choice',options:[{value:'different',label:'Lucknow'},...(available?[{value:'live-jalaun',label:'Jalaun'}]:[])]};
    const step={kind:'form',fields:[field],action:{kind:'fill'},fingerprint:'f'};
    const portal={open:async()=>step,submit:async values=>{submitted.push(values);return step;},close:async()=>{}};
    const f=chat(portal);
    for(const answer of ['/start','2','2']) await f.say(answer);
    assert.equal(f.bot.sessions.get(42).phase,'unsupported');
    assert.match(f.sent.at(-1).text,/did not offer or retain Jalaun/);
    assert.deepEqual(submitted,available?[{district:'live-jalaun'},{district:'live-jalaun'}]:[]);
  }
});

async function savedStore(t) {
  const root=await mkdtemp(join(tmpdir(),'telespark-registration-save-test-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('telespark-registration-save-test-'));await rm(root,{recursive:true,force:true});});
  const store=new SavedStore({directory:join(root,'records'),keyFile:join(root,'key')});await store.init();return store;
}

test('Registration timeout durably records an uncertain outcome and cannot be resubmitted',async t=>{
  const store=await savedStore(t);let submits=0;
  const portal={answers:new Map([['ContentPlaceHolder1_txt_pwd',{value:'Example1@'}]]),open:async()=>({kind:'form',fields:[{key:'captcha',type:'captcha'}],action:{kind:'register'},fingerprint:'f',image:Buffer.from('image'),review:['Synthetic student']}),submit:async()=>{submits++;await new Promise(()=>{});},close:async()=>{portal.answers.clear();}};
  const f=chat(portal,{store,timeoutMs:25});
  for(const answer of ['/start','2','2','AbC12','YES']) await f.say(answer);
  const state=f.bot.sessions.get(42);assert.equal(state.phase,'unknown');assert.equal((await store.get(state.savedId,42)).status,'uncertain');
  await f.say('CONFIRM');await f.say('/dsave');assert.equal(submits,1);
});

test('Registration timeouts do not retry submission and clear in-memory passwords',async()=>{
  let submits=0,closed=0;
  const portal={answers:new Map([['ContentPlaceHolder1_txt_pwd',{value:'Example1@'}]]),open:async()=>({kind:'form',fields:[{key:'captcha',type:'captcha'}],action:{kind:'register'},fingerprint:'f',image:Buffer.from('image'),review:['Synthetic student']}),submit:async()=>{submits++;await new Promise(()=>{});},close:async()=>{closed++;portal.answers.clear();}};
  const f=chat(portal,{timeoutMs:20});
  for (const value of ['/start','2','2','AbC12','CONFIRM','CONFIRM','/retry']) await f.say(value);
  assert.equal(submits,1);assert.equal(f.bot.sessions.get(42).phase,'unknown');
  assert.ok(closed);assert.equal(portal.answers.size,0);
  assert.ok(f.sent.every(s=>!s.text.includes('Example1@')));
});

test('Registration list search is paginated, owner-only and expires with cancellation',async()=>{
  const field={key:'institute',type:'choice',label:'Institution',options:Array.from({length:708},(_,i)=>({value:String(i),label:`College ${i}`}))};
  let closed=0;
  const portal={answers:new Map(),open:async()=>({kind:'form',fields:[field],action:{kind:'fill'},fingerprint:'f'}),close:async()=>{closed++;}};
  const f=chat(portal);
  for (const value of ['/start','2','2','/search College 70']) await f.say(value);
  assert.match(f.sent.at(-1).text,/701\. College 700/);
  assert.ok(f.sent.every(s=>s.text.length<=4096));
  const before=f.sent.length;
  await f.bot.handle(f.message('/search secret',{from:{id:99}}));
  assert.equal(f.sent.length,before);
  f.advance(21*60_000);await f.bot.expire();assert.equal(f.bot.sessions.size,0);assert.ok(closed);
  await f.say('/menu');assert.equal(f.bot.sessions.size,0);
});

const p='ContentPlaceHolder1_';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const form=body=>`<!doctype html><meta charset="utf-8"><form method="post">${body}</form>`;
const landing=form(`<script>function __doPostBack(){document.forms[0].action='/RegistrationFormInstituteDIG.aspx?C=MQ==';document.forms[0].submit()}</script><a id="${p}lnbPostFreshOBC" href="javascript:__doPostBack()">Postmatric OBC</a>`);
function details(values,extra='') {
  const options={ddl_district:[['46','Lucknow'],['35','Jalaun']],ddl_institute:values.get(p+'ddl_district')?Array.from({length:50},(_,i)=>[String(i+1),`College ${i+1}`]):[],ddl_caste:[['1','OBC']],ddl_relegion:values.get(p+'ddl_caste')?[['1','Hindu']]:[],ddl_highschpassyear:[['2021','2021']],ddl_board:[['1','UP BOARD'],['2','CBSE'],['3','ICSE']]};
  const inputs=REGISTRATION_FIELDS.map(f=>{
    const value=escape(values.get(f.id)||'');
    if (f.type==='choice') {
      const suffix=f.id.slice(p.length);
      const post=['ddl_district','ddl_institute','ddl_caste'].includes(suffix)?' onchange="__doPostBack()"':'';
      return `<select id="${f.id}" name="${f.id}"${post}><option value="">Select</option>${options[suffix].map(([v,label])=>`<option value="${v}" ${v===values.get(f.id)?'selected':''}>${label}</option>`).join('')}</select>`;
    }
    return `<input id="${f.id}" name="${f.id}" type="${f.type.startsWith('password')?'password':'text'}" maxlength="${f.type==='captcha'?5:f.type==='prefix'?2:f.type.startsWith('password')?12:11}" value="${value}">`;
  }).join('');
  return `<div id="${p}dvreg"><input id="${p}txt_studentname" disabled value="TEST STUDENT"><input id="${p}txt_mobileno" disabled value="9876543210">${inputs}${extra}<img id="Captcha" src="/captcha.ashx?1"><img id="reloadcaptcha" src="/refresh.svg" onclick="document.getElementById('Captcha').src='/captcha.ashx?'+Date.now()"><input type="submit" id="${p}btn_submit" name="final" value="Proceed Registration"></div>`;
}
function registration(values,show,extra='') {
  return form(`<script>function __doPostBack(){document.forms[0].submit()}</script><input id="${p}TextBox3" name="${p}TextBox3" value="${escape(values.get(p+'TextBox3')||'')}"><input type="submit" id="${p}btn_sumit_otr" name="lookup" value="Submit">${show?details(values,extra):''}`);
}

test('Registration browser workflow with observed controls (network fully intercepted)',{skip:process.env.OTR_BROWSER_TESTS!=='true'},async t=>{
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
  t.after(()=>browser.close());
  async function fixture({extra='',failFinal=false,unchangedFinal=false}={}) {
    let context,show=false;
    const posts=[],values=new Map();
    const portal=new RegistrationPortal({launch:async()=>({newContext:async options=>{
      context=await browser.newContext(options);
      await context.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        if (url.origin!==OTR_ORIGIN) return route.abort();
        if (/captcha|refresh/.test(url.pathname)) return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="10" y="25">AbC12</text></svg>'});
        if (url.pathname==='/RegistrationNew.aspx') return route.fulfill({contentType:'text/html',body:landing});
        if (request.method()==='POST') {
          const data=new URLSearchParams(request.postData());posts.push(data);
          for(const [key,value] of data) values.set(key,value);
          if(data.has('lookup')) show=true;
          if(data.has('final')) {
            if(failFinal) return route.abort();
            return route.fulfill({contentType:'text/html',body:unchangedFinal?registration(values,true):form('<h1>Registration response</h1><p>Application number: 000123456789</p><button>Unverified next step</button>')});
          }
        }
        return route.fulfill({contentType:'text/html',body:registration(values,show,extra)});
      });return context;
    },close:async()=>context?.close()})});
    t.after(()=>portal.close());
    return {portal,posts};
  }
  async function untilCaptcha(f) {
    for (const answer of ['/start','2','2','1','UP26-0000000001','/search College 42','42','1','1','2021']) await f.say(answer);
    assert.deepEqual(f.bot.sessions.get(42).step.fields[0].options.map(o=>o.label),['UP BOARD','CBSE']);
    await f.say('ICSE');assert.match(f.sent.at(-1).text,/Choose a listed option/);
    for(const answer of ['CBSC BOARD','NONE','000012345','Example1@','Wrong1@','Example1@']) await f.say(answer);
    assert.equal(f.bot.sessions.get(42).step.fields[0].type,'captcha');
  }
  await t.test('Menus to dependent fields, review, single submission, screenshot and re-delivery',async()=>{
    const fixtureState=await fixture();const f=chat(fixtureState.portal);
    await untilCaptcha(f);
    assert.equal(fixtureState.posts.filter(p=>p.has('final')).length,0);
    await f.say('/refresh');assert.equal(f.bot.sessions.get(42).step.fields[0].type,'captcha');
    await f.say('AbC12');assert.equal(f.bot.sessions.get(42).phase,'confirm');
    const review=f.sent.at(-1).text;
    assert.match(review,/College 42/);assert.match(review,/000012345/);assert.match(review,/2021/);assert.doesNotMatch(review,/Example1@/);
    assert.match(review,/Jalaun/);assert.match(review,/CBSE/);
    assert.deepEqual(f.sent.find(m=>m.opts?.reply_markup?.keyboard?.[0]?.includes('CBSE BOARD')).opts.reply_markup.keyboard,[['UP BOARD','CBSE BOARD']]);
    const confirm=f.message('CONFIRM');await Promise.all([f.router.handle(confirm),f.router.handle(confirm)]);
    assert.equal(f.bot.sessions.get(42).phase,'done');
    assert.ok(f.sent.at(-1).image.length>0);assert.equal(f.sent.at(-1).opts.protect_content,false);
    assert.equal(fixtureState.portal.answers.size,0);
    assert.equal(fixtureState.posts.filter(p=>p.has('final')).length,1);
    const posted=fixtureState.posts.find(p=>p.has('final'));
    assert.equal(posted.get(p+'txt_hghrollno'),'000012345');assert.equal(posted.get(p+'txt_hghrollnoA'),'');
    assert.equal(posted.get(p+'ddl_district'),'35');assert.equal(posted.get(p+'ddl_board'),'2');
    await f.say('/result');await f.say('CONFIRM');
    assert.equal(fixtureState.posts.filter(p=>p.has('final')).length,1);
    await f.say('/cancel');assert.equal(f.bot.sessions.size,0);
  });
  await t.test('Unknown fields never get filled or submitted',async()=>{
    const fs=await fixture({extra:'<input id="unexpectedVerification" name="unknown">'});const f=chat(fs.portal);
    for(const answer of ['/start','2','2','1','UP26-0000000001']) await f.say(answer);
    assert.equal(f.bot.sessions.get(42).phase,'unsupported');
    assert.equal(fs.posts.filter(p=>p.has('final')).length,0);
  });
  await t.test('Typed back reopens previous registration answers and clears dependent passwords without a final POST',async()=>{
    const fs=await fixture(),f=chat(fs.portal);
    await untilCaptcha(f);
    await f.say('/back');assert.equal(f.bot.sessions.get(42).step.fields[0].type,'password-confirm');
    assert.equal(fs.portal.answers.has(p+'txt_pwd_confirm'),false);
    await f.say('/back');assert.equal(f.bot.sessions.get(42).step.fields[0].type,'password');
    assert.equal(fs.portal.answers.has(p+'txt_pwd'),false);
    for(const answer of ['Changed1@','Changed1@','AbC12']) await f.say(answer);
    assert.equal(f.bot.sessions.get(42).phase,'confirm');
    await f.say('/back');assert.equal(f.bot.sessions.get(42).phase,'questions');assert.equal(f.bot.sessions.get(42).step.fields[0].type,'captcha');
    assert.equal(f.bot.sessions.get(42).values[p+'txtCaptcha'],undefined);
    assert.equal(fs.posts.filter(post=>post.has('final')).length,0);
    const before=fs.posts.length;assert.equal(await fs.portal.editPrevious('stale-token'),null);assert.equal(fs.posts.length,before);
  });
  await t.test('Portal retains form after submission: return response image, never claim success or retry',async()=>{
    const fs=await fixture({unchangedFinal:true});const f=chat(fs.portal);
    await untilCaptcha(f);await f.say('AbC12');await f.say('CONFIRM');
    assert.equal(f.bot.sessions.get(42).phase,'done');assert.ok(f.sent.at(-1).image);
    assert.doesNotMatch(f.sent.at(-1).text,/confirmed|successfully/);
    await f.say('CONFIRM');assert.equal(fs.posts.filter(p=>p.has('final')).length,1);
  });
  await t.test('Broken final response cannot trigger another registration',async()=>{
    const fs=await fixture({failFinal:true});const f=chat(fs.portal);
    await untilCaptcha(f);await f.say('AbC12');await f.say('CONFIRM');await f.say('CONFIRM');
    assert.equal(f.bot.sessions.get(42).phase,'unknown');assert.equal(fs.posts.filter(p=>p.has('final')).length,1);
  });
  await t.test('Optional /dsave without /save, YES submits, automatic reuse save and receipt retrieval',async st=>{
    const store=await savedStore(st),fs=await fixture(),f=chat(fs.portal,{store});
    await untilCaptcha(f);await f.say('AbC12');
    assert.equal(fs.posts.filter(p=>p.has('final')).length,0);assert.match(f.sent.at(-1).text,/Type YES/);
    await f.say('/dsave');
    const id=f.bot.sessions.get(42).savedId,ready=await store.get(id,42);
    const screenshot=fs.portal.page.screenshot.bind(fs.portal.page);
    fs.portal.page.screenshot=options=>{assert.match(options.mask[0].toString(),/txtCaptcha/);assert.match(options.mask[0].toString(),/otp/);return screenshot(options);};
    assert.equal(ready.status,'ready');assert.equal(ready.fields[p+'txt_pwd'].value,'Example1@');
    assert.equal(ready.fields[p+'ddl_institute'].label,'College 42');assert.equal(ready.fields[p+'ddl_district'].label,'Jalaun');
    assert.equal(ready.fields.studentName.value,'TEST STUDENT');assert.equal(ready.fields.linkedMobile.value,'9876543210');
    assert.equal(ready.fields[p+'txtCaptcha'],undefined);assert.equal(ready.fields[p+'txt_pwd_confirm'],undefined);
    const confirm=f.message('YES');await Promise.all([f.router.handle(confirm),f.router.handle(confirm)]);
    assert.equal(fs.posts.filter(p=>p.has('final')).length,1);
    const result=await store.get(id,42);assert.equal(result.status,'uncertain');assert.ok(result.result.image);
    await f.say('/cancel');await f.say(`/dsave ${id}`);assert.ok(f.sent.some(m=>m.name===`${id}.png`));
    const reused=await fixture();f.bot.portalFactory=()=>reused.portal;
    await f.say(`/reuse ${id}`);
    assert.equal(f.bot.sessions.get(42).step.fields[0].type,'captcha');
    assert.equal(reused.portal.answers.get(p+'txt_pwd').value,'Example1@');
    assert.equal(reused.portal.answers.get(p+'txt_hghrollno').value,'000012345');
    assert.equal(reused.posts.filter(p=>p.has('final')).length,0);
    await f.say('AbC12');await f.say('YES');assert.equal(reused.posts.filter(p=>p.has('final')).length,1);
    assert.notEqual(f.bot.sessions.get(42).savedId,id);
    await f.say('/cancel');
    const changed={...ready.fields,[p+'ddl_institute']:{value:'42',label:'Different college'}};
    const draft=await store.save({userId:42,module:'registration',fields:changed});
    const changedPortal=await fixture();f.bot.portalFactory=()=>changedPortal.portal;
    await f.say(`/reuse ${draft.id}`);
    assert.equal(f.bot.sessions.get(42).step.fields[0].id,p+'ddl_institute');
    assert.equal(changedPortal.posts.filter(p=>p.has('final')).length,0);
    await f.say('/cancel');
  });
});
