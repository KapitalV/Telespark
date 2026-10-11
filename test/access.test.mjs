import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {AccessStore,telegramUserId} from '../access.mjs';
import {RecoveryBot} from '../core.mjs';
import {OtrBot} from '../otr-core.mjs';
import {RegistrationBot} from '../registration-core.mjs';
import {BotRouter} from '../router.mjs';

async function store(t) {
  const root=await mkdtemp(join(tmpdir(),'telespark-access-test-'));
  t.after(async()=>{
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));
    assert.ok(basename(root).startsWith('telespark-access-test-'));
    await rm(root,{recursive:true,force:true});
  });
  const access=new AccessStore({adminId:'42',path:join(root,'users.json')});await access.load();return {access,root};
}

test('Admin access changes persist, serialize, validate IDs and cannot remove the admin',async t=>{
  const {access}=await store(t);
  assert.equal(access.canUse('99'),false);assert.equal(access.canUse('42'),true);
  await assert.rejects(access.change('99','100',true),/Only the admin/);
  await Promise.all([access.change('42','99',true),access.change('42','100',true)]);
  assert.equal(await access.change('42','99',true),false);
  const reloaded=new AccessStore({adminId:'42',path:access.path});await reloaded.load();
  assert.deepEqual(reloaded.list(),['99','100']);
  await assert.rejects(reloaded.change('42','42',false),/cannot be removed/);
  await reloaded.change('42','99',false);assert.equal(reloaded.canUse('99'),false);
  for(const id of ['@someone','0','-42','99 100','099','9007199254740992']) assert.throws(()=>telegramUserId(id));
});

test('Damaged access file and failed writes cannot grant permission',async t=>{
  const {access,root}=await store(t);
  await writeFile(access.path,'not JSON');await assert.rejects(access.load(),/Cannot read/);
  const directory=join(root,'directory');await mkdir(directory);
  const broken=new AccessStore({adminId:'42',path:directory});
  await assert.rejects(broken.change('42','99',true),/permissions were not changed/);
  assert.equal(broken.canUse('99'),false);
  const setup=new AccessStore({adminId:''});setup.users.add('99');assert.equal(setup.canUse('99'),false);
});

function botFixture(access) {
  const sent=[];let incoming=1,outgoing=100;
  const telegram={send:async(id,text,options)=>{sent.push({id,text,options});return {message_id:outgoing++};},photo:async(id,image,text)=>{sent.push({id,image,text});return {message_id:outgoing++};},document:async()=>{}};
  const canUse=id=>access.canUse(id);
  const portal={open:async()=>Buffer.from('image'),close:async()=>{},submit:async()=>({kind:'unknown'})};
  const recovery=new RecoveryBot({telegram,allowedUserId:'42',canUse,portalFactory:()=>({...portal})});
  const form={kind:'form',stage:'mobile',fields:[{key:'mobile',type:'mobile',label:'Mobile'}],action:{kind:'send-otp'},fingerprint:'f'};
  const otr=new OtrBot({telegram,allowedUserId:'42',canUse,portalFactory:()=>({open:async()=>form,close:async()=>{}})});
  const registration=new RegistrationBot({telegram,allowedUserId:'42',canUse,portalFactory:()=>({open:async()=>({...form,fields:[{key:'route',type:'choice',label:'Department',options:[{label:'OBC',value:'1'}]}]}),close:async()=>{}})});
  const router=new BotRouter({telegram,recovery,otr,registration,access,allowedUserId:'42',enableOtr:true});
  const message=(id,text,extra={})=>({message_id:incoming++,chat:{id,type:'private'},from:{id},text,...extra});
  return {router,recovery,otr,registration,sent,say:(id,text,extra)=>router.handle(message(id,text,extra))};
}

test('Only admin grants/revokes; allowed users reach every module with isolated sessions',async t=>{
  const {access}=await store(t);const f=botFixture(access);
  await f.say(99,'/start');assert.match(f.sent.at(-1).text,/restricted/);
  await f.say(99,'/id');assert.match(f.sent.at(-1).text,/99/);
  await f.say(42,'/adduser 99');assert.equal(access.canUse(99),true);
  await f.say(42,'/users');assert.match(f.sent.at(-1).text,/Admin: 42\nAllowed users: 1\n99/);
  await f.say(99,'/adduser 100');assert.match(f.sent.at(-1).text,/Only the admin/);assert.equal(access.canUse(100),false);
  await f.say(99,'/users');assert.match(f.sent.at(-1).text,/Only the admin/);
  for(const id of [42,99]) {await f.say(id,'/start');await f.say(id,'1');}
  assert.notEqual(f.recovery.sessions.get(42),f.recovery.sessions.get(99));
  await f.say(99,'Fresh');assert.equal(f.recovery.sessions.get(42).details.applicationType,undefined);
  await f.say(99,'/otr');await f.say(99,'1');assert.equal(f.otr.sessions.get(99).phase,'questions');
  await f.say(99,'/otr');await f.say(99,'2');assert.equal(f.registration.sessions.get(99).phase,'questions');
  await f.say(99,'/search OBC');assert.match(f.sent.at(-1).text,/OBC/);
  await f.say(42,'/removeuser 99');assert.equal(access.canUse(99),false);assert.equal(f.registration.sessions.has(99),false);
  await f.say(99,'/result');assert.match(f.sent.at(-1).text,/restricted/);
  await f.say(42,'/adduser 100',{chat:{id:42,type:'group'}});assert.equal(access.canUse(100),false);
});

test('Revoking a user suppresses delivery from an already in-flight recovery',async t=>{
  const {access}=await store(t);await access.change(42,99,true);const f=botFixture(access);
  for(const text of ['/start','1','Renewal','000123456789','01/01/2000','UP BOARD','2021','000012345']) await f.say(99,text);
  assert.deepEqual(f.sent.find(m=>m.options?.reply_markup)?.options.reply_markup.keyboard,[['1. Password recovery'],['2. OTR']]);
  assert.ok(f.sent.some(m=>JSON.stringify(m.options?.reply_markup?.keyboard)===JSON.stringify([['UP BOARD','CBSE BOARD']])));
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  f.recovery.sessions.get(99).portal.submit=()=>pending;
  const submission=f.say(99,'AbC12');
  await new Promise(resolve=>setImmediate(resolve));
  await f.say(42,'/removeuser 99');finish({kind:'success',registration:'000123456789',password:'Private1@'});await submission;
  assert.ok(!f.sent.some(m=>m.text?.includes('Private1@')));
});
