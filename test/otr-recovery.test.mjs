import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRecoveryLabel, normalizeRecoverySnapshot, classifyRecovery} from '../otr-recovery.mjs';
import {classifyOtrDialog} from '../otr-portal.mjs';

const snapshot = (extra = {}) => ({url:'https://scholarship.up.gov.in/ForgetOTR.aspx',fields:[],buttons:[],...extra});
test('Recovery understands the Hindi OTP controls without changing unknown controls', () => {
  assert.equal(normalizeRecoveryLabel('ओ०टी०आर० (OTR) पुनः प्राप्त करें'),'OTR पुनः प्राप्त करें');
  const s = normalizeRecoverySnapshot(snapshot({fields:[{id:'otp',label:'ओ०टी०पी०',inputType:'password',tag:'INPUT'}],buttons:[{id:'submit',label:'ओ०टी०पी० सत्यापित करें'},{id:'resend',label:'ओ०टी०पी० पुनः भेजें',disabled:true}]}));
  const step = classifyRecovery(s);
  assert.equal(step.action.kind,'verify-otp');
  assert.equal(step.fields[0].type,'otp');
  assert.equal(s.buttons[1].label,'Resend OTP');
});

test('A recovery result requires OTP submission in the same isolated session', () => {
  const s = snapshot({recoveryResults:['00012345678901']});
  assert.notEqual(classifyRecovery(s).kind,'success');
  assert.deepEqual(classifyRecovery(s,{verificationSubmitted:true}),{kind:'success',otr:'00012345678901'});
});

test('Conflicting result numbers, visible verification fields, errors and other origins never count as success', () => {
  for (const extra of [
    {recoveryResults:['00012345678901','00012345678902']},
    {fields:[{id:'otp',label:'OTP',inputType:'text'}]},
    {error:'otp'},
    {url:'https://external.example/result'},
  ]) assert.notEqual(classifyRecovery(snapshot({recoveryResults:['00012345678901'],...extra}),{verificationSubmitted:true}).kind,'success');
});

test('Recovery never requests Aadhaar, registers an OTR, or sends an OTP without the CAPTCHA stage', () => {
  const s = snapshot({fields:[{id:'mobile',label:'Mobile',inputType:'text'}],buttons:[{id:'submit',label:'Generate OTP'}]});
  assert.equal(classifyRecovery(s).kind,'unsupported');
  assert.equal(classifyRecovery({...s,fields:[{id:'aadhaar',label:'Aadhaar',inputType:'text'}]}).kind,'unsupported');
  assert.equal(classifyRecovery({...s,buttons:[{id:'submit',label:'Generate OTR'}]}).kind,'unsupported');
});

test('OTP sent confirmation is not misreported as an invalid OTP', () => {
  assert.equal(classifyOtrDialog('OTP sent successfully'),'notice');
  assert.equal(classifyOtrDialog('ओ०टी०पी० भेजा गया है'),'notice');
  assert.equal(classifyOtrDialog('Invalid OTP'),'otp');
  assert.equal(classifyOtrDialog('Incorrect Captcha'),'captcha');
  assert.equal(classifyOtrDialog('Unexpected warning'),'unknown');
});
