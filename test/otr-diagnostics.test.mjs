import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticWords, otrDiagnostic} from '../otr-diagnostics.mjs';

test('Diagnostics keep only structural metadata and a closed operational vocabulary', () => {
  const event = otrDiagnostic({
    url:'https://example.test/?phone=9876543210',
    fields:[{id:'ContentPlaceHolder1_txt_otp',inputType:'password',label:'OTP sent to Priya 9876543210',value:'001234'}],
    buttons:[{id:'account_9876543210',label:'Verify OTP for Priya priya@example.test',disabled:false}],
    result:'00012345678901',recoveryResults:['00012345678901'],
  },'action');
  assert.equal(event.fields[0].id,'ContentPlaceHolder1_txt_otp');
  assert.deepEqual(event.fields[0].words,['otp','sent']);
  assert.equal(event.buttons[0].id,'other');
  assert.equal(event.resultCount,1);
  assert.doesNotMatch(JSON.stringify(event),/9876543210|001234|Priya|priya|example|00012345678901/);
  assert.deepEqual(diagnosticWords('ओ०टी०पी० भेजा गया 001234'),['otp','भेजा','गया']);
});
