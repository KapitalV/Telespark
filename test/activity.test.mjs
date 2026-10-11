import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,appendFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {ActivityLog,activityDay,formatActivity,loggedPortal} from '../activity.mjs';
import {AccessStore} from '../access.mjs';
import {RecoveryBot} from '../core.mjs';
import {OtrBot} from '../otr-core.mjs';
import {RegistrationBot} from '../registration-core.mjs';
import {BotRouter} from '../router.mjs';

async function fixture(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'telespark-activity-test-'));
  t.after(async()=>{
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));
    assert.ok(basename(root).startsWith('telespark-activity-test-'));
    await rm(root,{recursive:true,force:true});
  });
  let now=Date.parse('2026-10-11T18:29:50Z');
  const activity=new ActivityLog({directory:join(root,'activity'),clock:()=>now,...options});await activity.init();
  return {root,activity,clock:()=>now,advance:ms=>{now+=ms;}};
}

test('Daily files persist across restart, rotate at IST midnight and filter actor or affected user',async t=>{
  const f=await fixture(t);
  await Promise.all(Array.from({length:40},(_,i)=>f.activity.record({event:'message',userId:99,messageId:i+1,action:'/start'})));
  f.advance(20_000);
  await f.activity.record({event:'access_changed',userId:42,targetUserId:99,action:'revoke',result:'changed'});
  await f.activity.record({event:'message',userId:100,action:'/id'});
  const reloaded=new ActivityLog({directory:f.activity.directory,clock:f.clock});await reloaded.init();
  const recent=await reloaded.recent({userId:'99',limit:3});
  assert.deepEqual(recent.map(e=>e.event),['access_changed','message','message']);
  assert.equal(recent[1].messageId,40);assert.equal(recent[2].messageId,39);
  assert.deepEqual((await readdir(f.activity.directory)).filter(n=>n.startsWith('2026-10-1')).sort(),['2026-10-11.jsonl','2026-10-12.jsonl']);
  assert.equal(activityDay('2026-10-11T18:30:00Z'),'2026-10-12');
  assert.match(formatActivity(recent[0]),/12\/10\/2026, 00:00:10 IST/);
});

test('Log projection and exports exclude raw messages, personal values, URLs, screenshots and errors',async t=>{
  const {activity}=await fixture(t);
  const secret='NEVER_LOG_THIS_SECRET';
  await activity.record({event:'portal_result',userId:99,result:'success',module:'password',message:secret,password:secret,otp:secret,details:{mobile:secret},image:Buffer.from(secret),reason:secret,field:secret,action:secret,error:new Error(secret)});
  const day='2026-10-11';
  // Even manually introduced extra fields are dropped when queried/exported.
  await appendFile(join(activity.directory,day+'.jsonl'),JSON.stringify({time:'2026-10-11T18:29:51.000Z',event:'handled',userId:'99',password:secret,action:'/result'})+'\n');
  const exported=await activity.exportDay(day);
  assert.doesNotMatch(exported.bytes.toString(),/NEVER_LOG/);
  assert.doesNotMatch(JSON.stringify(await activity.recent()),/NEVER_LOG/);
  const first=JSON.parse((await readFile(join(activity.directory,day+'.jsonl'),'utf8')).split('\n')[0]);
  assert.deepEqual(Object.keys(first).sort(),['event','module','result','time','userId','version']);
  assert.equal(exported.filename,'activity-2026-10-11.jsonl');
});

test('Damaged trailing record is isolated after restart; disk failures are explicit and do not retain values',async t=>{
  const warnings=[];const f=await fixture(t,{onError:message=>warnings.push(message)});
  await appendFile(join(f.activity.directory,'2026-10-11.jsonl'),'{"unfinished":');
  const restarted=new ActivityLog({directory:f.activity.directory,clock:f.clock});await restarted.init();
  await restarted.record({event:'bot_started',module:'system'});
  assert.equal((await restarted.recent()).length,1);
  assert.equal(restarted.hadReadFailure,true);
  const broken=join(f.root,'not-a-directory');await writeFile(broken,'x');
  f.activity.directory=broken;
  assert.equal(await f.activity.record({event:'message',userId:99,text:'PRIVATE'}),false);
  assert.equal(await f.activity.record({event:'message',userId:99}),false);
  assert.equal(f.activity.hadWriteFailure,true);assert.equal(warnings.length,1);assert.doesNotMatch(warnings[0],/PRIVATE/);
  await assert.rejects(new ActivityLog({directory:broken}).init());
});

test('Queries and exports bound counts/size and reject path traversal, invalid dates and IDs',async t=>{
  const {activity}=await fixture(t,{maxExportBytes:20});
  await activity.record({event:'bot_started'});
  for(const date of ['../authorized-users','2026-02-30','2026-1-1']) await assert.rejects(activity.exportDay(date),/real date/);
  for(const limit of [0,101,NaN,1.5]) await assert.rejects(activity.recent({limit}),/1 to 100/);
  await assert.rejects(activity.recent({userId:'@name'}));
  await assert.rejects(activity.exportDay('2026-10-11'),/too large/);
});

test('Portal wrapper preserves calls and classified outcomes without logging arguments or raw errors',async t=>{
  const {activity}=await fixture(t);const secret='Private1@';
  const target={value:secret,answers:new Map(),open:async()=>Buffer.from(secret),async submit(value){assert.equal(this.value,secret);assert.equal(value,secret);return {kind:'success',password:secret,registration:'000012345678'};},async refresh(){throw Error(secret);},close:async()=>{}};
  const portal=loggedPortal(target,activity,{userId:99,module:'password'});
  assert.equal(portal.answers,target.answers);
  await portal.open({secret});assert.equal((await portal.submit(secret)).password,secret);
  await assert.rejects(portal.refresh(),/Private1@/);
  const entries=await activity.recent();
  assert.equal(entries.filter(e=>e.event==='portal_started').length,3);
  assert.ok(entries.some(e=>e.result==='success'));
  assert.ok(entries.some(e=>e.event==='portal_error'));
  assert.doesNotMatch(JSON.stringify(entries),/Private1|000012345678/);
});

async function chat(t) {
  const f=await fixture(t);
  const access=new AccessStore({adminId:'42',path:join(f.root,'users.json')});await access.load();await access.change(42,99,true);
  let incoming=1,outgoing=100;const sent=[];
  const telegram={send:async(id,text,options)=>{sent.push({id,text,options});return {message_id:outgoing++};},photo:async(id,image,text)=>{sent.push({id,image,text});return {message_id:outgoing++};},document:async(id,bytes,filename,text)=>{sent.push({id,bytes,filename,text});}};
  const canUse=id=>access.canUse(id);
  const recovery=new RecoveryBot({telegram,canUse,allowedUserId:'42',clock:f.clock,portalFactory:userId=>loggedPortal({open:async()=>Buffer.from('image'),close:async()=>{},submit:async()=>({kind:'success',registration:'000012345678',password:'Private1@',slip:Buffer.from('private slip')})},f.activity,{userId,module:'password'})});
  const form={kind:'form',fields:[{key:'mobile',label:'Mobile',type:'mobile'}],action:{kind:'send-otp'},fingerprint:'f'};
  const otr=new OtrBot({telegram,canUse,clock:f.clock,portalFactory:(_mode,userId)=>loggedPortal({open:async()=>form,close:async()=>{}},f.activity,{userId,module:'otr'})});
  const registration=new RegistrationBot({telegram,canUse,clock:f.clock,portalFactory:userId=>loggedPortal({open:async()=>({...form,fields:[{key:'otr',type:'otr',label:'OTR'}]}),close:async()=>{}},f.activity,{userId,module:'registration'})});
  const router=new BotRouter({telegram,recovery,otr,registration,access,activity:f.activity,enableOtr:true,clock:f.clock});
  const message=(id,text,extra={})=>({from:{id},chat:{id,type:'private'},message_id:incoming++,text,...extra});
  return {...f,access,recovery,otr,registration,router,sent,message,say:(id,text,extra)=>router.handle(message(id,text,extra))};
}

test('Admin alone reads/exports logs; all users are tracked, duplicates ignored and replies are bounded',async t=>{
  const f=await chat(t);
  await f.say(99,'/start');await f.say(99,'/log');assert.match(f.sent.at(-1).text,/Only the admin/);
  await f.say(100,'/log export 2026-10-11');assert.match(f.sent.at(-1).text,/restricted/);
  assert.equal(f.sent.filter(m=>m.filename).length,0);
  const duplicate=f.message(99,'/help');await f.router.handle(duplicate);await f.router.handle(duplicate);
  await f.say(99,undefined,{photo:[{file_id:'DO_NOT_LOG'}]});
  await f.say(42,'/adduser 100');await f.say(42,'/removeuser 100');
  await f.say(42,'/log 100');
  assert.ok(f.sent.some(m=>m.text.includes('target:100')));
  assert.ok(f.sent.some(m=>m.text.includes('reason:admin-only')));
  assert.ok(f.sent.every(m=>m.text.length<=4096));
  await f.say(42,'/log user 99 5');assert.match(f.sent.at(-1).text,/User 99/);
  await f.say(42,'/log export 2026-10-11');assert.equal(f.sent.at(-1).filename,'activity-2026-10-11.jsonl');
  assert.ok(f.sent.at(-1).bytes.length);assert.doesNotMatch(f.sent.at(-1).bytes.toString(),/DO_NOT_LOG/);
  const before=(await f.activity.recent({limit:100})).length;
  await f.say(42,'/log',{chat:{id:-1,type:'group'}});
  assert.equal((await f.activity.recent({limit:100})).length,before);
  await f.say(42,'/log ../secret');assert.match(f.sent.at(-1).text,/Could not read/);
  await f.say(42,'/log user 99 1000');assert.match(f.sent.at(-1).text,/Could not read/);
});

test('Recovery stages/results, cancellation, expiry and other modules are logged without applicant values',async t=>{
  const f=await chat(t);
  for(const text of ['/start','1','Fresh','000012345678','9876543210','CBSE BOARD','2021','000012345','AbC12','/result','/cancel']) await f.say(99,text);
  await f.say(99,'/otr');await f.say(99,'1');await f.say(99,'/menu');
  await f.say(99,'2');await f.say(99,'2');f.advance(21*60_000);await f.router.expire();
  const entries=await f.activity.recent({limit:100});const text=JSON.stringify(entries);
  for(const secret of ['000012345678','9876543210','000012345','AbC12','Private1@','private slip']) assert.ok(!text.includes(secret));
  assert.ok(entries.some(e=>e.module==='password' && e.result==='success'));
  assert.ok(entries.some(e=>e.action==='/cancel'));
  for(const module of ['password','otr','registration']) assert.ok(entries.some(e=>e.module===module && e.event==='portal_started'));
  assert.ok(entries.some(e=>e.event==='session_expired' && e.userId==='99'));
  assert.ok(entries.some(e=>e.field==='mobile'));
});

test('Delivery failure is recorded, result stays available, and /result causes no second portal submit',async t=>{
  const f=await chat(t);
  for(const text of ['/start','1','Fresh','000012345678','9876543210','UP BOARD','2021','000012345']) await f.say(99,text);
  const original=f.router.telegram.document;f.router.telegram.document=async()=>{throw Error('PRIVATE_RAW_ERROR');};
  await assert.rejects(f.say(99,'AbC12'));
  f.router.telegram.document=original;await f.say(99,'/result');
  const entries=await f.activity.recent({limit:100});
  assert.ok(entries.some(e=>e.event==='handled' && e.result==='failed'));
  assert.equal(entries.filter(e=>e.event==='portal_started' && e.action==='submit').length,1);
  assert.doesNotMatch(JSON.stringify(entries),/PRIVATE_RAW_ERROR/);
});
