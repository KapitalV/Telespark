import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ObcPolyPortal} from '../poly-obc-portal.mjs';
import {PolyPortal} from '../poly-portal.mjs';
import {POLY_ORIGIN,PREFIX,POLY_SECTIONS} from '../poly-schema.mjs';

const enabled=process.env.OTR_BROWSER_TESTS==='true';
const courseId=PREFIX+'ddl_CourseName',branchId=PREFIX+'ddl_CurrentCourse_Branch';
const courseName='ctl00$ContentPlaceHolder1$ddl_CourseName';
const group4='opaque-course-473',group3='opaque-course-198',electricalValue='opaque-electrical-862';
const branches=course=>course===group4?[['cs-after-g4','Diploma in Computer Science & Engg.'],[electricalValue,'Electrical Engineering']]:[['cs-after-g3','Diploma in Computer Science & Engg.']];

test('OBC course/branch cascade uses current values and waits for dependent controls (all requests intercepted)',{skip:!enabled},async t=>{
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});t.after(()=>browser.close());
  async function fixture(st,{mode='full',selected='',timeout=3000,unknown=false,branchOptions,courseLabel='Diploma In Engg. 3 Yrs (Group 4)'}={}) {
    const context=await browser.newContext();await context.setOffline(true);st.after(()=>context.close());
    const posts=[];let course=selected;const courseBranches=value=>branchOptions||branches(value);
    const pageHtml=()=>{
      const initial=selected?courseBranches(selected):mode==='same-options'?courseBranches(group4):[['old-cs','Diploma in Computer Science & Engg.']];
      const branchHtml=initial.map(([value,label])=>`<option value="${value}">${label}</option>`).join('');
      // Match the live Course select's ASP.NET inline handler, using synthetic values.
      const postback=mode==='client-ajax'?'loadBranches()':`javascript:setTimeout('__doPostBack(\\'${courseName}\\',\\'\\')', 0)`;
      return `<!doctype html><meta charset="utf-8"><form method="post">
      <input type="hidden" name="__EVENTTARGET" value="${courseName}"><input type="hidden" name="__VIEWSTATE" value="SYNTHETIC_ONLY">
      <select id="${courseId}" name="${courseName}" onchange="${postback}"><option value="">SELECT</option><option value="${group3}" ${course===group3?'selected':''}>Diploma Engg (Group3)</option><option value="${group4}" ${course===group4?'selected':''}>${courseLabel}</option></select>
      <select id="${branchId}" name="branch"><option value="">SELECT</option>${branchHtml}</select>
      <input id="${PREFIX}txtcptcha1"><label for="${PREFIX}chkbx1">Synthetic declaration</label><input type="checkbox" id="${PREFIX}chkbx1"><input type="submit" id="${PREFIX}btn_Tab1" name="final" value="Submit">
      ${unknown&&course?'<input id="unmappedVerification">':''}
      </form><script>
      window.fixtureReady=${JSON.stringify(selected)};let busy=false;
      window.Sys={WebForms:{PageRequestManager:{getInstance:()=>({get_isInAsyncPostBack:()=>busy})}}};
      function applyOptions(data){setTimeout(()=>{${mode==='stalled'?'busy=false;return;':''}
        const branch=document.getElementById('${branchId}');branch.replaceChildren(new Option('SELECT',''),...data.options.map(([value,label])=>new Option(label,value)));branch.disabled=false;busy=false;window.fixtureReady=document.getElementById('${courseId}').value;
      },70)}
      function loadBranches(){busy=true;${mode==='same-options'?'':`document.getElementById('${branchId}').disabled=true;`}
        fetch(location.href,{method:'POST',headers:{'X-Fixture-Cascade':'ajax'},body:new URLSearchParams(new FormData(document.forms[0]))}).then(response=>response.json()).then(applyOptions);
      }
      function __doPostBack(){${mode==='full'?'HTMLFormElement.prototype.submit.call(document.forms[0]);':'loadBranches();'}}
      ${mode==='full'&&course?`busy=true;document.getElementById('${branchId}').disabled=true;applyOptions({options:${JSON.stringify(courseBranches(course))}});`:''}
      </script>`;
    };
    await context.route('**/*',async route=>{
      const request=route.request();assert.equal(new URL(request.url()).origin,POLY_ORIGIN);
      if(request.method()==='POST') {
        const data=new URLSearchParams(request.postData());posts.push(data);course=data.get(courseName);
        assert.equal(data.get('__EVENTTARGET'),courseName);
        if(mode==='error') return route.fulfill({status:503,body:'Synthetic failure'});
        if(request.headers()['x-fixture-cascade']==='ajax') return route.fulfill({contentType:'application/json',body:JSON.stringify({options:courseBranches(course)})});
      }
      return route.fulfill({contentType:'text/html',body:pageHtml()});
    });
    const portal=new ObcPolyPortal({cascadeTimeoutMs:timeout});portal.context=context;portal.page=await context.newPage();
    portal.sections.academic.fields=portal.sections.academic.fields.filter(field=>['ddl_CourseName','ddl_CurrentCourse_Branch'].includes(field.key));
    portal.page.setDefaultTimeout(3000);portal.page.setDefaultNavigationTimeout(3000);
    await portal.page.goto(POLY_ORIGIN+'/PostMatric/ApplicationFormInstitute.aspx');
    return {portal,posts};
  }

  for(const mode of ['full','ajax','client-ajax','same-options']) await t.test(mode+' course update waits for populated branch options before offering Electrical Engineering',async st=>{
    const f=await fixture(st,{mode});const step=await f.portal.read();
    const dom=await f.portal.snapshot(),course=dom.fields.find(field=>field.id===courseId),branch=dom.fields.find(field=>field.id===branchId);
    assert.equal(course.type,'select-one');assert.equal(course.postback,mode!=='client-ajax');assert.equal(branch.type,'select-one');
    assert.equal(step.field.suggestion,group4);assert.equal(step.field.autoDefault,undefined);
    const next=await f.portal.fill(step.field,step.field.suggestion,step.token);
    assert.equal(next.kind,'field');assert.equal(next.field.key,'ddl_CurrentCourse_Branch');assert.equal(next.field.suggestion,electricalValue);
    assert.equal(await f.portal.page.evaluate(()=>window.fixtureReady),group4);
    assert.deepEqual(next.field.options.map(option=>option.value),['cs-after-g4',electricalValue]);
    const review=await f.portal.fill(next.field,electricalValue,next.token);
    assert.equal(review.kind,'review');assert.ok(review.review.some(line=>line==='Course: Diploma In Engg. 3 Yrs (Group 4)'));assert.ok(review.review.includes('Branch: Electrical Engineering'));
    assert.equal(f.posts.length,1);assert.equal(f.posts[0].get(courseName),group4);assert.equal(f.posts.some(post=>post.has('final')),false);
  });

  await t.test('A preselected course does not dispatch another postback',async st=>{
    const f=await fixture(st,{mode:'ajax',selected:group4});const step=await f.portal.read();
    const next=await f.portal.fill(step.field,group4,step.token);assert.equal(next.field.suggestion,electricalValue);assert.equal(f.posts.length,0);
  });

  for(const mode of ['full','ajax']) await t.test(mode+' observed OBC labels offer Group 4 then Diploma in Electrical using live option values',async st=>{
    const label='Diploma Engg. 3 yrs Group 4';
    const f=await fixture(st,{mode,courseLabel:label,branchOptions:[[electricalValue,'Diploma in Electrical']]});
    let step=await f.portal.read();assert.equal(step.field.suggestion,group4);
    step=await f.portal.fill(step.field,group4,step.token);
    assert.equal(step.kind,'field');assert.equal(step.field.key,'ddl_CurrentCourse_Branch');
    assert.deepEqual(step.field.options,[{value:electricalValue,label:'Diploma in Electrical'}]);assert.equal(step.field.suggestion,electricalValue);
    step=await f.portal.fill(step.field,electricalValue,step.token);assert.equal(step.kind,'review');
    assert.ok(step.review.includes('Course: '+label));assert.ok(step.review.includes('Branch: Diploma in Electrical'));
    assert.equal(f.posts.length,1);assert.equal(f.posts[0].get(courseName),group4);assert.equal(f.posts.some(post=>post.has('final')),false);
  });
  await t.test('Formatted and other official branch labels remain selectable instead of producing an unsupported-options error',async st=>{
    const options=[['branch-live-04','04 - ELECTRICAL ENGG. (REGULAR)'],['branch-live-05','MECHANICAL ENGG.']];
    const f=await fixture(st,{mode:'ajax',branchOptions:options});let step=await f.portal.read();step=await f.portal.fill(step.field,group4,step.token);
    assert.equal(step.kind,'field');assert.equal(step.field.key,'ddl_CurrentCourse_Branch');assert.equal(step.field.suggestion,undefined);assert.deepEqual(step.field.options.map(option=>[option.value,option.label]),options);
    step=await f.portal.fill(step.field,'branch-live-04',step.token);assert.equal(step.kind,'review');assert.ok(step.review.includes('Branch: 04 - ELECTRICAL ENGG. (REGULAR)'));assert.equal(f.posts.some(post=>post.has('final')),false);
  });
  await t.test('Editing course clears the old branch, rejects its stale value and does not guess a substitute',async st=>{
    const f=await fixture(st);let step=await f.portal.read();step=await f.portal.fill(step.field,group4,step.token);step=await f.portal.fill(step.field,electricalValue,step.token);
    step=await f.portal.edit('ddl_CourseName');assert.equal(f.portal.answers.has('ddl_CurrentCourse_Branch'),false);
    step=await f.portal.fill(step.field,group3,step.token);assert.equal(step.field.suggestion,undefined);assert.deepEqual(step.field.options.map(option=>option.value),['cs-after-g3']);
    await assert.rejects(f.portal.fill(step.field,electricalValue,step.token),/Select an option/);assert.equal(f.posts.length,2);
  });
  await t.test('Re-accepting a portal-reset course invalidates old branch answers even when the option values match',async st=>{
    const f=await fixture(st);let step=await f.portal.read();step=await f.portal.fill(step.field,group4,step.token);await f.portal.fill(step.field,electricalValue,step.token);
    f.portal.answers.delete('ddl_CourseName');step=await f.portal.read();assert.equal(step.field.key,'ddl_CourseName');
    step=await f.portal.fill(step.field,group4,step.token);assert.equal(step.field.key,'ddl_CurrentCourse_Branch');assert.equal(f.portal.answers.has('ddl_CurrentCourse_Branch'),false);assert.equal(f.posts.length,1);
  });
  await t.test('Missing branch update and HTTP failure stop after one course request',async st=>{
    for(const mode of ['stalled','error']) {
      const f=await fixture(st,{mode,timeout:2000});const step=await f.portal.read();
      await assert.rejects(f.portal.fill(step.field,group4,step.token));assert.equal(f.posts.length,1);assert.equal(f.portal.answers.has('ddl_CourseName'),false);
      assert.equal(f.posts.some(post=>post.has('final')),false);
    }
  });
  await t.test('Unknown controls and stale tokens retain submission guards',async st=>{
    const f=await fixture(st,{unknown:true});let step=await f.portal.read();assert.equal((await f.portal.fill(step.field,group4,'stale')).kind,'unsupported');assert.equal(f.posts.length,0);
    step=await f.portal.fill(step.field,group4,step.token);assert.equal(step.kind,'unsupported');assert.match(step.message,/OBC-FIELDS/);assert.equal(f.posts.length,1);
  });
  await t.test('SC/ST/General uses its original course/branch mapping and adapter',()=>{
    const portal=new PolyPortal();assert.equal(portal.sections,POLY_SECTIONS);
    assert.equal(portal.sections.academic.fields.find(field=>field.key==='ddl_CurrentCourse_Branch').filter,'branch');
    assert.equal(portal.sections.academic.fields.find(field=>field.key==='ddl_CourseName').preferredGroup,undefined);
  });
});
