import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RecoveryBot, normalizeAnswer, parsePortalResult} from '../core.mjs';

function fixture(results = []) {
  const messages = [], submissions = [], opened = [];
  let nextId = 100;
  const telegram = {
    send:async (_id,text) => { messages.push(text); return {message_id:nextId++}; },
    photo:async (_id,_bytes,caption) => { messages.push(caption); return {message_id:nextId++}; },
    document:async () => ({message_id:nextId++}),
  };
  const portal = {
    open:async details => { opened.push({...details}); return Buffer.from('fake image'); },
    submit:async code => { submissions.push(code); return results.shift() ?? {kind:'unknown'}; },
    close:async () => {},
  };
  let now = Date.now();
  const bot = new RecoveryBot({telegram, portalFactory:() => portal, allowedUserId:'42', clock:() => now});
  let incomingId = 1;
  const message = (text, extra = {}) => ({from:{id:42},chat:{id:42,type:'private'},message_id:incomingId++,text,...extra});
  const say = text => bot.handle(message(text));
  const fill = async () => {
    for (const text of ['/start','Renewal','000123456789','13/03/2006','up board','2021','001234567']) await say(text);
  };
  return {bot, messages, submissions, opened, telegram, portal, say, message, fill, advance:ms => {now += ms;}};
}

test('Identifiers preserve leading zeros; real dates and required fields are validated', () => {
  assert.equal(normalizeAnswer('registration','000123456789'),'000123456789');
  assert.equal(normalizeAnswer('roll','001234567'),'001234567');
  assert.equal(normalizeAnswer('board','up'),'UP BOARD');
  assert.equal(normalizeAnswer('dob','29/02/2004'),'29/02/2004');
  for (const date of ['29/02/2005','31/04/2006','2006-03-13']) assert.throws(() => normalizeAnswer('dob',date));
  assert.throws(() => normalizeAnswer('applicationType','renew'));
  assert.throws(() => normalizeAnswer('year','3021'));
});

test('Owner-only access: other people, groups, and setup mode cannot create recovery sessions', async () => {
  const f = fixture();
  await f.bot.handle(f.message('/start',{from:{id:7}}));
  await f.bot.handle(f.message('/start',{chat:{id:42,type:'group'}}));
  assert.equal(f.bot.sessions.size,0);
  f.bot.allowedUserId = '';
  await f.say('/start');
  assert.equal(f.bot.sessions.size,0);
  await f.say('/id');
  assert.match(f.messages.at(-1),/42/);
});

test('All six answers fill the form once; CAPTCHA reply submits, then duplicate replies do not resubmit', async () => {
  const f = fixture([{kind:'success',registration:'000123456789',password:'Abc123'}]);
  await f.fill();
  assert.equal(f.opened.length,1);
  assert.equal(f.opened[0].year,'2021');
  assert.equal(f.opened[0].roll,'001234567');
  assert.equal(f.submissions.length,0);
  const captcha = f.message('AbC12');
  await f.bot.handle(captcha);
  await f.bot.handle(captcha);
  await f.say('AbC12');
  await f.say('/result');
  assert.deepEqual(f.submissions,['AbC12']);
  assert.equal(f.bot.sessions.get(42).phase,'done');
  assert.match(f.messages.join('\n'),/Abc123/);
  assert.deepEqual(f.bot.sessions.get(42).details,{});
});

test('Year mismatch requests only a corrected year and then refills the other details', async () => {
  const f = fixture([{kind:'correction',field:'year',message:'Year mismatch'}]);
  await f.fill(); await f.say('AbC12');
  assert.equal(f.bot.sessions.get(42).phase,'correction');
  await f.say('2020');
  assert.equal(f.opened.length,2);
  assert.equal(f.opened[1].year,'2020');
  assert.equal(f.opened[1].registration,'000123456789');
  assert.equal(f.submissions.length,1);
});

test('Invalid and expired CAPTCHAs produce a fresh image without automatic submission', async () => {
  const f = fixture([{kind:'captcha',message:'Invalid CAPTCHA'}]);
  await f.fill(); await f.say('AbC12');
  assert.equal(f.opened.length,2);
  assert.equal(f.bot.sessions.get(42).phase,'captcha');
  f.advance(6 * 60_000);
  await f.say('AbC12');
  assert.equal(f.opened.length,3);
  assert.equal(f.submissions.length,1);
});

test('Older CAPTCHA image replies are rejected without submitting', async () => {
  const f = fixture();
  await f.fill();
  await f.bot.handle(f.message('AbC12',{reply_to_message:{message_id:1}}));
  assert.equal(f.submissions.length,0);
});

test('An old queued reply cannot submit the new CAPTCHA created after a cold start', async () => {
  const f = fixture();
  await f.fill();
  await f.bot.handle(f.message('AbC12',{date:Math.floor(Date.now()/1000)-60}));
  assert.equal(f.submissions.length,0);
  assert.match(f.messages.at(-1),/before the current CAPTCHA/);
});

test('Unknown submission outcome stops all retries', async () => {
  const f = fixture();
  await f.fill(); await f.say('AbC12'); await f.say('XyZ45'); await f.say('/refresh');
  assert.equal(f.submissions.length,1);
  assert.equal(f.opened.length,1);
  assert.equal(f.bot.sessions.get(42).phase,'unknown');
});

test('A failed result delivery retains the result and /result never submits recovery again', async () => {
  const f = fixture([{kind:'success',registration:'000123456789',password:'Abc123'}]);
  await f.fill();
  const send = f.telegram.send;
  f.telegram.send = async () => { throw new Error('Telegram unavailable'); };
  await assert.rejects(f.say('AbC12'));
  f.telegram.send = send;
  await f.say('/result');
  assert.equal(f.submissions.length,1);
  assert.match(f.messages.at(-1),/Abc123/);
});

test('Only the official result for the expected registration counts as success', () => {
  const text = 'आपका रजिस्ट्रेशन संख्या: 000123456789\nपासवर्ड (इस नंबर को नोट करें): Abc123';
  assert.equal(parsePortalResult('https://scholarship.up.gov.in/ForgetPasswordPrint.aspx',text,'000123456789').kind,'success');
  assert.equal(parsePortalResult('https://example.com/ForgetPasswordPrint.aspx',text,'000123456789').kind,'unknown');
  assert.equal(parsePortalResult('https://scholarship.up.gov.in/ForgetPasswordPrint.aspx',text,'another').kind,'unknown');
  assert.equal(parsePortalResult('https://scholarship.up.gov.in/ForgetPwd.aspx?a=c','Invalid Captcha...! Try Again.','').kind,'captcha');
  assert.equal(parsePortalResult('https://scholarship.up.gov.in/ForgetPwd.aspx?a=yr','High School Board year not matched...! Try Again.','').field,'year');
});
