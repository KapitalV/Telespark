import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ScholarshipPortal} from '../portal.mjs';

const origin='https://scholarship.up.gov.in';
const p='ContentPlaceHolder1_';
const account={applicationType:'Renewal',registration:'000123456789',dob:'01/01/2000',board:'UP BOARD',year:'2021',roll:'000012345'};
const receipt='<p>Registration Number: 000123456789</p><p>Password: Example1@</p>';
const form=(action,script='')=>`<!doctype html><meta charset="utf-8"><form method="post" action="${action}"><input type="radio" id="${p}rbtnFR_0" checked><input id="${p}txtLogin" name="registration"><input id="${p}txtdob"><select id="${p}ddl_board"><option>UP BOARD</option></select><select id="${p}ddl_highschpassyear"><option>2021</option></select><input id="${p}txt_roll"><input id="${p}txtCaptcha" name="captcha"><img id="Captcha" src="/captcha.svg"><button id="${p}btnLogin">Recover</button></form>${script}`;

test('Password recovery browser responses (all requests intercepted)',{skip:process.env.OTR_BROWSER_TESTS!=='true'},async t=>{
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
  t.after(()=>browser.close());
  async function fixture({mode='print',result=receipt,action='/ForgetPwd.aspx'}={}) {
    let context;let posts=0;
    const events=[],requests=[];
    const script=mode==='ajax'?'<script>document.forms[0].onsubmit=async e=>{e.preventDefault();document.body.innerHTML=await (await fetch(location.href,{method:"POST"})).text()}</script>':mode==='dialog'?'<script>document.forms[0].onsubmit=e=>{e.preventDefault();alert("Invalid Captcha")}</script>':'<script>document.forms[0].onsubmit=async e=>{e.preventDefault();await fetch(location.href,{method:"POST"});location.href="/ForgetPasswordPrint.aspx"}</script>';
    const portal=new ScholarshipPortal({responseTimeoutMs:800,onDiagnostic:e=>events.push(e),launch:async()=>({newContext:async options=>{
      context=await browser.newContext(options);
      // Block all real network traffic, including redirect continuations which
      // Chromium can issue without invoking the original route handler again.
      await context.setOffline(true);
      await context.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        requests.push([request.method(),url.pathname]);
        if(url.origin!==origin) return route.abort();
        if(url.pathname==='/captcha.svg') return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text y="25">AbC12</text></svg>'});
        if(url.pathname==='/ForgetPasswordPrint.aspx') return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8">${result}`});
        if(request.method()==='POST') {
          posts++;
          if(mode==='print') return route.fulfill({contentType:'text/plain',body:'ready'});
          return route.fulfill({contentType:'text/html',body:result});
        }
        return route.fulfill({contentType:'text/html',body:form(action,script)});
      });return context;
    },close:async()=>context?.close()})});
    t.after(()=>portal.close());
    await portal.open(account);
    return {portal,events,requests,posts:()=>posts};
  }
  await t.test('Full navigation recognizes a matching result, preserves password and screenshots it',async()=>{
    const f=await fixture();const result=await f.portal.submit('AbC12');
    assert.equal(result.kind,'success',JSON.stringify({events:f.events,requests:f.requests,url:f.portal.page.url()}));assert.equal(result.password,'Example1@');assert.ok(result.slip.length);
    assert.equal(f.posts(),1);await f.portal.submit('AbC12');assert.equal(f.posts(),1);
    assert.doesNotMatch(JSON.stringify(f.events),/Example1@|000123456789|000012345/);
  });
  await t.test('AJAX validation works without a document navigation',async()=>{
    const f=await fixture({mode:'ajax',result:'<p>High School Board year not matched...! Try Again.</p>'});
    const result=await f.portal.submit('AbC12');assert.equal(result.kind,'correction');assert.equal(result.field,'year');assert.equal(f.posts(),1);
  });
  await t.test('Client-side CAPTCHA alert is recognized without a form POST',async()=>{
    const f=await fixture({mode:'dialog'});const result=await f.portal.submit('AbC12');assert.equal(result.kind,'captcha');assert.equal(f.posts(),0);
  });
  await t.test('Unrecognized print layout returns the official screenshot instead of throwing it away',async()=>{
    const f=await fixture({result:'<h2>Recovery completed</h2><table><tr><td>Registration identifier</td><td>000123456789</td></tr><tr><td>New credential</td><td>Example1@</td></tr></table>'});
    const result=await f.portal.submit('AbC12');assert.equal(result.kind,'response-image');assert.ok(result.slip.length);assert.equal(f.posts(),1);
  });
  await t.test('A response containing another registration never sends a password or screenshot',async()=>{
    const f=await fixture({result:receipt.replace('000123456789','999123456789')});
    const result=await f.portal.submit('AbC12');assert.equal(result.kind,'unknown');assert.equal(result.slip,undefined);
  });
  await t.test('Navigation deadline still reads and screenshots the current official page',async()=>{
    const f=await fixture({mode:'ajax',result:form('/ForgetPwd.aspx')});
    const result=await f.portal.submit('AbC12');assert.equal(result.kind,'response-image');assert.ok(result.slip.length);assert.equal(f.posts(),1);
  });
  await t.test('An external submit destination receives no request',async()=>{
    const f=await fixture({action:'https://example.com/recovery'});
    const result=await f.portal.submit('AbC12');assert.equal(result.kind,'unknown');assert.equal(f.posts(),0);
  });
});
