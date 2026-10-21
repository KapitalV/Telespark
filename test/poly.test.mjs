import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {PolyBot} from '../poly-core.mjs';
import {SavedStore} from '../saved-store.mjs';
import {SavedSessions} from '../saved-sessions.mjs';
import {BotRouter} from '../router.mjs';
import {POLY_SECTIONS,POLY_IGNORED_EMPTY_FIELDS,normalizePoly,percentage} from '../poly-schema.mjs';
import {OBC_EXTRA_FIELDS,OBC_SECTIONS,filterObcOptions,preferredObcValue} from '../poly-obc-schema.mjs';
import {createPolyHeadlessResolver} from '../poly-headless.mjs';
import {projectFields} from '../saved-schema.mjs';
import {safeActivity} from '../activity.mjs';

async function fixture(t,{result={kind:'complete',stage:'form'},enabled=true,timeoutMs=1000,pdfFails=false,chooseStep,defaultProfilePassword='DefaultOnly@1',configurePortal}={}) {
  const root=await mkdtemp(join(tmpdir(),'telespark-poly-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('telespark-poly-'));await rm(root,{recursive:true,force:true});});
  const store=new SavedStore({directory:join(root,'records'),keyFile:join(root,'key')});await store.init();
  let now=Date.now(),incoming=1,outgoing=100,submits=0,opens=0,logins=0,documents=0,closed=0,failDelivery=false,pdfRequests=0;
  const sent=[],events=[],portalTypes=[],portalRoutes=[],access={canUse:id=>[42,99].includes(Number(id)),isAdmin:id=>Number(id)===42};let lastLogin;
  const telegram={send:async(id,text,options)=>{sent.push({id,text,options});return {message_id:outgoing++};},photo:async(id,bytes,text)=>{sent.push({id,bytes,text});return {message_id:outgoing++};},document:async(id,bytes,name)=>{documents++;if(failDelivery) throw Error('delivery failed');sent.push({id,bytes,name});}};
  let step={kind:'review',stage:'fee',review:['Fee: 11010'],declaration:'Synthetic declaration for test only',token:1};
  const poly=new PolyBot({telegram,store,canUse:access.canUse,clock:()=>now,timeoutMs,portalFactory:(applicationType,categoryRoute)=>{
    portalTypes.push(applicationType);
    portalRoutes.push(categoryRoute);
    let registration;
    const portal={closed:false,answers:new Map([['txt_refundAmt',{value:'11010',display:'11010'}]]),open:async()=>{opens++;return Buffer.from('captcha');},login:async details=>{lastLogin={...details};registration=details.registration;logins++;return {kind:'dashboard'};},choose:async operation=>{
      if(operation==='pdf') {pdfRequests++;if(pdfFails) throw Error('PDF failed');return {kind:'pdf',bytes:Buffer.from('%PDF-synthetic-test-only '+registration),pages:1};}
      return chooseStep?chooseStep(operation):step;
    },home:async()=>({kind:'dashboard'}),captcha:async()=>Buffer.from('fresh-captcha'),refreshLogin:async()=>Buffer.from('fresh-login'),values:()=>({}),fill:async()=>step,submit:async()=>{submits++;return typeof result==='function'?result():result;},close:async()=>{closed++;portal.closed=true;}};
    portal.read=async()=>step;configurePortal?.(portal);return portal;
  }});
  const activity={record:async e=>events.push(safeActivity(e,new Date(now).toISOString()))};
  const saves=new SavedSessions({telegram,store,access,activity,clock:()=>now,defaultProfilePassword});
  const dummy={clear:async()=>{},expire:async()=>{},sessions:new Map()};
  const router=new BotRouter({telegram,poly,recovery:dummy,otr:dummy,registration:dummy,access,saves,activity,enablePoly:enabled,clock:()=>now});
  const message=(text,extra={})=>({message_id:incoming++,from:{id:99},chat:{id:99,type:'private'},text,...extra});
  const say=(text,extra)=>router.handle(message(text,extra));
  const login=async(operation='1',applicationType='Fresh',category='1')=>{for(const value of ['/start','3',operation,applicationType,category,'000012345678','UP26-0000000001','TemporarySecret1@','AbC12']) await say(value);};
  return {root,store,poly,router,saves,sent,events,portalTypes,portalRoutes,access,say,message,login,step:v=>{step=v;},advance:ms=>{now+=ms;},failDelivery:v=>{failDelivery=v;},lastLogin:()=>lastLogin,counts:()=>({submits,opens,logins,documents,closed,pdfRequests})};
}

test('Poly validation preserves leading zeros and validates percentage/account confirmation',()=>{
  assert.equal(percentage('447','600'),'74.50');assert.equal(percentage('1','3'),'33.33');
  for(const [got,total] of [['601','600'],['1','0'],['-1','600'],['x','600']]) assert.throws(()=>percentage(got,total));
  assert.equal(normalizePoly({type:'digits'},'000123'),'000123');
  assert.equal(normalizePoly({type:'account-confirm'},'000123',{txt_std_accno:'000123'}),'000123');
  assert.throws(()=>normalizePoly({type:'account-confirm'},'123',{txt_std_accno:'000123'}));
  const fields=projectFields('poly',{registration:{value:'000012345678'},password:{value:'NEVER'},otp:{value:'NEVER'},captcha:{value:'NEVER'},cookies:{value:'NEVER'},txt_std_accno_Re:{value:'NEVER'}});
  assert.deepEqual(Object.keys(fields),['password','registration']);assert.equal(fields.password.value,'NEVER');
  assert.equal(POLY_SECTIONS.fee.fields[0].defaultValue,'11010');
});

test('Fresh academic schema asks one High School row and leaves the unused Intermediate row blank',()=>{
  const fields=POLY_SECTIONS.academic.fields;
  const highSchool=fields.find(field=>field.key==='Gridview1_grid_txt_Obtain_0');
  assert.equal(highSchool.label,'High-school obtained marks');
  assert.equal(fields.some(field=>field.key==='Gridview1_grid_txt_Obtain_1'),false);
  assert.equal(POLY_IGNORED_EMPTY_FIELDS.length,7);
  assert.ok(POLY_IGNORED_EMPTY_FIELDS.includes('Gridview1_grid_txt_Obtain_1'));
  assert.equal(fields.find(field=>field.key==='Gridview1_grid_txt_TotalMarks_0').defaultValue,'600');
});

test('OTNew-Poly visible test mode is consumed once and leaves other sessions headless',()=>{
  const headless=createPolyHeadlessResolver({OTNEW_POLY_VISIBLE_ONCE:'true',HEADLESS:'true'});
  assert.equal(headless(),false);assert.equal(headless(),true);assert.equal(headless(),true);
  const ordinary=createPolyHeadlessResolver({HEADLESS:'true'});assert.equal(ordinary(),true);
  const globalVisible=createPolyHeadlessResolver({HEADLESS:'false'});assert.equal(globalVisible(),false);assert.equal(globalVisible(),false);
});

test('Menu is gated; authorized private users only; cancel and expiry close browser',async t=>{
  const f=await fixture(t,{enabled:false});await f.say('/start');await f.say('3');assert.match(f.sent.at(-1).text,/disabled/);assert.equal(f.counts().opens,0);
  f.router.enablePoly=true;await f.login();assert.equal(f.poly.sessions.get(99).phase,'confirm');
  const before=f.sent.length;await f.say('CONFIRM',{chat:{id:99,type:'group'}});assert.equal(f.sent.length,before);
  await f.say('/cancel');assert.equal(f.poly.sessions.size,0);assert.ok(f.counts().closed);
  await f.login();f.advance(21*60_000);await f.router.expire();assert.equal(f.poly.sessions.size,0);
});

test('All form actions ask Fresh or Renewal before credentials and retain the selected type',async t=>{
  const f=await fixture(t);
  for(const operation of ['1','2','3']) for(const type of ['Fresh','Renewal']) for(const route of ['sc-st-general','obc']) {
    await f.say('/start');await f.say('3');await f.say(operation);
    assert.equal(f.poly.sessions.get(99).phase,'type');
    assert.deepEqual(f.sent.at(-1).options.reply_markup.keyboard[0],['Fresh','Renewal']);
    const opens=f.counts().opens;
    await f.say('000012345678');assert.equal(f.poly.sessions.get(99).phase,'type');assert.equal(f.counts().opens,opens);
    const choice=f.message(type.toLowerCase());await Promise.all([f.router.handle(choice),f.router.handle(choice)]);
    assert.equal(f.poly.sessions.get(99).phase,'category');assert.equal(f.counts().opens,opens);
    await f.say('invalid');assert.equal(f.poly.sessions.get(99).phase,'category');
    const category=f.message(route==='obc'?'2. OBC':'1. SC / ST / General');await Promise.all([f.router.handle(category),f.router.handle(category)]);
    assert.equal(f.poly.sessions.get(99).index,0);assert.match(f.sent.at(-1).text,/Registration number/);
    for(const value of ['000012345678','UP26-0000000001','TemporarySecret1@','AbC12']) await f.say(value);
    assert.equal(f.portalTypes.at(-1),type);assert.equal(f.counts().opens,opens+1);
    assert.equal(f.portalRoutes.at(-1),route);
    const fields=f.poly.savedFields(f.poly.sessions.get(99));assert.equal(fields.applicationType.value,type);assert.equal(fields.password,undefined);
    assert.equal(fields.categoryRoute.value,route);assert.equal((await f.store.get(f.poly.sessions.get(99).savedId,99)).fields.categoryRoute.value,route);
  }
  await f.say('/menu');await f.say('3');await f.say('1');await f.say('/cancel');assert.equal(f.poly.sessions.size,0);
});

test('Encrypted saved-user profile derives two-digit command, hides password, reuses details without logging in twice',async t=>{
  const f=await fixture(t,{defaultProfilePassword:'DefaultOnly@1'});
  await f.say('/saveuser');await f.say('UP26-0000000085');await f.say('000012345678');await f.say('USE DEFAULT PASSWORD');
  let record=await f.store.findByField({userId:99,module:'poly',key:'profileSuffix',value:'85'});
  assert.equal(record.fields.registration.value,'000012345678');assert.equal(record.fields.otr.value,'UP26-0000000085');assert.equal(record.fields.password.value,'DefaultOnly@1');
  const raw=await readFile(join(f.root,'records',record.id+'.enc'),'utf8');assert.doesNotMatch(raw,/DefaultOnly@1|000012345678|UP26-0000000085/);
  await f.say(`/save ${record.id}`);const savedView=f.sent.findLast(message=>message.text?.includes(`${record.id} — Draft`));assert.match(savedView.text,/saved encrypted; hidden/);assert.doesNotMatch(savedView.text,/DefaultOnly@1/);
  await f.say('/saveuser85');assert.equal(f.router.sessions.get(99).module,'menu');
  await f.say('3');await f.say('1');assert.equal(f.poly.sessions.get(99).phase,'type');await f.say('Renewal');await f.say('OBC');
  assert.doesNotMatch(f.sent.at(-1).text,/DefaultOnly@1/);
  assert.equal(f.poly.sessions.get(99).phase,'login-captcha');
  assert.equal(f.poly.sessions.get(99).credentials.password,'DefaultOnly@1');
  await f.say('AbC12');
  assert.equal(f.portalTypes.at(-1),'Renewal');
  assert.equal(f.portalRoutes.at(-1),'obc');
  assert.equal(f.lastLogin().registration,'000012345678');assert.equal(f.lastLogin().otr,'UP26-0000000085');assert.equal(f.lastLogin().password,'DefaultOnly@1');
  await f.say('/cancel');assert.equal(f.poly.sessions.size,0);
});

test('Starting saved-user entry clears an unfinished portal session before accepting another candidate',async t=>{
  const f=await fixture(t);await f.login();const before=f.counts();
  await f.say('/saveuser');
  assert.equal(f.poly.sessions.size,0);assert.equal(f.saves.hasUserProfile(99),true);
  assert.ok(f.counts().closed>before.closed);assert.equal(f.counts().submits,before.submits);
  await f.say('/cancel');
});

test('Saved OBC route is displayed; switching route clears form answers but keeps login identity',async t=>{
  const f=await fixture(t);await f.login('1','Fresh','OBC');
  const id=f.poly.sessions.get(99).savedId;
  await f.say(`/reuse ${id}`);await f.say('1');await f.say('Fresh');assert.match(f.sent.at(-1).text,/Saved route: OBC/);
  await f.say('2');assert.equal(f.poly.sessions.get(99).reuse.txt_refundAmt.value,'11010');
  await f.say(`/reuse ${id}`);await f.say('1');await f.say('Renewal');await f.say('1');
  const s=f.poly.sessions.get(99);assert.equal(s.reuse.txt_refundAmt,undefined);assert.equal(s.reuse.registration.value,'000012345678');
  await f.say('/cancel');assert.equal(f.poly.sessions.size,0);
});

test('OBC extra answers save encrypted and appear with labels in the owner saved view',async t=>{
  const f=await fixture(t);await f.login('1','Fresh','OBC');const s=f.poly.sessions.get(99);
  const answers={txt_fstyr_addmissiondt:'01/08/2026',txt_currentsessiondate:'01/08/2026',txt_UniBrdRegno:'E00000000000001',rb_regidancestdnt:'day'};
  for(const [key,value] of Object.entries(answers)) s.portal.answers.set(key,{value,display:key==='rb_regidancestdnt'?'दिवा छात्र':value});
  await f.poly.checkpoint(99,{ready:true});const record=await f.store.get(s.savedId,99);
  for(const [key,value] of Object.entries(answers)) assert.equal(record.fields[key].value,value);
  assert.doesNotMatch(await readFile(join(f.root,'records',record.id+'.enc'),'utf8'),/01\/08\/2026|E00000000000001/);
  await f.say(`/save ${record.id}`);const view=f.sent.filter(m=>m.text).map(m=>m.text).join('\n');
  assert.match(view,/Student enrolment number/);assert.match(view,/Day scholar \/ Residential student/);assert.doesNotMatch(view,/undefined:/);
});

test('Telegram asks both dates, offers the first date explicitly, and accepts residence selection before review',async t=>{
  const f=await fixture(t),fields=structuredClone(OBC_EXTRA_FIELDS);let index=0,fills=0;
  fields[1]={...fields[1],sameAs:'txt_fstyr_addmissiondt',suggestion:'01/08/2026',note:'Course year is 1/3: this must match question 15.'};
  fields[3].options=[{value:'day',label:'दिवा छात्र'},{value:'resident',label:'आवासीय छात्र'}];
  const next=()=>index<fields.length?{kind:'field',stage:'academic',field:fields[index],token:index+1}:{kind:'review',stage:'academic',review:['Synthetic OBC review'],token:5};
  f.step(next());await f.login('1','Fresh','OBC');const s=f.poly.sessions.get(99);
  s.portal.values=()=>Object.fromEntries([...s.portal.answers].map(([key,answer])=>[key,answer.value]));
  s.portal.fill=async(field,value)=>{fills++;s.portal.answers.set(field.key,{value,display:field.options?.find(o=>o.value===value)?.label||value});index++;return next();};
  await f.say('31/02/2026');assert.equal(fills,0);
  await f.say('01/08/2026');assert.equal(fills,1);assert.match(f.sent.at(-1).text,/16\. Current-session/);
  assert.match(f.sent.at(-1).text,/must match question 15/);assert.ok(f.sent.at(-1).options.reply_markup.keyboard.some(row=>row.includes('USE DEFAULT')));
  await f.say('02/08/2026');assert.equal(fills,1);assert.match(f.sent.at(-1).text,/same date/);
  await f.say('USE DEFAULT');assert.equal(fills,2);assert.match(f.sent.at(-1).text,/17\. Student enrolment/);
  await f.say('E123');assert.equal(fills,2);
  await f.say('e00000000000001');assert.match(f.sent.at(-1).text,/18\. Day scholar/);
  await f.say('2. आवासीय छात्र');assert.equal(s.phase,'confirm');assert.equal(fills,4);assert.equal(f.counts().submits,0);
  const record=await f.store.get(s.savedId,99);assert.equal(record.fields.txt_currentsessiondate.value,'01/08/2026');assert.equal(record.fields.txt_UniBrdRegno.value,'E00000000000001');assert.equal(record.fields.rb_regidancestdnt.value,'resident');
});

const examinationField=()=>({...OBC_SECTIONS.academic.fields.find(field=>field.key==='ddl_uptu_type'),options:[{value:'jee-live',label:'JEECUP'},{value:'neet-live',label:'NEET'}],suggestion:'jee-live'});

test('OBC Telegram prompts Group 4 then Electrical Engineering explicitly and saves both in review',async t=>{
  const keys=['ddl_CourseName','ddl_CurrentCourse_Branch'];
  const live=[[{value:'course3-live',label:'Diploma Engg (Group3)'},{value:'course4-live',label:'Diploma In Engg. 3 Yrs (Group 4)'}],[{value:'cs-live',label:'Diploma in Computer Science & Engg.'},{value:'electrical-live',label:'Electrical Engineering'}]];
  const fields=keys.map((key,index)=>{const field=OBC_SECTIONS.academic.fields.find(field=>field.key===key),options=filterObcOptions(field,live[index]);return {...field,options,suggestion:preferredObcValue(field,options)};});
  let index=0;const fills=[],step=()=>({kind:'field',stage:'academic',field:fields[index],token:index+1});
  const f=await fixture(t,{chooseStep:step,configurePortal:portal=>{
    portal.sections=OBC_SECTIONS;
    portal.fill=async(field,value)=>{fills.push(value);portal.answers.set(field.key,{value,display:field.options.find(option=>option.value===value).label});index++;return index<2?step():{kind:'review',stage:'academic',review:[...portal.answers].filter(([key])=>keys.includes(key)).map(([,answer])=>answer.display),token:3};};
  }});
  await f.login('1','Fresh','OBC');assert.equal(f.poly.sessions.get(99).phase,'questions');assert.match(f.sent.at(-1).text,/Default: Diploma In Engg\. 3 Yrs \(Group 4\)/);assert.deepEqual(fills,[]);
  await f.say('USE DEFAULT');assert.equal(f.poly.sessions.get(99).phase,'questions');assert.match(f.sent.at(-1).text,/Default: Electrical Engineering/);
  await f.say('USE DEFAULT');assert.deepEqual(fills,['course4-live','electrical-live']);const s=f.poly.sessions.get(99);assert.equal(s.phase,'confirm');
  const record=await f.store.get(s.savedId,99);assert.equal(record.fields.ddl_CourseName.value,'course4-live');assert.equal(record.fields.ddl_CurrentCourse_Branch.label,'Electrical Engineering');assert.equal(f.counts().submits,0);
});

test('OBC automatically selects live JEECUP, saves it for review, and lets /edit override it',async t=>{
  const field=examinationField(),step={kind:'field',stage:'academic',field,token:1},fills=[];
  const f=await fixture(t,{chooseStep:()=>step,configurePortal:portal=>{
    portal.sections=OBC_SECTIONS;
    portal.fill=async(answer,value)=>{
      fills.push(value);const display=field.options.find(option=>option.value===value).label;
      portal.answers.set(answer.key,{value,display});return {kind:'review',stage:'academic',review:[field.label+': '+display],token:2};
    };
    portal.edit=async key=>{assert.equal(key,field.key);portal.answers.delete(key);return step;};
  }});
  await f.login('1','Fresh','OBC');const s=f.poly.sessions.get(99);
  assert.equal(s.phase,'confirm');assert.deepEqual(fills,['jee-live']);assert.equal(f.counts().submits,0);
  assert.ok(f.sent.some(message=>message.text==='Counselling examination: JEECUP'||message.text?.includes('Review academic:\nCounselling examination: JEECUP')));
  assert.equal((await f.store.get(s.savedId,99)).fields.ddl_uptu_type.value,'jee-live');
  assert.equal(f.sent.some(message=>message.text?.includes('Choose a listed option.')),false);
  await f.say('/edit');await f.say(String(OBC_SECTIONS.academic.fields.filter(answer=>!answer.computed).findIndex(answer=>answer.key===field.key)+1));
  assert.equal(s.phase,'questions');assert.deepEqual(fills,['jee-live']);
  await f.say('2. NEET');assert.equal(s.phase,'confirm');assert.deepEqual(fills,['jee-live','neet-live']);
  assert.equal((await f.store.get(s.savedId,99)).fields.ddl_uptu_type.label,'NEET');assert.equal(f.counts().submits,0);
});

test('OBC chains fixed defaults and stops at the next applicant-specific question',async t=>{
  const questions=[examinationField(),{...OBC_SECTIONS.academic.fields.find(field=>field.key==='ddl_aktu_councilling_year'),options:[{value:'year-live',label:'2026'}],suggestion:'year-live'},OBC_EXTRA_FIELDS[0]];
  let index=0;const fills=[],next=()=>({kind:'field',stage:'academic',field:questions[index],token:index+1});
  const f=await fixture(t,{chooseStep:next,configurePortal:portal=>{portal.fill=async(field,value)=>{fills.push([field.key,value]);index++;return next();};}});
  await f.login('1','Fresh','OBC');
  assert.deepEqual(fills,[['ddl_uptu_type','jee-live'],['ddl_aktu_councilling_year','year-live']]);
  assert.equal(f.poly.sessions.get(99).phase,'questions');assert.match(f.sent.at(-1).text,/15\. First-year admission date/);
  assert.equal(f.sent.filter(message=>message.text?.startsWith('Applying fixed defaults')).length,1);assert.equal(f.counts().submits,0);
});

test('A portal-discarded manual edit never resets the user choice to JEECUP automatically',async t=>{
  const field=examinationField(),step={kind:'field',stage:'academic',field,token:1},fills=[];
  const f=await fixture(t,{chooseStep:()=>step,configurePortal:portal=>{
    portal.sections=OBC_SECTIONS;
    portal.edit=async()=>step;
    portal.fill=async(answer,value)=>{fills.push(value);return fills.length===1?{kind:'review',stage:'academic',review:['Counselling examination: JEECUP'],token:2}:step;};
  }});
  await f.login('1','Fresh','OBC');await f.say('/edit');
  await f.say(String(OBC_SECTIONS.academic.fields.filter(answer=>!answer.computed).findIndex(answer=>answer.key===field.key)+1));
  await f.say('2');assert.deepEqual(fills,['jee-live','neet-live']);
  assert.equal(f.poly.sessions.get(99).phase,'questions');assert.equal(f.counts().submits,0);
});

test('Missing defaults and portal-discarded defaults become manual questions without repeated automatic filling',async t=>{
  for(const missing of [true,false]) {
    const field=examinationField();if(missing) {field.suggestion=undefined;field.options=field.options.filter(option=>option.label!=='JEECUP');}
    const step={kind:'field',stage:'academic',field,token:1};let fills=0;
    const f=await fixture(t,{chooseStep:()=>step,configurePortal:portal=>{portal.fill=async()=>{fills++;return step;};}});
    await f.login('1','Fresh','OBC');
    assert.equal(f.poly.sessions.get(99).phase,'questions');assert.equal(fills,missing?0:1);
    assert.match(f.sent.at(-1).text,/Counselling examination/);assert.equal(f.counts().submits,0);
    await f.say('/cancel');assert.equal(f.poly.sessions.size,0);assert.ok(f.counts().closed);
  }
});

test('SC/ST/General default suggestions remain manual choices',async t=>{
  const field={...POLY_SECTIONS.academic.fields.find(field=>field.key==='ddl_uptu_type'),options:[{value:'jee-live',label:'JEECUP'}],suggestion:'jee-live'};let fills=0;
  const f=await fixture(t,{chooseStep:()=>({kind:'field',stage:'academic',field,token:1}),configurePortal:portal=>{portal.fill=async()=>{fills++;return {kind:'review',stage:'academic',review:['Counselling examination: JEECUP'],token:2};};}});
  await f.login();assert.equal(f.poly.sessions.get(99).phase,'questions');assert.equal(fills,0);
  await f.say('USE DEFAULT');assert.equal(fills,1);assert.equal(f.poly.sessions.get(99).phase,'confirm');
});

test('Saved-user custom passwords, suffix collisions, cancellation, expiry and ownership are safe',async t=>{
  const f=await fixture(t,{defaultProfilePassword:'DefaultOnly@1'});
  await f.say('/saveuser');await f.say('UP26-0000000085');await f.say('000012345678');await f.say('OTHER PASSWORD');await f.say('CustomSecret!');
  const profile=await f.store.findByField({userId:99,module:'poly',key:'profileSuffix',value:'85'});assert.equal(profile.fields.password.value,'CustomSecret!');
  await f.say('/saveuser');await f.say('UP26-0000000185');await f.say('000099999999');await f.say('OTHER PASSWORD');await f.say('DoNotOverwrite!');
  assert.match(f.sent.at(-1).text,/already belongs to a different OTR/);assert.equal((await f.store.get(profile.id,99)).fields.password.value,'CustomSecret!');
  const before=f.sent.length;await f.say('/saveuser85',{from:{id:42},chat:{id:42,type:'private'}});assert.match(f.sent.at(-1).text,/No complete saved profile/);assert.ok(f.sent.slice(before).every(message=>!message.text?.includes('CustomSecret!')));
  await f.say('/saveuser');await f.say('/cancel');assert.equal(f.saves.hasUserProfile(99),false);
  await f.say('/saveuser');f.advance(21*60_000);await f.router.expire();assert.equal(f.saves.hasUserProfile(99),false);
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
  await f.say('3');assert.equal(f.poly.sessions.get(99).phase,'type');assert.deepEqual(f.poly.sessions.get(99).credentials,{});assert.equal(await f.poly.checkpoint(99),undefined);
  await f.say('/cancel');await f.store.init();await f.say(`/save ${id}`);assert.ok(f.sent.some(m=>m.name?.endsWith('.pdf')));
  await f.say(`/reuse ${id}`);assert.equal(f.poly.sessions.get(99).phase,'poly-menu');assert.equal(f.counts().submits,0);
  await f.say('3');assert.match(f.sent.at(-1).text,/Previously saved: Fresh/);
  await f.say('Renewal');assert.equal(f.poly.sessions.get(99).applicationType,'Renewal');assert.equal(f.counts().opens,counts.opens);
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
    for(const answer of ['/start','3','2','Fresh','1',registration,'UP26-0000000001','TemporarySecret1@','AbC12']) await f.say(answer,extra);
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
