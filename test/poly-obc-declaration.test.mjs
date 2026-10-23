import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ObcPolyPortal} from '../poly-obc-portal.mjs';
import {PolyPortal} from '../poly-portal.mjs';
import {POLY_ORIGIN,PREFIX} from '../poly-schema.mjs';

const enabled=process.env.OTR_BROWSER_TESTS==='true';
const schoolName='Y Y B INTER COLLEGE USRA BAZAR DEORIA';
const declaration='मैं घोषणा करता हूँ कि परीक्षण आवेदन के विवरण सही हैं। यह केवल परीक्षण घोषणा है।';
const checkbox=`<input type="checkbox" id="${PREFIX}chkbx1">`;

for(const generalRoute of [false,true]) test((generalRoute?'SC/ST/General':'OBC')+' school-name and declaration DOM handling (all requests intercepted)',{skip:!enabled},async t=>{
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
  t.after(()=>browser.close());
  async function fixture(st,markup,{general=generalRoute,maxLength=100,withFee=false}={}) {
    const context=await browser.newContext();await context.setOffline(true);st.after(()=>context.close());
    let posts=0;
    await context.route('**/*',async route=>{
      assert.equal(new URL(route.request().url()).origin,POLY_ORIGIN);
      if(route.request().method()==='POST')posts++;
      return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><form method="post">
        <input id="${PREFIX}Gridview1_txt_schoolname_0" maxlength="${maxLength}">
        ${withFee?`<input id="${PREFIX}Gridview1_txt_fee_0"><img id="Captcha" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='40'%3E%3Ctext y='25'%3EAbC12%3C/text%3E%3C/svg%3E">`:''}
        <input id="${PREFIX}txtcptcha1">
        ${markup}
        <input type="submit" id="${PREFIX}btn_Tab1" value="Update">
      </form>`});
    });
    const portal=general?new PolyPortal():new ObcPolyPortal();
    portal.sections=structuredClone(portal.sections);
    portal.sections.academic.fields=portal.sections.academic.fields.filter(f=>f.key==='Gridview1_txt_schoolname_0'||withFee&&f.key==='Gridview1_txt_fee_0');
    portal.context=context;portal.page=await context.newPage();portal.page.setDefaultTimeout(2000);
    await portal.page.goto(POLY_ORIGIN+'/PostMatric/ApplicationFormInstitute.aspx');
    return {portal,posts:()=>posts};
  }
  for(const [name,markup] of [
    ['associated label',`${checkbox}<label for="${PREFIX}chkbx1">${declaration}</label>`],
    ['wrapped label',`<label>${checkbox} ${declaration}</label>`],
    ['adjacent span',`<div><span>${checkbox}</span><span>${declaration}</span></div>`],
    ['unlabelled text',`<div>${checkbox} ${declaration}</div>`],
    ['ARIA reference',`${checkbox.replace('>',' aria-labelledby="declaration-text">')}<p id="declaration-text">${declaration}</p>`],
    ['separate table cells',`<table><tr><td>${checkbox}</td><td>${declaration}</td></tr></table>`],
  ])await t.test(name+' reaches review and retains the full school name',async st=>{
    const f=await fixture(st,markup);
    const step=await f.portal.read();assert.equal(step.field.type,'school-name');
    const review=await f.portal.fill(step.field,schoolName,step.token);
    assert.equal(review.kind,'review');assert.equal(review.declaration,declaration);
    assert.ok(review.review.includes('High-school name: '+schoolName));
    assert.equal(await f.portal.page.locator('#'+PREFIX+'Gridview1_txt_schoolname_0').inputValue(),schoolName);
    assert.equal(await f.portal.page.locator('#'+PREFIX+'chkbx1').isChecked(),false);
    assert.equal(f.posts(),0);
    assert.equal((await f.portal.read()).token,review.token);
  });
  for(const [name,markup] of [
    ['missing text',checkbox],
    ['unrelated text',`<div>${checkbox}<span>Continue to the next step</span></div>`],
    ['hidden text',`<div>${checkbox}<span hidden>${declaration}</span></div>`],
    ['text elsewhere in form',`${checkbox}<input disabled value="other"><p>${declaration}</p>`],
    ['disabled checkbox',`<div>${checkbox.replace('>',' disabled>')}${declaration}</div>`],
    ['missing checkbox',`<p>${declaration}</p>`],
    ['ambiguous ID',`<div>${checkbox}${checkbox}${declaration}</div>`],
  ])await t.test(name+' still blocks submission',async st=>{
    const f=await fixture(st,markup);
    const step=await f.portal.read();
    const next=await f.portal.fill(step.field,schoolName,step.token);
    assert.equal(next.kind,'unsupported');assert.match(next.message,/declaration could not be read/);
    assert.equal(f.posts(),0);
  });
  await t.test('Changed adjacent declaration invalidates the reviewed token before any submission',async st=>{
    const f=await fixture(st,`<div>${checkbox}<span id="declaration-text">${declaration}</span></div>`);
    const step=await f.portal.read();const review=await f.portal.fill(step.field,schoolName,step.token);
    await f.portal.page.locator('#declaration-text').evaluate(e=>e.textContent+=' New condition.');
    assert.notEqual((await f.portal.read()).token,review.token);
    assert.equal((await f.portal.submit('AbC12',review.token)).kind,'unsupported');
    assert.equal(f.posts(),0);
  });
  await t.test('General adjacent declaration now reaches review',async st=>{
    const f=await fixture(st,`<div>${checkbox}<span>${declaration}</span></div>`,{general:true});
    const step=await f.portal.read();const next=await f.portal.fill(step.field,schoolName,step.token);
    assert.equal(next.kind,'review');assert.equal(next.declaration,declaration);assert.equal(f.posts(),0);
  });
  await t.test('Last academic fee 634 reaches declaration review and supplies current CAPTCHA without a POST',async st=>{
    const f=await fixture(st,`<div><span>${checkbox}</span><span>${declaration}</span></div>`,{withFee:true});
    const school=await f.portal.read(),fee=await f.portal.fill(school.field,schoolName,school.token);
    assert.equal(fee.field.key,'Gridview1_txt_fee_0');assert.equal(fee.field.suggestion,'634');
    const review=await f.portal.fill(fee.field,fee.field.suggestion,fee.token);
    assert.equal(review.kind,'review');assert.equal(review.declaration,declaration);
    assert.ok(review.review.includes('High-school fee field: 634'));
    assert.ok((await f.portal.captcha()).length>100);assert.equal(f.posts(),0);
    assert.equal(await f.portal.page.locator('#'+PREFIX+'chkbx1').isChecked(),false);
  });
});
