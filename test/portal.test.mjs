import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ScholarshipPortal, portalFailure} from '../portal.mjs';

test('Portal diagnostics keep the stage and network category, never raw personal values', () => {
  const error = portalFailure(new Error('net::ERR_CONNECTION_RESET secret-personal-value'), 'website');
  assert.equal(error.code,'ERR_CONNECTION_RESET');
  assert.equal(error.stage,'website');
  assert.doesNotMatch(error.message,/secret-personal-value/);
});

test('Fresh application waits for its postback before filling details', async () => {
  const portal = new ScholarshipPortal();
  portal.browser = {};
  const order = [];
  const values = new Map();
  let navigationDone;
  const navigation = new Promise(resolve => {navigationDone = resolve;});
  portal.page = {
    goto:async () => ({status:() => 200}),
    url:() => 'https://scholarship.up.gov.in/ForgetPwd.aspx',
    waitForNavigation:async () => { await navigation; order.push('navigation'); },
    waitForFunction:async () => {},
    locator:id => ({
      isChecked:async () => false,
      check:async () => {setTimeout(navigationDone,10);},
      fill:async value => {order.push('fill'); values.set(id,value);},
      selectOption:async ({label}) => {values.set(id,label);},
      inputValue:async () => values.get(id),
      screenshot:async () => Buffer.from('image'),
    }),
  };
  await portal.open({applicationType:'Fresh',registration:'000123456789',mobile:'0000000000',board:'UP BOARD',year:'2021',roll:'001234567'});
  assert.equal(order[0],'navigation');
  assert.equal(values.get('#ContentPlaceHolder1_txtLogin'),'000123456789');
  assert.equal(values.get('#ContentPlaceHolder1_txtmobilenumber'),'0000000000');
  assert.equal(values.has('#ContentPlaceHolder1_txtdob'),false);
});

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
