import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticWords, otrDiagnostic, maskTextShape} from '../otr-diagnostics.mjs';

test('Diagnostics keep only structural metadata and a closed operational vocabulary', () => {
  const event = otrDiagnostic({
    url:'https://example.test/?phone=9876543210',
    fields:[{id:'ContentPlaceHolder1_txt_otp',inputType:'password',label:'OTP sent to Priya 9876543210',value:'001234'}],
    buttons:[{id:'account_9876543210',label:'Verify OTP for Priya priya@example.test',disabled:false}],
    result:'00012345678901',recoveryResults:['00012345678901'],
    resultBlocks:[{id:'ContentPlaceHolder1_result',tag:'DIV',text:'Your OTR number is 00012345678901. Priya 9876543210'}],
    recoveryPanel:{labelled:true,headings:['Your OTR is :-'],values:['UP26/0000000001']},
  },'action');
  assert.equal(event.fields[0].id,'ContentPlaceHolder1_txt_otp');
  assert.deepEqual(event.fields[0].words,['otp','sent']);
  assert.equal(event.buttons[0].id,'other');
  assert.equal(event.resultCount,1);
  assert.deepEqual(event.content[0].numberLengths,[14,10]);
  assert.deepEqual(event.panel.valueShapes,['XX##/##########']);
  assert.equal(maskTextShape('Your OTR is :-'),'XXXX XXX XX :-');
  assert.doesNotMatch(JSON.stringify(event),/9876543210|001234|Priya|priya|example|00012345678901/);
  assert.deepEqual(diagnosticWords('ओ०टी०पी० भेजा गया 001234'),['otp','भेजा','गया']);
});
