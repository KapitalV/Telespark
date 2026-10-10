import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {OtrPortal} from '../otr-portal.mjs';
import {OTR_ORIGIN} from '../otr-schema.mjs';
import {OtrBot} from '../otr-core.mjs';
import {OtrRecoveryPortal} from '../otr-recovery.mjs';
import {BotRouter} from '../router.mjs';

const input = (id,label,type = 'text') => `<label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}">`;
const button = (label,id = 'submit') => `<input type="submit" id="${id}" value="${label}">`;
const page = body => `<!doctype html><meta charset="utf-8"><form method="post">${body}</form>`;
const image = '<img id="Captcha" src="/captcha.ashx?id=1"><button type="button" aria-label="Refresh Captcha" onclick="document.querySelector(\'#Captcha\').src=\'/captcha.ashx?id=2\'">Refresh Captcha</button>';
const initial = page(input('ContentPlaceHolder1_txt_mobile','Mobile number') + image + input('ContentPlaceHolder1_txtCaptcha','Captcha') + button('ओ०टी०आर० पुनः प्राप्त करें'));
const otpPage = (extra = '') => page(input('otp','OTP') + button('Verify OTP') + extra);
const result = page('<table><tr><td>OTR Number:</td><td>00012345678901</td></tr></table>');

test('Browser-backed OTR adapter contracts (all network requests intercepted)', {skip:process.env.OTR_BROWSER_TESTS !== 'true'}, async t => {
  const browser = await chromium.launch({headless:true,channel:process.platform === 'win32' ? 'msedge' : undefined});
  t.after(() => browser.close());
  const fixture = async (mode, respond) => {
    let context;
    const posts = [];
    const portal = new (mode === 'recover' ? OtrRecoveryPortal : OtrPortal)({mode,launch:async () => ({
      newContext:async options => {
        context = await browser.newContext(options);
        await context.route('**/*',async route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== OTR_ORIGIN) return route.abort();
          if (url.pathname === '/captcha.ashx') return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text x="5" y="25">AbC12</text></svg>'});
          if (request.method() === 'POST') posts.push(new URLSearchParams(request.postData()));
          const body = await respond(request,url,posts);
          return route.fulfill({contentType:'text/html',body});
        });
        return context;
      },
      close:async () => context?.close(),
    })});
    t.after(() => portal.close());
    return {portal,posts};
  };

  await t.test('Read real DOM, keep values through postback, request and verify OTP',async () => {
    const f = await fixture('recover',(_request,_url,posts) => posts.length === 0 ? initial : posts.length === 1 ? otpPage() : result);
    let step = await f.portal.open();
    assert.equal(step.stage,'mobile'); assert.ok(step.image.length > 0);
    step = await f.portal.submit({ContentPlaceHolder1_txt_mobile:'9876543210',ContentPlaceHolder1_txtCaptcha:'AbC12'},step.fingerprint);
    assert.equal(step.stage,'otp');
    assert.equal(f.posts[0].get('ContentPlaceHolder1_txt_mobile'),'9876543210');
    step = await f.portal.submit({otp:'001234'},step.fingerprint);
    assert.deepEqual(step,{kind:'success',otr:'00012345678901'});
    assert.equal(f.posts[1].get('otp'),'001234');
    await f.portal.close();
  });

  await t.test('CAPTCHA refresh changes the image without a form POST',async () => {
    const f = await fixture('recover',() => initial);
    const step = await f.portal.open();
    const next = await f.portal.refresh(step.fingerprint);
    assert.equal(next.kind,'form'); assert.ok(next.image.length > 0);
    assert.equal(f.posts.length,0);
    await f.portal.close();
  });

  await t.test('Declaration uses the observed checkbox and revealed Proceed button',async () => {
    const declaration = 'I have read and understood the One Time Registration guidelines. I consent to the use of Aadhaar/OTR for de-duplication on the UP Scholarship and National Scholarship Portals.';
    const popup = page(`<style>.hiddee{display:none}</style><span onchange="document.getElementById('btnsub').classList.toggle('hiddee',!document.getElementById('chk').checked)">${input('chk',declaration,'checkbox')}</span><input id="btnsub" class="hiddee" type="submit" value="Proceed to OTR Registration  →">`);
    const f = await fixture('register',(_request,_url,posts) => posts.length ? '<meta http-equiv="refresh" content="0;url=/RegWithOTR.aspx">' : popup);
    const step = await f.portal.open();
    assert.equal(step.stage,'consent');
    assert.equal(f.posts.length,0);
    // Replace the post-consent fixture to avoid a real government submission.
    await f.portal.context.route('**/RegWithOTR.aspx',route => route.fulfill({contentType:'text/html',body:page(input('mobile','Mobile number') + button('Generate OTP'))}));
    const next = await f.portal.submit({chk:true},step.fingerprint);
    assert.equal(next.stage,'mobile');
    assert.equal(f.posts.length,1);
    assert.equal(f.posts[0].get('chk'),'on');
    await f.portal.close();
  });

  await t.test('Unknown fields, changed fields and external pages never get submitted',async () => {
    const f = await fixture('recover',() => initial);
    const step = await f.portal.open();
    await f.portal.page.locator('form').evaluate(e => e.insertAdjacentHTML('beforeend','<label for="unknown">Unmapped verification</label><input id="unknown">'));
    const next = await f.portal.submit({ContentPlaceHolder1_txt_mobile:'9876543210',ContentPlaceHolder1_txtCaptcha:'AbC12'},step.fingerprint);
    assert.equal(next.kind,'unsupported');
    assert.equal(f.posts.length,0);
    await f.portal.close();
  });

  await t.test('Unchanged post-submit form is ambiguous; invalid CAPTCHA is recoverable',async () => {
    for (const extra of ['', '<p>Invalid CAPTCHA</p>']) {
      const f = await fixture('recover',(_request,_url,posts) => initial + (posts.length ? extra : ''));
      const step = await f.portal.open();
      const next = await f.portal.submit({ContentPlaceHolder1_txt_mobile:'9876543210',ContentPlaceHolder1_txtCaptcha:'AbC12'},step.fingerprint);
      assert.equal(next.kind,extra ? 'form' : 'unknown');
      if (extra) assert.equal(next.error,'captcha');
      assert.equal(f.posts.length,1);
      await f.portal.close();
    }
  });

  await t.test('Disabled resend is not clicked; enabled resend stays in the same session',async () => {
    for (const disabled of [true,false]) {
      const f = await fixture('recover',() => otpPage(`<input id="resend" type="submit" value="Resend OTP" ${disabled ? 'disabled' : ''}>`));
      await f.portal.open();
      const next = await f.portal.resend();
      assert.equal(next.kind,disabled ? 'resend-unavailable' : 'form');
      assert.equal(f.posts.length,disabled ? 0 : 1);
      await f.portal.close();
    }
  });

  await t.test('A review form containing an OTR-like value cannot report success',async () => {
    const f = await fixture('recover',() => result + input('aadhaar','Aadhaar number'));
    const next = await f.portal.open();
    assert.notEqual(next.kind,'success');
    assert.equal(f.posts.length,0);
    await f.portal.close();
  });

  await t.test('External form actions and scripted identity-provider requests are blocked before transmission',async () => {
    const f = await fixture('recover',() => initial);
    const step = await f.portal.open();
    await f.portal.page.locator('form').evaluate(e => e.action = 'https://external.example/verify');
    const next = await f.portal.submit({ContentPlaceHolder1_txt_mobile:'9876543210',ContentPlaceHolder1_txtCaptcha:'AbC12'},step.fingerprint);
    assert.equal(next.kind,'unsupported');
    assert.equal(f.posts.length,0);
    const blocked = await f.portal.page.evaluate(() => fetch('https://external.example/verify',{method:'POST',body:'synthetic-only'}).then(() => false,() => true));
    assert.equal(blocked,true);
    assert.equal((await f.portal.read()).reason,'external-verification');
    await f.portal.close();
  });

  await t.test('Category postback finishes before remaining registration fields are filled',async () => {
    const formFor = selected => page(`<script>function __doPostBack(){HTMLFormElement.prototype.submit.call(document.forms[0]);}</script><label for="caste">Category</label><select id="caste" name="caste" onchange="__doPostBack()"><option value="">Choose</option><option value="5" ${selected ? 'selected' : ''}>General</option></select>${input('mobile','Mobile number')}${image}${input('captcha','Captcha')}${button('Generate OTP')}`);
    const f = await fixture('register',(_request,_url,posts) => posts.length > 1 ? otpPage() : formFor(posts.length > 0));
    // Route directly to a synthetic registration form; no live consent is bypassed.
    await f.portal.open();
    await f.portal.page.goto(`${OTR_ORIGIN}/RegWithOTR.aspx`);
    const step = await f.portal.read();
    const next = await f.portal.submit({caste:'5',mobile:'9876543210',captcha:'AbC12'},step.fingerprint);
    assert.equal(next.stage,'otp');
    assert.equal(f.posts.length,2);
    assert.equal(f.posts[0].get('mobile'),'');
    assert.equal(f.posts[1].get('mobile'),'9876543210');
    assert.equal(f.posts[1].get('caste'),'5');
    await f.portal.close();
  });

  await t.test('Telegram registration contract crosses consent, both OTPs, e-KYC and final confirmation',async () => {
    const declaration = 'I have read and understood the One Time Registration guidelines. I consent to the use of Aadhaar/OTR for de-duplication on the UP Scholarship and National Scholarship Portals.';
    const popup = page(`<style>.hiddee{display:none}</style><span onchange="document.getElementById('btnsub').classList.toggle('hiddee',!document.getElementById('chk').checked)">${input('chk',declaration,'checkbox')}</span><input id="btnsub" class="hiddee" type="submit" value="Proceed to OTR Registration  →">`);
    const category = '<label for="caste">Category</label><select id="caste" name="caste"><option value="">Choose</option><option value="5">General</option></select>';
    const registration = page(category + input('mobile','Mobile number') + image + input('txtCaptcha','Captcha') + button('Generate OTP'));
    const ekyc = page(input('aadhaar','Aadhaar number') + button('Generate OTP'));
    const final = page(input('father','Father name') + input('mother','Mother name') + input('email','Email') + image + input('txtCaptcha','Captcha') + button('Generate OTR'));
    const f = await fixture('register',(request,url,posts) => {
      if (url.pathname === '/Popup.aspx') return request.method() === 'POST'
        ? '<meta http-equiv="refresh" content="0;url=/RegWithOTR.aspx">' : popup;
      return [popup,registration,otpPage(),ekyc,otpPage(),final,result][posts.length];
    });
    let outgoing = 100, incoming = 1;
    const sent = [];
    let adapterError;
    const submit = f.portal.submit.bind(f.portal);
    f.portal.submit = async (...args) => {
      try {
        const step = await submit(...args);
        if (step.kind === 'unsupported') adapterError = JSON.stringify({step,snapshot:await f.portal.snapshot()});
        return step;
      } catch (error) {adapterError = error.message; throw error;}
    };
    const bot = new OtrBot({allowedUserId:'42',portalFactory:() => f.portal,telegram:{
      send:async (_id,text) => {sent.push(text); return {message_id:outgoing++};},
      photo:async () => ({message_id:outgoing++}),
    }});
    const say = text => bot.handle({from:{id:42},chat:{id:42,type:'private'},message_id:incoming++,text});
    await bot.start(42,'register');
    for (const value of ['AGREE','1','9876543210','AbC12','001234','123456789012','654321','Example Father','Example Mother','example@example.com','AbC12']) {
      await say(value);
      assert.notEqual(bot.sessions.get(42).phase,'unknown',`After ${f.posts.length} synthetic POSTs: ${adapterError}`);
      assert.notEqual(bot.sessions.get(42).phase,'unsupported',`After ${f.posts.length} synthetic POSTs: ${adapterError}`);
    }
    assert.equal(bot.sessions.get(42).phase,'confirm');
    assert.equal(f.posts.length,5);
    await say('CONFIRM');
    assert.equal(f.posts.length,6);
    assert.equal(f.posts[3].get('aadhaar'),'123456789012');
    assert.equal(f.posts[5].get('father'),'Example Father');
    assert.equal(bot.sessions.get(42).phase,'done');
    assert.match(sent.at(-1),/00012345678901/);
  });

  await t.test('Recovery menu -> mobile -> refresh -> Hindi masked OTP -> result across AJAX updates',async () => {
    const ajax = html => html.replace('<form method="post">',`<form method="post" onsubmit="event.preventDefault();fetch(location.href,{method:'POST',body:new URLSearchParams(new FormData(this))}).then(r=>r.text()).then(html=>document.body.innerHTML=html)">`);
    for (const resultBody of [
      '<p>आपका ओ०टी०आर० संख्या: 00012345678901</p>',
      '<label for="result">OTR Number:</label><input id="result" readonly value="00012345678901">',
    ]) {
      const otpForm = ajax(page(input('otp','ओ०टी०पी०','password') + button('ओ०टी०पी० सत्यापित करें')));
      const f = await fixture('recover',(_req,_url,posts) => posts.length === 0 ? ajax(initial) : posts.length === 1 ? otpForm : page(resultBody));
      let outgoing = 100, incoming = 1;
      const sent = [];
      const telegram = {
        send:async (_id,text,options) => {sent.push({text,options}); return {message_id:outgoing++};},
        photo:async () => ({message_id:outgoing++}),
      };
      const otr = new OtrBot({telegram,allowedUserId:'42',portalFactory:() => f.portal});
      const router = new BotRouter({telegram,allowedUserId:'42',enableOtr:true,otr,recovery:{clear:async()=>{},expire:async()=>{}}});
      const say = text => router.handle({from:{id:42},chat:{id:42,type:'private'},message_id:incoming++,text});
      for (const text of ['/start','2','1','9876543210','/refresh']) await say(text);
      assert.equal(f.posts.length,0);
      assert.equal(otr.sessions.get(42).step.fields[otr.sessions.get(42).index].type,'captcha');
      await say('AbC12');
      assert.equal(otr.sessions.get(42).step.stage,'otp');
      await say('001234');
      assert.equal(otr.sessions.get(42).phase,'done');
      assert.equal(otr.sessions.get(42).savedMobile,undefined);
      await say('/result');
      assert.equal(f.posts.length,2);
      assert.equal(f.posts[0].get('ContentPlaceHolder1_txt_mobile'),'9876543210');
      assert.equal(f.posts[1].get('otp'),'001234');
      assert.match(sent.at(-1).text,/00012345678901/);
      assert.equal(sent.at(-1).options.protect_content,true);
    }
  });
});
