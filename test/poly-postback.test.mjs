import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PolyPortal} from '../poly-portal.mjs';
import {POLY_ORIGIN,POLY_SECTIONS,PREFIX} from '../poly-schema.mjs';

const enabled=process.env.OTR_BROWSER_TESTS==='true';

async function fixture(t,{selected='school'}={}) {
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
  t.after(()=>browser.close());
  const context=await browser.newContext();await context.setOffline(true);
  let posts=0,current=selected;
  await context.route('**/*',async route=>{
    const request=route.request();assert.equal(new URL(request.url()).origin,POLY_ORIGIN);
    if(request.method()==='POST') {posts++;current=new URLSearchParams(request.postData()).get('qualification');}
    await route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><form method="post">
      <script>function __doPostBack(){HTMLFormElement.prototype.submit.call(document.forms[0])}</script>
      <select id="${PREFIX}ddl_InterOrNot" name="qualification" onchange="setTimeout('__doPostBack()',0)">
        <option value="">SELECT</option><option value="school" ${current==='school'?'selected':''}>हाई स्कूल</option>
      </select>
      <select id="${PREFIX}ddl_UniBrdName"><option value="">SELECT</option><option value="technical">U.P Board Of Technical Education</option></select>
      <input id="${PREFIX}txtcptcha1"><label for="${PREFIX}chkbx1">Synthetic test declaration</label><input type="checkbox" id="${PREFIX}chkbx1">
      <input type="submit" id="${PREFIX}btn_Tab1" value="Submit">
      </form>`});
  });
  const sections=structuredClone(POLY_SECTIONS);
  sections.academic.fields=sections.academic.fields.filter(field=>['ddl_InterOrNot','ddl_UniBrdName'].includes(field.key));
  const portal=new PolyPortal({sections});portal.context=context;portal.browser=browser;portal.page=await context.newPage();
  portal.page.setDefaultTimeout(3000);portal.page.setDefaultNavigationTimeout(3000);
  await portal.page.goto(POLY_ORIGIN+'/PostMatric/ApplicationFormInstitute.aspx');
  return {portal,posts:()=>posts};
}

test('Accepting a preselected academic default does not dispatch its ASP.NET change postback',{skip:!enabled},async t=>{
  const f=await fixture(t);const step=await f.portal.read();
  assert.equal(step.field.key,'ddl_InterOrNot');assert.equal(step.field.suggestion,'school');
  const next=await f.portal.fill(step.field,step.field.suggestion,step.token);
  assert.equal(next.kind,'field');assert.equal(next.field.key,'ddl_UniBrdName');
  assert.equal(f.posts(),0);assert.equal(f.portal.values().ddl_InterOrNot,'school');
});

test('Changing an academic default waits for its timed ASP.NET postback and reads the next field',{skip:!enabled},async t=>{
  const f=await fixture(t,{selected:''});const step=await f.portal.read();
  const next=await f.portal.fill(step.field,step.field.suggestion,step.token);
  assert.equal(next.kind,'field');assert.equal(next.field.key,'ddl_UniBrdName');
  assert.equal(f.posts(),1);assert.equal(f.portal.values().ddl_InterOrNot,'school');
});
