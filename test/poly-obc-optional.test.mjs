import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PolyPortal} from '../poly-portal.mjs';
import {ObcPolyPortal} from '../poly-obc-portal.mjs';
import {POLY_ORIGIN,PREFIX} from '../poly-schema.mjs';

const fields=()=>[
  {id:PREFIX+'ddl_Handitype',type:'select-one',value:'0',options:[{value:'0',label:'Select'},{value:'1',label:'Synthetic category'}]},
  {id:PREFIX+'txtfamilyid',type:'text',value:''},
];
test('OBC skips exactly two optional personal fields only while blank/unselected',()=>{
  const portal=new ObcPolyPortal(),snapshot={fields:fields()};
  assert.deepEqual(portal.optionalBlankFields('personal',snapshot),snapshot.fields.map(f=>f.id));
  assert.deepEqual(portal.optionalBlankFields('academic',snapshot),[]);
  assert.deepEqual(new PolyPortal().optionalBlankFields('personal',snapshot),[]);
  for(const change of [
    f=>{f[0].value='1';},
    f=>{f[0].required=true;},
    f=>{f[0].type='text';},
    f=>{f[0].options[0].label='Not disabled';},
    f=>{f[0].options[0].label='Select actual category already chosen';f[0].value='1';},
  ]) {
    const changed=fields();change(changed);
    assert.deepEqual(portal.optionalBlankFields('personal',{fields:changed}),[PREFIX+'txtfamilyid']);
  }
  for(const label of ['--चुनें--','चुनें','SELECT','Select Disability Type','--Select--']) {
    const changed=fields();changed[0].options[0].label=label;
    assert.ok(portal.optionalBlankFields('personal',{fields:changed}).includes(PREFIX+'ddl_Handitype'));
  }
  for(const change of [f=>{f[1].value='0';},f=>{f[1].required=true;},f=>{f[1].type='number';}]) {
    const changed=fields();change(changed);
    assert.deepEqual(portal.optionalBlankFields('personal',{fields:changed}),[PREFIX+'ddl_Handitype']);
  }
});

test('OBC optional personal fields remain untouched through review and an approved synthetic POST',
  {skip:process.env.OTR_BROWSER_TESTS!=='true'},async t=>{
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
  t.after(()=>browser.close());
  async function fixture(st,{family='',selected='0',required=false,unknown=false,general=false}={}) {
    const context=await browser.newContext();await context.setOffline(true);st.after(()=>context.close());
    const posts=[];
    await context.route('**/*',async route=>{
      assert.equal(new URL(route.request().url()).origin,POLY_ORIGIN);
      if(route.request().method()==='POST') {
        posts.push(new URLSearchParams(route.request().postData()));
        return route.fulfill({contentType:'text/html',body:`<form method="post"><input id="${PREFIX}txt_refundAmt"><input id="${PREFIX}txtcptcha5"><label for="${PREFIX}chkbx5">Synthetic declaration for fees.</label><input type="checkbox" id="${PREFIX}chkbx5"><input type="submit" id="${PREFIX}btn_Tab5"></form>`});
      }
      return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><form method="post">
        <select id="${PREFIX}ddl_Handitype" name="disability" ${required?'required':''}><option value="0">Select</option><option value="1" ${selected==='1'?'selected':''}>Synthetic category</option></select>
        <input type="text" id="${PREFIX}txtfamilyid" name="family" value="${family}">
        <input id="${PREFIX}txtfather_income" name="income">
        ${unknown?'<input id="anotherEditableField">':''}
        <input id="${PREFIX}txtcptcha2" name="captcha">
        <div><input type="checkbox" id="${PREFIX}chkbx2"><label for="${PREFIX}chkbx2">I declare these synthetic test details are correct.</label></div>
        <input type="submit" id="${PREFIX}btn_Tab2" value="Update">
      </form><script>window.optionalChanges=0;for(const id of ['${PREFIX}ddl_Handitype','${PREFIX}txtfamilyid'])for(const name of ['input','change'])document.getElementById(id).addEventListener(name,()=>window.optionalChanges++);</script>`});
    });
    const portal=general?new PolyPortal():new ObcPolyPortal();
    portal.sections=structuredClone(portal.sections);
    portal.sections.personal.fields=portal.sections.personal.fields.filter(f=>f.key==='txtfather_income');
    portal.context=context;portal.page=await context.newPage();portal.page.setDefaultTimeout(2000);portal.page.setDefaultNavigationTimeout(3000);
    await portal.page.goto(POLY_ORIGIN+'/PostMatric/ApplicationFormInstitute.aspx');
    return {portal,posts};
  }
  await t.test('Skip placeholders, ask income, review omissions, submit empty fields only after explicit call',async st=>{
    const f=await fixture(st);const step=await f.portal.read();
    assert.equal(step.kind,'field');assert.equal(step.field.key,'txtfather_income');
    const review=await f.portal.fill(step.field,'54000',step.token);
    assert.equal(review.kind,'review');assert.ok(review.review.includes('Family ID: left blank.'));
    assert.ok(review.review.includes('Disability type: left unselected.'));
    assert.equal(f.posts.length,0);assert.equal(await f.portal.page.evaluate(()=>window.optionalChanges),0);
    const next=await f.portal.submit('AbC12',review.token);
    assert.equal(next.stage,'fee');assert.equal(f.posts.length,1);
    assert.equal(f.posts[0].get('family'),'');assert.equal(f.posts[0].get('disability'),'0');
  });
  for(const options of [{family:'123456'},{selected:'1'},{required:true},{unknown:true},{general:true}]) await t.test(JSON.stringify(options)+' remains blocked',async st=>{
    const f=await fixture(st,options);const step=await f.portal.read();
    assert.equal(step.kind,'unsupported');assert.equal(f.posts.length,0);
  });
  await t.test('Changing an optional field after review cannot reuse the old approval token',async st=>{
    const f=await fixture(st);const step=await f.portal.read();
    const review=await f.portal.fill(step.field,'54000',step.token);
    await f.portal.page.locator('#'+PREFIX+'txtfamilyid').fill('123456');
    assert.equal((await f.portal.submit('AbC12',review.token)).kind,'unsupported');
    assert.equal(f.posts.length,0);
  });
});
