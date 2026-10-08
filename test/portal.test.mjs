import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ScholarshipPortal} from '../portal.mjs';

test('Verified recovered password survives failure to capture the optional slip', async () => {
  const portal = new ScholarshipPortal();
  portal.details = {registration:'000123456789'};
  const inputs = [];
  let clicks = 0;
  portal.page = {
    locator:selector => ({
      fill:async value => {inputs.push([selector,value]);},
      click:async () => {clicks++;},
      innerText:async () => 'आपका रजिस्ट्रेशन संख्या: 000123456789\nपासवर्ड (इस नंबर को नोट करें): Abc123',
    }),
    waitForNavigation:async () => {},
    url:() => 'https://scholarship.up.gov.in/ForgetPasswordPrint.aspx',
    screenshot:async () => {throw new Error('Screenshot failed');},
  };
  const result = await portal.submit('AbC12');
  assert.equal(result.kind,'success');
  assert.equal(result.password,'Abc123');
  assert.equal(clicks,1);
  assert.deepEqual(inputs,[['#ContentPlaceHolder1_txtCaptcha','AbC12']]);
});
