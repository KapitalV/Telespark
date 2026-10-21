import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {FinalPortal} from '../final-portal.mjs';
import {validatePolyPdf,validatePortalErrorPdf} from '../poly-pdf.mjs';
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
        if(u.pathname==='/PostMatric/FinalDisclaimer.aspx') {
          if(options.requireReferrer)assert.match(req.headers().referer||'',/\/PostMatric\/Default\.aspx/);
          return route.fulfill({contentType:'text/html',body:`<script>${options.errorRedirect?'alert("Some Error Occurred");':''}${options.printConfirm?'if (!confirm("Declaration: continue to institution print?")) throw Error("Print cancelled");':''}${options.printAlert?'alert("Read the institution print declaration.");':''}setTimeout(()=>location.replace('${options.errorRedirect?'/errorpage.aspx':options.badRedirect?'/PostMatric/UnknownPrint.aspx':'/PostMatric/FinalPrintInstitute.aspx'}'),${options.delayed?600:0})</script>`});
        }
        if(u.pathname==='/errorpage.aspx')return route.fulfill({contentType:'text/html',body:form(options.unrecognizedError?'<h1>Unrecognized page</h1>':'<h1>Some Error Occurred</h1><p>Your Request Could Not Be Processed. Try again later.</p>')});
        if(u.pathname==='/PostMatric/FinalPrintInstitute.aspx')return route.fulfill({contentType:'text/html',body:form(options.portalError?"System.ArgumentException: Column 'AboutMotherFather' does not belong to table Table.<h1>Institution print</h1><p>Registration number:</p>":'<h1>Official institution print</h1><p>Registration number: 000012345678</p>')});
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
  await t.test('Observed disclaimer redirect produces a validated PDF without another lock',async()=>{
    const f=await fixture({locked:true,print:true});
    await f.portal.page.locator('#'+p+'FinalPrint a').evaluate(el=>el.setAttribute('href','/PostMatric/FinalDisclaimer.aspx'));
    const result=await f.portal.finalPdf();assert.equal(result.kind,'pdf');assert.equal(result.pages,1);assert.equal(f.posts(),0);
  });
  await t.test('Print click preserves dashboard referrer and waits for delayed disclaimer redirect',async()=>{
    const f=await fixture({locked:true,print:true,delayed:true,requireReferrer:true});
    await f.portal.page.locator('#'+p+'FinalPrint a').evaluate(el=>el.setAttribute('href','/PostMatric/FinalDisclaimer.aspx'));
    const result=await f.portal.finalPdf();assert.equal(result.kind,'pdf');assert.equal(f.posts(),0);
  });
  await t.test('A new-tab final print uses the same isolated context and preserves applicant validation',async()=>{
    const f=await fixture({locked:true,print:true,delayed:true,requireReferrer:true});
    const dashboardPage=f.portal.page;
    await dashboardPage.locator('#'+p+'FinalPrint a').evaluate(el=>{el.href='/PostMatric/FinalDisclaimer.aspx';el.target='_blank';});
    const result=await f.portal.finalPdf();assert.equal(result.kind,'pdf');assert.notEqual(f.portal.page,dashboardPage);assert.equal(f.portal.page.context(),f.context);assert.equal(f.posts(),0);
  });
  await t.test('Printing cannot submit a form POST or lock through an unexpected click handler',async()=>{
    const f=await fixture({locked:true,print:true});
    await f.portal.page.locator('#'+p+'FinalPrint a').evaluate(el=>el.setAttribute('onclick',"document.forms[0].submit(); return false;"));
    await assert.rejects(f.portal.finalPdf());assert.equal(f.posts(),0);
  });
  await t.test('Optional print OK on the dashboard accepts once and produces a PDF',async()=>{
    const f=await fixture({locked:true,print:true});let dialogs=0;
    f.portal.page.on('dialog',()=>dialogs++);
    await f.portal.page.locator('#'+p+'FinalPrint a').evaluate(el=>el.setAttribute('onclick',"return confirm('Continue to institution print?')"));
    assert.equal((await f.portal.finalPdf()).kind,'pdf');assert.equal(dialogs,1);assert.equal(f.posts(),0);
    assert.equal(f.portal.printDialogs,undefined);
    await f.portal.page.evaluate(()=>{window.afterPrintAccepted=confirm('Unrelated confirmation');});
    assert.equal(await f.portal.page.evaluate(()=>window.afterPrintAccepted),false);
  });
  await t.test('Optional disclaimer OK works in same-tab and new-tab print navigation',async()=>{
    for(const popup of [false,true]) {
      const f=await fixture({locked:true,print:true,printConfirm:true,printAlert:true});
      await f.portal.page.locator('#'+p+'FinalPrint a').evaluate((el,popup)=>{el.href='/PostMatric/FinalDisclaimer.aspx';if(popup)el.target='_blank';},popup);
      const result=await f.portal.finalPdf();assert.equal(result.kind,'pdf');assert.equal(f.posts(),0);
      assert.equal(f.portal.printDialogs,undefined);
    }
  });
  await t.test('Accepting print OK never permits a form POST',async()=>{
    const f=await fixture({locked:true,print:true});
    await f.portal.page.locator('#'+p+'FinalPrint a').evaluate(el=>el.setAttribute('onclick',"if(confirm('Continue to print?'))document.forms[0].submit(); return false;"));
    await assert.rejects(f.portal.finalPdf());assert.equal(f.posts(),0);assert.equal(f.portal.printDialogs,undefined);
  });
  await t.test('Input prompts and repeated print dialogs stop without producing a PDF',async()=>{
    for(const script of ["prompt('Enter extra data'); return true;","for(let i=0;i<4;i++)confirm('Continue printing?'); return true;"]) {
      const f=await fixture({locked:true,print:true});
      await f.portal.page.locator('#'+p+'FinalPrint a').evaluate((el,script)=>el.setAttribute('onclick',script),script);
      await assert.rejects(f.portal.finalPdf(),e=>e.code==='FINAL-PAGE');assert.equal(f.posts(),0);
      assert.equal(f.portal.printDialogs,undefined);
    }
  });
  await t.test('Requested error-page print produces a readable diagnostic PDF, never a valid application',async()=>{
    const f=await fixture({locked:true,print:true,portalError:true});
    await f.portal.page.locator('#'+p+'FinalPrint a').evaluate(el=>el.setAttribute('href','/PostMatric/FinalDisclaimer.aspx'));
    const result=await f.portal.finalPdf();assert.equal(result.kind,'print-error-pdf');assert.equal(result.pages,1);assert.equal(f.posts(),0);
    await validatePortalErrorPdf(result.bytes);await assert.rejects(validatePolyPdf(result.bytes,'000012345678'));
  });
  await t.test('Observed errorpage.aspx redirect and acknowledged error alert produce only an INCOMPLETE PDF',async()=>{
    const f=await fixture({locked:true,print:true,errorRedirect:true});
    await f.portal.page.locator('#'+p+'FinalPrint a').evaluate(el=>el.href='/PostMatric/FinalDisclaimer.aspx');
    const result=await f.portal.finalPdf();assert.equal(result.kind,'print-error-pdf');assert.equal(f.posts(),0);
    await validatePortalErrorPdf(result.bytes);await assert.rejects(validatePolyPdf(result.bytes,'000012345678'));
  });
  await t.test('An errorpage.aspx response without recognized error text is never delivered as a PDF',async()=>{
    const f=await fixture({locked:true,print:true,errorRedirect:true,unrecognizedError:true});
    await f.portal.page.locator('#'+p+'FinalPrint a').evaluate(el=>el.href='/PostMatric/FinalDisclaimer.aspx');
    await assert.rejects(f.portal.finalPdf(),e=>e.code==='FINAL-PAGE'&&Buffer.isBuffer(e.image));assert.equal(f.posts(),0);
  });
  await t.test('Disclaimer cannot redirect to an unmapped destination',async()=>{
    const f=await fixture({locked:true,print:true,badRedirect:true});
    await f.portal.page.locator('#'+p+'FinalPrint a').evaluate(el=>el.setAttribute('href','/PostMatric/FinalDisclaimer.aspx'));
    await assert.rejects(f.portal.finalPdf());assert.equal(f.posts(),0);
  });
  await t.test('Observed locked span and check icon mean waiting, never print-ready',async()=>{
    const f=await fixture({locked:true});
    await f.portal.page.locator('#'+p+'templock').evaluate(el=>{el.innerHTML='<span id="ContentPlaceHolder1_Span_temp_lock">Print after 3 days</span><i id="ContentPlaceHolder1_Img_temp_lock" class="fa fa-check-circle CompletedImg"></i>';});
    await f.portal.page.locator('#'+p+'FinalPrint').evaluate(el=>{el.innerHTML='<span id="ContentPlaceHolder1_Span_final_Form">संस्था में जमा करने हेतु आवेदन प्रिंट करें</span>';});
    assert.equal((await f.portal.read()).kind,'waiting');assert.equal(f.posts(),0);
    await assert.rejects(f.portal.finalPdf(),/not available/);assert.equal(f.posts(),0);
  });
  await t.test('Dialog is dismissed for review then accepted only when exactly approved',async()=>{
    const f=await fixture({dialog:true});const first=await f.portal.read();
    f.portal.page.setDefaultNavigationTimeout(2000);
    const dialog=await f.portal.lock(first.token);assert.equal(dialog.kind,'dialog-review');assert.equal(f.posts(),0);
    f.portal.page.setDefaultNavigationTimeout(10_000);
    assert.equal((await f.portal.lock(dialog.token,dialog.declaration)).kind,'waiting');assert.equal(f.posts(),1);
  });
  await t.test('Live-style onclick confirmation is included in initial review and accepted once',async()=>{
    const f=await fixture();
    const declaration='Are You Sure to Submit form for Preliminarily Scrutiny (Please make Sure after select Yes will not able to edit Application)?';
    await f.portal.page.locator('#'+p+'Href_temp_lock').evaluate((el,text)=>el.setAttribute('onclick',`return confirm('${text}')`),declaration);
    const review=await f.portal.read();assert.equal(review.declaration,declaration);
    assert.equal((await f.portal.lock(review.token,'unreviewed')).kind,'dialog-review');assert.equal(f.posts(),0);
    assert.equal((await f.portal.lock(review.token,declaration)).kind,'waiting');assert.equal(f.posts(),1);
    assert.equal((await f.portal.lock(review.token,declaration)).kind,'unknown');assert.equal(f.posts(),1);
  });
  await t.test('Changed confirmation invalidates the original review before submitting',async()=>{
    const f=await fixture();
    const link=f.portal.page.locator('#'+p+'Href_temp_lock');
    await link.evaluate(el=>el.setAttribute('onclick',"return confirm('Original warning')"));
    const review=await f.portal.read();
    await link.evaluate(el=>el.setAttribute('onclick',"return confirm('Changed warning')"));
    assert.equal((await f.portal.lock(review.token,review.declaration)).kind,'unsupported');assert.equal(f.posts(),0);
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
