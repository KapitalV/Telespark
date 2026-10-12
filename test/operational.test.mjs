import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BotRouter} from '../router.mjs';
import {safeActivity} from '../activity.mjs';

test('Local tests acknowledge, log, reject malformed arguments, alert admin, and suppress duplicate messages',async()=>{
  const sent=[],logs=[];
  const router=new BotRouter({telegram:{send:async(id,text)=>{sent.push({id,text});}},allowedUserId:'42',enablePoly:true,activity:{record:async value=>logs.push(value)}});
  const msg=(message_id,text)=>({message_id,from:{id:42},chat:{id:42,type:'private'},text});
  await router.handle(msg(1,'/test'));
  assert.equal(JSON.parse(sent[0].text).status,'200 OK');assert.equal(JSON.parse(sent[0].text).portalVerified,false);
  await router.handle(msg(1,'/test'));assert.equal(sent.length,1);
  await router.handle(msg(2,'/test secret-value'));
  assert.equal(sent.length,3);assert.match(sent[1].text,/Malformed/);
  assert.equal(JSON.parse(sent[2].text).error.code,'INVALID_TEST_REQUEST');
  assert.ok(logs.some(x=>x.httpStatus===200));assert.ok(logs.some(x=>x.reason==='duplicate'));
  assert.ok(!JSON.stringify(logs).includes('secret-value'));
  assert.equal(safeActivity({event:'handled',action:'/test',httpStatus:200},new Date().toISOString()).action,'/test');
  await router.handle({...msg(3,'/test'),from:{id:99},chat:{id:99,type:'private'}});
  assert.match(sent.at(-1).text,/restricted/);
});
