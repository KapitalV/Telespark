import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FinalPortal} from '../final-portal.mjs';
import {finalError,finalErrorCode,finalErrorNotice} from '../final-errors.mjs';
import {safeActivity,formatActivity} from '../activity.mjs';
import {FinalBatch} from '../final-batch.mjs';

test('Final PDF errors carry a fixed stage without credentials, URLs or portal text',async()=>{
  const p=new FinalPortal();p.read=async()=>{throw Error('secret URL and registration');};
  await assert.rejects(p.finalPdf(),e=>e.code==='FINAL-STATUS'&&!e.message.includes('secret'));
  const record=safeActivity({event:'portal_error',module:'final-batch',code:'FINAL-RENDER',message:'password'},'2026-10-14T12:00:00.000Z');
  assert.equal(record.message,undefined);assert.match(formatActivity(record),/FINAL-RENDER/);
  assert.equal(safeActivity({event:'portal_error',code:'private applicant value'},'2026-10-14T12:00:00.000Z').code,undefined);
  assert.equal(finalErrorCode(Error('private value')),undefined);assert.match(finalErrorNotice('FINAL-VALIDATION'),/readability/);
});
test('Batch reports PDF failure separately from a rejected CAPTCHA without any lock operation',async()=>{
  const messages=[];let incoming=1;
  const batch=new FinalBatch({telegram:{send:async(id,text)=>messages.push(text),photo:async()=>({message_id:100})},isAdmin:()=>true,deliver:async()=>{},portalFactory:()=>({open:async()=>Buffer.from('captcha'),login:async()=>({kind:'print-ready'}),finalPdf:async()=>{throw finalError('FINAL-VALIDATION');},close:async()=>{}}),presets:{Preset:'synthetic'}});
  await batch.start(42);const state=batch.sessions.get(42);Object.assign(state,{phase:'batch-review',rows:[{row:2,registration:'000012345678',otr:'UP26-0000000001',applicationType:'Fresh',status:'pending'}]});
  const answer=text=>batch.handle({chat:{id:42,type:'private'},from:{id:42},message_id:incoming++,text,reply_to_message:{message_id:100}});
  await answer('YES');await answer('Preset');await answer('AbC12');
  assert.equal(state.phase,'retry');assert.match(messages.at(-1),/FINAL-VALIDATION/);await batch.clear(42);
});
