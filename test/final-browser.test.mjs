import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {FinalPortal} from '../final-portal.mjs';
import {POLY_ORIGIN,PREFIX as p} from '../poly-schema.mjs';

const form=body=>`<!doctype html><meta charset="utf-8"><form method="post">${body}</form>`;
const captcha='<img id="Captcha" src="/captcha-test.svg">';
const login=type=>form(`<label for="${p}rbtnFR_${type==='Fresh'?0:1}">${type}</label><input type="radio" id="${p}rbtnFR_${type==='Fresh'?0:1}" checked><input type="radio" id="${p}rbtnLoginType_0" checked>${['txtLogin','txtmob','txt_pwd','txtCaptcha'].map(id=>`<input name="${id}" id="${p+id}">`).join('')}${captcha}<input type="submit" id="${p}btnLogin" name="login">`);
const dashboard=({locked=false,print=false,wrong=false,dialog=false,external=false}={})=>form(`<table><tr><td>Registration number</td><td>${wrong?'999912345678':'000012345678'}</td></tr></table><script>function __doPostBack(){${dialog?'if(!confirm("Confirm final application lock?"))return;':''}document.forms[0].submit()}</script><li id="${p}templock">${locked?'Application locked ✓':`<a id="${p}Href_temp_lock" href="javascript:__doPostBack('ctl00$ContentPlaceHolder1$Href_temp_lock','')">Submit application after checking. Print after 3 days.</a>`}</li><li id="${p}FinalPrint">${print?`<a href="${external?'https://example.invalid/steal':'/PostMatric/FixtureFinalPrint.aspx'}">Final institution print</a>`:'Institution print not yet available'}</li>`);

test('Final portal uses only observed controls, separates waiting/unknown, handles dialog review and verifies PDF',{skip:process.env.OTR_BROWSER_TESTS!=='true'},async t=>{
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});t.after(()=>browser.close());
  t.afterEach(async()=>{for(const c of browser.contexts())await c.close();});
  async function fixture(options={}) {
    let posts=0,locked=!!options.locked,context;const type=options.type||'Fresh';
    const portal=new FinalPortal({applicationType:type,launch:async()=>({close:async()=>{},newContext:async opts=>{
      context=await browser.newContext(opts);await context.setOffline(true);
      await context.route('**/*',async route=>{
        const req=route.request(),u=new URL(req.url());if(u.origin!==POLY_ORIGIN)return route.abort();
        if(u.pathname==='/captcha-test.svg')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text y="20">AbC12</text></svg>'});
        if(/LoginStudentPost(?:Renew)?\.aspx/.test(u.pathname))return route.fulfill({contentType:'text/html',body:req.method()==='POST'?'<script>location.replace("/PostMatric/Default.aspx")</script>':login(type)});
        if(u.pathname==='/PostMatric/FixtureFinalPrint.aspx')return route.fulfill({contentType:'text/html',body:form('<h1>Official institution-submission application print</h1><p>Registration number: '+(options.wrongPdf?'999912345678':'000012345678')+'</p>')});
        if(u.pathname==='/PostMatric/Default.aspx') {
          if(req.method()==='POST'){posts++;if(!options.uncertain)locked=true;}
          return route.fulfill({contentType:'text/html',body:dashboard({...options,locked,print:locked&&options.print})});
        }
        return route.abort();
      });return context;
    }})});
    await portal.open();portal.registration='000012345678';portal.page.setDefaultNavigationTimeout(10_000);
    await portal.page.goto(POLY_ORIGIN+'/PostMatric/Default.aspx');
    return {portal,posts:()=>posts,context};
  }
  await t.test('Explicit lock only once; wait when final print disabled',async()=>{
    const f=await fixture();const review=await f.portal.read();assert.equal(review.kind,'lock-review');
    assert.equal((await f.portal.lock(review.token)).kind,'waiting');assert.equal(f.posts(),1);
    assert.equal((await f.portal.lock(review.token)).kind,'unknown');assert.equal(f.posts(),1);
  });
  await t.test('Already available print is readable PDF and never posts lock',async()=>{
    const f=await fixture({locked:true,print:true});assert.equal((await f.portal.read()).kind,'print-ready');
    const pdf=await f.portal.finalPdf();assert.equal(pdf.kind,'pdf');assert.equal(pdf.pages,1);assert.equal(f.posts(),0);
  });
  await t.test('Dialog is dismissed for review then accepted only when exactly approved',async()=>{
    const f=await fixture({dialog:true});const first=await f.portal.read();
    f.portal.page.setDefaultNavigationTimeout(2000);
    const dialog=await f.portal.lock(first.token);assert.equal(dialog.kind,'dialog-review');assert.equal(f.posts(),0);
    f.portal.page.setDefaultNavigationTimeout(10_000);
    assert.equal((await f.portal.lock(dialog.token,dialog.declaration)).kind,'waiting');assert.equal(f.posts(),1);
  });
  await t.test('Unchanged result is uncertain; stale review and different applicant cannot lock',async()=>{
    const f=await fixture({uncertain:true});assert.equal((await f.portal.lock('stale')).kind,'unsupported');assert.equal(f.posts(),0);
    const review=await f.portal.read();assert.equal((await f.portal.lock(review.token)).kind,'unknown');assert.equal(f.posts(),1);
    const wrong=await fixture({wrong:true});assert.equal((await wrong.portal.read()).kind,'unsupported');assert.equal(wrong.posts(),0);
  });
  await t.test('External print links and PDF identity mismatch are rejected',async()=>{
    for(const options of [{external:true},{wrongPdf:true}]) {const f=await fixture({...options,locked:true,print:true});await assert.rejects(f.portal.finalPdf());assert.equal(f.posts(),0);}
  });
  await t.test('Fresh and Renewal open their respective URL; Renewal requires an explicitly labelled mode',async()=>{
    for(const type of ['Fresh','Renewal']) {
      const f=await fixture({type});await f.portal.page.goto(POLY_ORIGIN+f.portal.loginPath);
      assert.ok(f.portal.page.url().endsWith(type==='Fresh'?'LoginStudentPost.aspx':'LoginStudentPostRenew.aspx'));
      assert.equal((await f.portal.login({registration:'000012345678',otr:'UP26-0000000001',password:'Synthetic1@',captcha:'AbC12'})).kind,'lock-review');
      if(type==='Renewal') {
        await f.portal.page.goto(POLY_ORIGIN+f.portal.loginPath);
        await f.portal.page.locator('label').evaluate(e=>{e.textContent='Unknown mode';});
        assert.equal((await f.portal.login({registration:'000012345678',otr:'UP26-0000000001',password:'Synthetic1@',captcha:'AbC12'})).kind,'unsupported');
      }
    }
  });
});
