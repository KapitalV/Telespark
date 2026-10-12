import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OtrBot} from '../otr-core.mjs';
import {normalizeOtrAnswer, classifyOtrPage} from '../otr-schema.mjs';
import {BotRouter} from '../router.mjs';
import {RecoveryBot} from '../core.mjs';

// Later-stage shapes below are synthetic contract tests, not assertions that
// OTP-protected live pages have been manually verified.
const mobile = {key:'mobile',id:'mobile',type:'mobile',label:'Mobile',required:true,maxLength:10};
const captcha = {key:'captcha',id:'captcha',type:'captcha',label:'CAPTCHA',required:true,maxLength:5};
const otp = {key:'otp',id:'otp',type:'otp',label:'OTP',required:true,maxLength:6};
const form = (fields = [mobile,captcha], kind = 'send-otp', extra = {}) => ({kind:'form',stage:kind === 'register' ? 'final' : fields.includes(otp) ? 'otp' : 'mobile',fields,action:{kind,label:kind},fingerprint:kind,image:Buffer.from('test image'),...extra});

function fixture(steps = [], first = form()) {
  const sent = [], submits = [], events = [];
  let now = Date.now(), outgoing = 100, incoming = 1;
  const telegram = {
    send:async (_id,text,options) => {sent.push({text,options}); return {message_id:outgoing++};},
    photo:async (_id,bytes,text) => {sent.push({text,bytes}); return {message_id:outgoing++};},
    document:async () => {},
  };
  const portal = {
    open:async () => {events.push('open'); return structuredClone(first);},
    submit:async (values,fingerprint) => {submits.push({values:{...values},fingerprint}); return steps.shift() ?? {kind:'unsupported'};},
    refresh:async () => {events.push('refresh'); return form();},
    resend:async () => {events.push('resend'); return form([otp],'verify-otp');},
    close:async () => {events.push('close');},
  };
  const clock = () => now;
  const bot = new OtrBot({telegram,portalFactory:() => portal,allowedUserId:'42',clock,timeoutMs:50});
  const recovery = new RecoveryBot({telegram,portalFactory:() => ({open:async () => Buffer.from('image'),close:async () => {}}),allowedUserId:'42',clock});
  const router = new BotRouter({telegram,recovery,otr:bot,allowedUserId:'42',enableOtr:true,clock});
  const message = (text, extra = {}) => ({message_id:incoming++,from:{id:42},chat:{id:42,type:'private'},text,...extra});
  const say = (text,extra) => bot.handle(message(text,extra));
  const route = (text,extra) => router.handle(message(text,extra));
  return {bot,router,recovery,portal,telegram,sent,submits,events,message,say,route,advance:ms => {now += ms;}};
}

test('Unsupported responses expose a bounded diagnostic code without portal data', async () => {
  const f = fixture([{kind:'unsupported',reason:'action'}]);
  await f.bot.start(42,'recover');
  await f.say('9876543210'); await f.say('AbC12');
  assert.match(f.sent.at(-1).text,/OTR-ACTION/);
  assert.doesNotMatch(f.sent.at(-1).text,/external verification/);
  assert.equal(f.bot.sessions.get(42).phase,'unsupported');
  assert.ok(f.events.includes('close'));
  const g = fixture([{kind:'unsupported',reason:'private OTP 001234'}]);
  await g.bot.start(42,'recover');
  await g.say('9876543210'); await g.say('AbC12');
  assert.match(g.sent.at(-1).text,/OTR-UNKNOWN/);
  assert.doesNotMatch(g.sent.at(-1).text,/001234/);
});

test('Official result image is copyable, re-delivered without submission, and cleared on cancellation', async () => {
  const bytes = Buffer.from('synthetic official result image');
  const f = fixture([{kind:'result-image',image:bytes}]);
  const photos = [];
  f.telegram.photo = async (_id,image,caption,options) => {photos.push({image,caption,options}); return {message_id:200};};
  await f.bot.start(42,'recover');
  await f.say('9876543210'); await f.say('AbC12');
  assert.equal(f.bot.sessions.get(42).phase,'done');
  assert.equal(photos.at(-1).options.protect_content,false);
  assert.equal(photos.at(-1).image,bytes);
  await f.say('/result');
  assert.equal(f.submits.length,1);
  assert.equal(photos.at(-1).image,bytes);
  await f.say('hello');
  assert.match(f.sent.at(-1).text,/Website response captured/);
  assert.doesNotMatch(f.sent.at(-1).text,/confirmed/);
  const state = f.bot.sessions.get(42);
  await f.say('/cancel');
  assert.equal(state.resultImage,undefined);
});

test('OTR validates mobile, OTP, Aadhaar, dates and preserves leading zeros', () => {
  assert.equal(normalizeOtrAnswer(otp,'001234'),'001234');
  assert.throws(() => normalizeOtrAnswer(mobile,'+919876543210'));
  assert.throws(() => normalizeOtrAnswer(otp,'abcdef'));
  assert.throws(() => normalizeOtrAnswer(captcha,'too long'));
  assert.throws(() => normalizeOtrAnswer({type:'aadhaar'},'123'));
  assert.throws(() => normalizeOtrAnswer({type:'dob'},'31/02/2000'));
  assert.equal(normalizeOtrAnswer({type:'dob'},'29/02/2000'),'29/02/2000');
  assert.throws(() => normalizeOtrAnswer({type:'consent'},'yes'));
  assert.equal(normalizeOtrAnswer({type:'consent'},'AGREE'),true);
});

test('Menu routes the existing six-question password flow and supports back/cancel', async () => {
  const f = fixture();
  await f.route('/start');
  assert.deepEqual(f.sent.at(-1).options.reply_markup.keyboard,[['1. Password recovery'],['2. OTR'],['3. Form filling OTNew-Poly']]);
  await f.route('2'); await f.route('Back'); await f.route('1');
  for (const value of ['Fresh','000123456789','0000000000','UP BOARD','2021','001234567']) await f.route(value);
  assert.equal(f.recovery.sessions.get(42).phase,'captcha');
  await f.route('/menu');
  assert.equal(f.recovery.sessions.size,0);
  await f.route('2'); await f.route('1');
  assert.equal(f.bot.sessions.get(42).mode,'recover');
  await f.route('/cancel');
  assert.equal(f.bot.sessions.size,0);
  assert.ok(f.events.includes('close'));
});

test('OTR disabled by default; owner/private-chat restriction cannot be bypassed', async () => {
  const f = fixture();
  f.router.enableOtr = false;
  await f.route('/start'); await f.route('2'); await f.route('/otr');
  assert.equal(f.bot.sessions.size,0);
  assert.match(f.sent.at(-1).text,/disabled/);
  await f.route('/start',{from:{id:99}});
  assert.match(f.sent.at(-1).text,/restricted/);
  await f.route('/start',{chat:{id:99,type:'group'}});
  await f.route('/start',{from:{id:99,is_bot:true}});
  assert.equal(f.router.sessions.has(99),false);
});

test('Full recovery contract: request OTP once, verify once, deliver copyable result and clear inputs', async () => {
  const f = fixture([form([otp],'verify-otp'),{kind:'success',otr:'00012345678901'}]);
  await f.bot.start(42,'recover');
  await f.say('9876543210');
  const answer = f.message('AbC12');
  await f.bot.handle(answer); await f.bot.handle(answer);
  assert.equal(f.submits.length,1);
  assert.equal(f.submits[0].values.mobile,'9876543210');
  await f.say('001234'); await f.say('/result');
  assert.equal(f.submits.length,2);
  assert.equal(f.submits[1].values.otp,'001234');
  assert.equal(f.bot.sessions.get(42).phase,'done');
  assert.deepEqual(f.bot.sessions.get(42).values,{});
  assert.equal(f.bot.sessions.get(42).portal,undefined);
  assert.equal(f.sent.at(-1).options.protect_content,false);
});

test('Registration requires declaration agreement and a separate final confirmation', async () => {
  const consent = form([{key:'chk',id:'chk',type:'consent',label:'Official declaration'}],'consent',{stage:'consent'});
  const final = form([{key:'father',id:'father',type:'name',label:'Father name'}],'register');
  const f = fixture([form(),form([otp],'verify-otp'),final,{kind:'success',otr:'00012345678901'}],consent);
  await f.bot.start(42,'register');
  await f.say('yes'); assert.equal(f.submits.length,0);
  await f.say('AGREE'); await f.say('9876543210'); await f.say('AbC12'); await f.say('001234'); await f.say('Example Parent');
  assert.equal(f.bot.sessions.get(42).phase,'confirm');
  assert.equal(f.submits.length,3);
  await f.say('anything'); assert.equal(f.submits.length,3);
  await f.say('CONFIRM'); await f.say('CONFIRM');
  assert.equal(f.submits.length,4);
  assert.equal(f.bot.sessions.get(42).phase,'done');
});

test('Wrong CAPTCHA and invalid/expired OTP prompt again without automatic resubmission', async () => {
  const f = fixture([form([mobile,captcha],'send-otp',{error:'captcha'}),form([otp],'verify-otp'),form([otp],'verify-otp',{error:'otp'})]);
  await f.bot.start(42,'recover');
  for (const answer of ['9876543210','AbC12']) await f.say(answer);
  assert.equal(f.submits.length,1);
  assert.ok(f.sent.some(m => /rejected or expired that CAPTCHA/.test(m.text)));
  assert.equal(f.bot.sessions.get(42).values.mobile,'9876543210');
  assert.equal(f.bot.sessions.get(42).step.fields[f.bot.sessions.get(42).index].type,'captcha');
  for (const answer of ['XyZ45','001234']) await f.say(answer);
  assert.equal(f.submits.length,3);
  assert.ok(f.sent.some(m => /rejected or expired that OTP/.test(m.text)));
  assert.deepEqual(f.bot.sessions.get(42).values,{});
});

test('Refresh, old image replies, and stale queued answers never submit', async () => {
  const f = fixture();
  await f.bot.start(42,'recover'); await f.say('9876543210');
  await f.say('AbC12',{reply_to_message:{message_id:1}});
  await f.say('AbC12',{date:1});
  f.advance(6 * 60_000); await f.say('AbC12');
  assert.equal(f.submits.length,0);
  assert.ok(f.events.includes('refresh'));
  await f.say('/refresh');
  assert.equal(f.events.filter(e => e === 'refresh').length,2);
});

test('OTP resend honors a local cooldown and unavailable portal resend never submits', async () => {
  const f = fixture([form([otp],'verify-otp')]);
  await f.bot.start(42,'recover'); await f.say('9876543210'); await f.say('AbC12');
  await f.say('/resend'); assert.equal(f.events.includes('resend'),false);
  f.advance(61_000); await f.say('/resend');
  assert.equal(f.events.filter(e => e === 'resend').length,1);
  await f.say('/resend'); assert.equal(f.events.filter(e => e === 'resend').length,1);
  f.portal.resend = async () => ({kind:'resend-unavailable'});
  f.advance(61_000); await f.say('/resend');
  assert.equal(f.bot.sessions.get(42).phase,'questions');
  assert.equal(f.submits.length,1);
  assert.ok(f.sent.some(message => /No new OTP was requested/.test(message.text)));
});

test('Preparation timeout supports retry and never exposes raw error details', async () => {
  const f = fixture();
  f.portal.open = () => new Promise(() => {});
  await f.bot.start(42,'recover');
  assert.equal(f.bot.sessions.get(42).phase,'load-failed');
  f.portal.open = async () => {throw new Error('Aadhaar=private-value');};
  await f.say('/retry');
  assert.doesNotMatch(f.sent.map(m => m.text).join('\n'),/private-value/);
  f.portal.open = async () => form();
  await f.say('/retry');
  assert.equal(f.bot.sessions.get(42).phase,'questions');
});

test('Submission timeout erases captured inputs and prohibits all automatic retries', async () => {
  const f = fixture();
  let held;
  f.portal.submit = values => {held = values; return new Promise(() => {});};
  await f.bot.start(42,'recover'); await f.say('9876543210'); await f.say('AbC12');
  assert.equal(f.bot.sessions.get(42).phase,'unknown');
  assert.deepEqual(held,{});
  for (const command of ['/retry','/refresh','/resend','AbC12']) await f.say(command);
  assert.equal(f.events.filter(e => e === 'open').length,1);
  assert.match(f.sent.at(-1).text,/stopped/);
});

test('Verified result survives Telegram delivery failure and resends without website action', async () => {
  const f = fixture([{kind:'success',otr:'00012345678901'}]);
  await f.bot.start(42,'recover'); await f.say('9876543210');
  const send = f.telegram.send;
  f.telegram.send = async () => {throw new Error('Telegram offline');};
  await assert.rejects(f.say('AbC12'));
  f.telegram.send = send;
  await f.say('/result');
  assert.equal(f.submits.length,1);
  assert.match(f.sent.at(-1).text,/00012345678901/);
});

test('Unsupported verification and duplicate registration stop and clear details', async () => {
  for (const result of [{kind:'unsupported',reason:'external-verification'},form([otp],'verify-otp',{error:'already-registered'})]) {
    const f = fixture([result]);
    await f.bot.start(42,'register'); await f.say('9876543210'); await f.say('AbC12');
    assert.ok(['unsupported','blocked'].includes(f.bot.sessions.get(42).phase));
    assert.deepEqual(f.bot.sessions.get(42).values,{});
    assert.equal(f.bot.sessions.get(42).portal,undefined);
  }
});

test('Idle expiry closes sessions and removes personal values without new messages', async () => {
  const f = fixture();
  await f.route('/start'); await f.route('2'); await f.route('1'); await f.route('9876543210');
  const state = f.bot.sessions.get(42);
  assert.equal(state.values.mobile,'9876543210');
  f.advance(21 * 60_000); await f.router.expire();
  assert.equal(f.bot.sessions.size,0);
  assert.equal(f.router.sessions.size,0);
  assert.deepEqual(state.values,{});
  assert.equal(state.savedMobile,undefined);
});

test('Router serializes concurrent duplicate updates, including /start', async () => {
  const f = fixture();
  const start = f.message('/start');
  await Promise.all([f.router.handle(start),f.router.handle(start)]);
  assert.equal(f.sent.length,1);
  await f.route('2'); await f.route('1'); await f.route('9876543210');
  const answer = f.message('AbC12');
  await Promise.all([f.router.handle(answer),f.router.handle(answer)]);
  assert.equal(f.submits.length,1);
});

const snapshot = extra => ({url:'https://scholarship.up.gov.in/ForgetOTR.aspx',fields:[{id:'ContentPlaceHolder1_txt_mobile',label:'मोबाइल नंबर *',tag:'INPUT',inputType:'text'}],buttons:[{id:'button',label:'ओ०टी०आर० पुनः प्राप्त करें',disabled:false}],...extra});

test('Schema recognizes observed public recovery and registration fields', () => {
  assert.equal(classifyOtrPage(snapshot(),'recover').action.kind,'send-otp');
  const step = classifyOtrPage(snapshot({url:'https://scholarship.up.gov.in/RegWithOTR.aspx',buttons:[{id:'ContentPlaceHolder1_buttonOTP',label:'Generate OTP'}],fields:[{id:'ContentPlaceHolder1_ddl_caste',label:'वर्ग / जाति समूह',tag:'SELECT',options:[{value:'5',label:'सामान्य वर्ग'}]}, {id:'ContentPlaceHolder1_mobile',label:'मोबाइल नंबर',tag:'INPUT'},{id:'ContentPlaceHolder1_txtCaptcha',label:'कैप्चा',tag:'INPUT'}]}),'register');
  assert.deepEqual(step.fields.map(f => f.type),['category','mobile','captcha']);
});

test('Schema refuses unknown controls, ambiguous actions, external pages and missing OTP field', () => {
  for (const change of [
    {url:'https://example.com/ForgetOTR.aspx'},
    {externalFrame:true},
    {fields:[{id:'mystery',label:'Unknown field'}]},
    {buttons:[{id:'a',label:'Generate OTP'},{id:'b',label:'Generate OTP'}]},
    {buttons:[{id:'a',label:'Verify OTP'}]},
    {buttons:[{id:'a',label:'Pay fee'}]},
    {buttons:[{id:'a',label:'Generate OTP',actionUrl:'https://external.example/verify'}]},
    {buttons:[{id:'a',label:'Generate OTP',target:'_blank'}]},
  ]) assert.equal(classifyOtrPage(snapshot(change),'recover').kind,'unsupported');
});

test('Success requires a dedicated output, no active fields, and official origin', () => {
  assert.equal(classifyOtrPage(snapshot({result:'00012345678901'}),'recover').kind,'form');
  assert.equal(classifyOtrPage(snapshot({result:'00012345678901',fields:[]}),'recover').kind,'success');
  assert.equal(classifyOtrPage(snapshot({result:'00012345678901',fields:[],url:'https://evil.example/result'}),'recover').kind,'unsupported');
  assert.equal(classifyOtrPage(snapshot({result:'abc',fields:[]}),'recover').kind,'unsupported');
});

test('Expired CAPTCHA at final confirmation refreshes instead of registering', async () => {
  const f = fixture([],form([captcha],'register'));
  await f.bot.start(42,'register'); await f.say('AbC12');
  assert.equal(f.bot.sessions.get(42).phase,'confirm');
  f.advance(6 * 60_000); await f.say('CONFIRM');
  assert.equal(f.submits.length,0);
  assert.ok(f.events.includes('refresh'));
});

test('Failed prompt delivery can be retried without a portal submission', async () => {
  const f = fixture();
  await f.bot.start(42,'recover');
  const photo = f.telegram.photo;
  f.telegram.photo = async () => {throw new Error('Telegram offline');};
  await assert.rejects(f.say('9876543210'));
  f.telegram.photo = photo;
  await f.say('/retry');
  assert.ok(f.sent.at(-1).bytes);
  assert.equal(f.submits.length,0);
});

test('Website downtime reports only its HTTP status and allows a fresh load retry', async () => {
  const f = fixture();
  f.portal.open = async () => {throw Object.assign(new Error('private raw diagnostics'),{code:'HTTP_503'});};
  await f.bot.start(42,'recover');
  assert.match(f.sent.at(-1).text,/HTTP_503/);
  assert.doesNotMatch(f.sent.at(-1).text,/private raw diagnostics/);
  assert.equal(f.bot.sessions.get(42).phase,'load-failed');
  assert.equal(f.submits.length,0);
});
