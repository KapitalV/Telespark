import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {PolyPortal} from '../poly-portal.mjs';
import {ObcPolyPortal,createPolyPortal} from '../poly-obc-portal.mjs';
import {OBC_SECTIONS} from '../poly-obc-schema.mjs';
import {POLY_ORIGIN,PREFIX as p,POLY_SECTIONS} from '../poly-schema.mjs';
import {validatePolyPdf} from '../poly-pdf.mjs';

const enabled=process.env.OTR_BROWSER_TESTS==='true';
const html=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const form=body=>`<!doctype html><meta charset="utf-8"><style>body{font:16px Arial}input,select{display:block;margin:8px}label{display:block}</style><form method="post">${body}</form>`;
const image=(id='Captcha',refresh='reloadcaptcha')=>`<img id="${id}" src="/test-captcha.svg?1"><button type="button" id="${refresh}" onclick="document.getElementById('${id}').src='/test-captcha.svg?'+Date.now()">Refresh</button>`;
const submit=(id,name='submit')=>`<input id="${p+id}" name="${name}" value="Update" type="submit">`;
const loginPage=(type='Fresh')=>form(`<label for="${p}rbtnFR_${type==='Fresh'?0:1}">${type}</label><input type="radio" id="${p}rbtnFR_${type==='Fresh'?0:1}" checked><input type="radio" id="${p}rbtnLoginType_0" checked>${['txtLogin','txtmob','txt_pwd','txtCaptcha'].map(id=>`<input id="${p+id}" name="${id}" type="${id==='txt_pwd'?'password':'text'}">`).join('')}${image()}${submit('btnLogin','login')}`);
function sectionPage(stage,values,{extra='',dropDependent=false,intermediateValues={},categoryRoute}={}) {
  const section=(categoryRoute==='obc'?OBC_SECTIONS:POLY_SECTIONS)[stage];
  const delayed=new Set(['ddl_Admision_On_InterMarks','ddl_lateral','ddl_uptu','ddl_uptu_type','txt_uptu_counsellingRegisterNo','ddl_aktu_councilling_year','txt_aktu_councilling_rank','txt_aktu_councilling_cuttoff']);
  const fields=section.fields.filter(field=>stage!=='academic'||!delayed.has(field.key)||values.get('ddl_CourseName')).map(field=>{
    const value=values.get(field.key)||'';
    if(['choice','radio'].includes(field.type)) {
      const choices=field.key==='rb_regidancestdnt'?[['day','दिवा छात्र'],['resident','आवासीय छात्र']]:field.key==='DropDownList2'?[['both','माता-पिता दोनों जीवित हैं'],['mother','केवल माता ही जीवित हैं']]:field.key==='rb_regular'?[['regular','नियमित'],['self','स्ववित्तपोषित']]:field.key==='ddl_CourseName'?(!values.get('rb_regular')?[]:[['c','Diploma Engg (Group3)'],['g4','Diploma Engg. 3 yrs Group4']]):field.key==='ddl_CurrentCourse_Branch'?(!values.get('ddl_CourseName')?[]:[['cs','Diploma in Computer Science & Engg.'],['el','Diploma in Electronics']]):field.key==='courseYear'?(!values.get('ddl_CurrentCourse_Branch')?[]:categoryRoute==='obc'?[['1,3','1/3'],['2,3','2/3'],['3,3','3/3']]:[['1','1'],['2','2'],['3','3']]):field.key==='ddl_UniBrdName'?(!values.get('ddl_CurrentCourse_Branch')?[]:[['pbt','U.P Board Of Technical Education']]):field.key==='ddl_bankname'?[['bank','Synthetic Bank']]:field.key==='ddldistbnk'?[['district','Test District']]:field.key==='bankBranch'?(dropDependent||!values.get('ddldistbnk')?[]:[['branch','Test Branch']]):[['1',field.defaultLabel||'2024']];
      if(field.type==='radio') return choices.map(([v,label],i)=>`<label for="${field.id}_${i}">${label}</label><input type="radio" id="${field.id}_${i}" name="${field.key}" value="${v}" ${field.key==='rb_regidancestdnt'?'onclick="__doPostBack()"':''} ${value===v?'checked':''}>`).join('');
      return `<select id="${field.id}" name="${field.key}" ${['rb_regular','ddl_CourseName','ddl_CurrentCourse_Branch','courseYear','ddl_UniBrdName','ddl_uptu_type','ddl_bankname','ddldistbnk','bankBranch','DropDownList2'].includes(field.key)?'onchange="__doPostBack()"':''}><option value="">SELECT</option>${choices.map(([v,label])=>`<option value="${v}" ${value===v?'selected':''}>${label}</option>`).join('')}</select>`;
    }
    return `<input id="${field.id}" name="${field.key}" value="${html(value)}" ${field.type==='account-confirm'?'type="password" onpaste="return false"':''}>`;
  }).join('');
  const unusedIntermediate=stage==='academic'?['Gridview1_grid_ddl_passyr_1','Gridview1_grid_txt_TotalMarks_1','Gridview1_grid_txt_Obtain_1','Gridview1_grid_txt_Percentage_1','Gridview1_grid_txt_affiliating_1','Gridview1_txt_schoolname_1','Gridview1_txt_fee_1'].map(key=>`<input id="${p+key}" name="${key}" value="${html(intermediateValues[key]||'')}">`).join(''):'';
  return form(`<script>function __doPostBack(){HTMLFormElement.prototype.submit.call(document.forms[0])}</script><h1>2026-27 ${stage}</h1>${fields}${unusedIntermediate}${stage==='bank'?`<input disabled id="${p}txt_IfscCode" value="TEST0000001">`:''}${extra}${image(section.captcha,section.refresh)}<input id="${p+section.answer}" name="captcha">${section.declaration?`<label for="${p+section.declaration}">The synthetic test details are correct.</label><input type="checkbox" id="${p+section.declaration}" name="declaration">`:''}${submit(section.button)}`);
}
const dashboard=({complete=false,certified=false}={})=>form(`<a id="Home" href="/PostMatric/Default.aspx">Home</a>${complete?`<a id="${p}Href_update_Form" href="/PostMatric/ApplicationFormUpdateInstitute.aspx">Update application</a>`:'<a href="/PostMatric/ApplicationFormInstitute.aspx">Fill application</a>'}${certified?'<span>आय एवं जाति प्रमाणीकरण हेतु ✓</span>':`<a id="${p}Href_IncomeCaste_Form" href="/PostMatric/GetIncomeCasteAuth.aspx">आय एवं जाति प्रमाणीकरण हेतु</a>`}<a id="${p}Href_temp_Form" href="/PostMatric/TempPrintInstitute.aspx">Check print</a>`);

test('Poly portal drives postbacks, confirms stages, handles CAPTCHA, refuses unknown forms and skips completed entry',{skip:!enabled},async t=>{
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});t.after(()=>browser.close());
  t.afterEach(async()=>{for(const context of browser.contexts()) await context.close();});
  async function fixture(options={}) {
    let stage=options.stage||'academic',complete=!!options.complete,certified=!!options.certified,context,incomeRetrieved=false,incomeVerified=false,casteRetrieved=false;
    const values=new Map(),posts=[],urls=[],type=options.applicationType||'Fresh';
    const portal=createPolyPortal({categoryRoute:options.categoryRoute||'sc-st-general',applicationType:type,launch:async()=>({newContext:async opts=>{
      context=await browser.newContext(opts);await context.setOffline(true);await context.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url());urls.push(url.pathname);
        const respond=body=>route.fulfill({contentType:'text/html',body:type==='Renewal'?body.replaceAll('/PostMatric/','/PostMatricRenewal/'):body});
        if(url.origin!==POLY_ORIGIN) return route.abort();
        if(url.pathname==='/test-captcha.svg') return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="white"/><text x="8" y="26">AbC12</text></svg>'});
        if(req.method()==='POST') {
          const data=new URLSearchParams(req.postData());posts.push(data);for(const [k,v] of data) values.set(k,v);
          if(data.has('login')) return respond('<script>location.replace("/PostMatric/Default.aspx")</script>');
          if(data.has('verifyIncome')) {incomeVerified=true;stage='caste';}
          if(data.has('verifyCaste')) {certified=true;return respond('<script>location.replace("/PostMatric/Default.aspx")</script>');}
          if(data.has('submit')) {
            if(options.uncertain) return route.abort();
            if(data.get('captcha')==='WRONG') return respond(sectionPage(stage,values,options)+'<p>Invalid CAPTCHA</p>');
            if(stage==='income') incomeRetrieved=true;
            else if(stage==='caste') casteRetrieved=true;
            else {
              stage={academic:'personal',personal:'bank',bank:'fee',fee:'accepted'}[stage];
              if(stage==='accepted') {complete=true;return respond('<script>location.replace("/PostMatric/applicationAccept.aspx")</script>');}
            }
          }
        }
        let body;
        switch(url.pathname.toLowerCase().replace('/postmatricrenewal/','/postmatric/')) {
          case '/loginstudentpostrenew.aspx':
          case '/loginstudentpost.aspx':body=loginPage(options.loginLabel||type);break;
          case '/postmatric/default.aspx':body=dashboard({complete,certified});break;
          case '/postmatric/applicationaccept.aspx':body=form('<p>आपके आवेदन पत्र की प्रविष्टियाँ सफलतापूर्वक भरी गयीं है।</p><a id="Home" href="/PostMatric/Default.aspx">Home</a>');break;
          case '/postmatric/getincomecasteauth.aspx': {
            if(incomeRetrieved&&!incomeVerified) body=form(`<div id="${p}gvRecord">Certificate Issued. Synthetic holder. ${values.get('txt_std_ninm')} ${options.mismatch?'999999':values.get('txt_income_crtificateno')}</div>${submit('IncomeVerify','verifyIncome')}`);
            else if(casteRetrieved) body=form(`<div id="${p}gvRecord_caste">Certificate Issued. Synthetic student. ${values.get('txt_niw_crtificateno')} ${values.get('txt_cst_crtificateno')}</div>${submit('CasteVerify','verifyCaste')}`);
            else {stage=incomeVerified?'caste':'income';body=sectionPage(stage,values)+(incomeVerified?'<p>e-District डाटा से आय प्रमाण पत्र संख्या मिलान सफल</p>':'');}break;
          }
          case '/postmatric/tempprintinstitute.aspx':body='<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:16mm}body{font:16px Arial}section{break-after:page}section:last-child{break-after:auto}td{border:1px solid #777;padding:10px}</style><section><h1>Synthetic scholarship check-print</h1><p>TEST FIXTURE - NOT AN APPLICATION</p><table><tr><td>Registration</td><td>000012345678</td></tr><tr><td>Student</td><td>SYNTHETIC TEST STUDENT</td></tr></table></section><section><h2>Test academic and bank details</h2><p>Test fee: 11010. No real personal details.</p></section>';break;
          default:body=sectionPage(stage,values,options);
        }
        return respond(body);
      });return context;
    },close:async()=>context?.close()})});t.after(()=>portal.close());
    await portal.open();const loginResult=await portal.login({registration:'000012345678',otr:'UP26-0000000001',password:'TEST_ONLY',captcha:'AbC12'});
    return {portal,posts,values,urls,loginResult};
  }
  const answerFor=field=>field.options?.[0].value||({Gridview1_grid_txt_TotalMarks_0:'600',Gridview1_grid_txt_Obtain_0:'447',txt_std_accno:'00012345',txt_std_accno_Re:'00012345'}[field.key])||(field.type==='date'?'01/08/2026':field.type==='enrolment'?'E00000000000001':['number','digits'].includes(field.type)?'123':'TEST SCHOOL');
  async function fill(f,operation='fill') {let step=await f.portal.choose(operation);let n=0;while(step.kind==='field'&&++n<40) step=await f.portal.fill(step.field,answerFor(step.field),step.token);return step;}
  await t.test('OBC asks dates and enrolment, groups residence radios, and enforces 1/3 without changing the general schema',async()=>{
    for(const year of ['1,3','3,3']) {
      const f=await fixture({categoryRoute:'obc',intermediateValues:{Gridview1_txt_fee_1:'0'}});
      let step=await f.portal.choose('fill');const asked=[];
      while(step.kind==='field') {
        asked.push(step.field.key);
        if(step.field.key==='courseYear') assert.equal(step.field.suggestion,'1,3');
        if(step.field.key==='ddl_uptu_type') {
          assert.equal(step.field.autoDefault,true);
          assert.equal(step.field.options.find(option=>option.value===step.field.suggestion)?.label,'JEECUP');
        }
        if(step.field.key==='txt_currentsessiondate') {
          assert.equal(step.field.sameAs,year==='1,3'?'txt_fstyr_addmissiondt':undefined);
          assert.equal(step.field.suggestion,year==='1,3'?'01/08/2026':undefined);
          if(year==='1,3') await assert.rejects(f.portal.fill(step.field,'02/08/2026',step.token),/same date/);
        }
        if(step.field.key==='txt_UniBrdRegno') await assert.rejects(f.portal.fill(step.field,'E123',step.token),/15 characters/);
        if(step.field.key==='rb_regidancestdnt') assert.deepEqual(step.field.options.map(o=>o.label),['दिवा छात्र','आवासीय छात्र']);
        const value=step.field.key==='courseYear'?year:step.field.key==='rb_regidancestdnt'?'resident':step.field.key==='txt_currentsessiondate'&&year==='3,3'?'02/08/2026':answerFor(step.field);
        step=await f.portal.fill(step.field,value,step.token);
      }
      assert.equal(step.kind,'review');assert.equal(f.portal.values().rb_regidancestdnt,'resident');
      assert.ok(asked.indexOf('txt_fstyr_addmissiondt')<asked.indexOf('txt_currentsessiondate'));
      assert.ok(asked.indexOf('rb_regidancestdnt')<asked.indexOf('Gridview1_grid_ddl_passyr_0'));
      assert.ok(step.review.some(line=>line.includes('आवासीय छात्र')));
      assert.ok(step.review.some(line=>line.includes('Counselling examination: JEECUP')));
      assert.ok(f.posts.some(post=>post.get('ddl_uptu_type')==='1'));
      assert.equal(f.posts.filter(post=>post.has('submit')).length,0);
      assert.equal(f.values.get('rb_regidancestdnt'),'resident');
      step=await f.portal.edit('txt_fstyr_addmissiondt');assert.equal(step.field.key,'txt_fstyr_addmissiondt');
      assert.equal(f.portal.answers.has('txt_currentsessiondate'),false);
    }
    assert.equal(POLY_SECTIONS.academic.fields.some(f=>f.key==='txt_fstyr_addmissiondt'),false);
    const g=await fixture({categoryRoute:'obc',intermediateValues:{Gridview1_txt_fee_1:'10'}});
    assert.equal((await g.portal.choose('fill')).kind,'unsupported');
  });
  await t.test('OBC has isolated mappings and preserves review, edit, CAPTCHA and PDF handling',async()=>{
    for(const applicationType of ['Fresh','Renewal']) {
      const f=await fixture({categoryRoute:'obc',applicationType,stage:'fee'});
      assert.ok(f.portal instanceof ObcPolyPortal);assert.notEqual(f.portal.sections.fee,POLY_SECTIONS.fee);
      f.portal.sections.fee.fields[0].label='OBC fee fixture';assert.notEqual(POLY_SECTIONS.fee.fields[0].label,'OBC fee fixture');
      let step=await fill(f);assert.equal(step.kind,'review');assert.match(step.review[0],/OBC fee fixture/);
      step=await f.portal.edit('txt_refundAmt');assert.equal(step.kind,'field');step=await f.portal.fill(step.field,'11010',step.token);
      await f.portal.captcha(true);assert.equal((await f.portal.submit('WRONG',step.token)).kind,'captcha-error');
      step=await f.portal.read();assert.equal((await f.portal.submit('AbC12',step.token)).kind,'complete');
      await f.portal.home();assert.equal((await f.portal.choose('pdf')).kind,'pdf');
    }
    const g=await fixture({categoryRoute:'obc',extra:'<input id="unmappedObcField">'});
    const stopped=await g.portal.choose('fill');assert.equal(stopped.kind,'unsupported');assert.match(stopped.message,/OBC setup paused/);
    assert.equal(g.posts.filter(post=>post.has('submit')).length,0);
    assert.throws(()=>createPolyPortal({categoryRoute:'unknown'}));
  });
  await t.test('Renewal uses its own login and dashboard paths; known fields and PDF work without Fresh navigation',async()=>{
    const f=await fixture({applicationType:'Renewal',stage:'fee'});
    assert.equal(f.urls[0],'/LoginStudentPostRenew.aspx');assert.equal(f.loginResult.kind,'dashboard');
    let step=await fill(f);assert.equal(step.kind,'review');
    step=await f.portal.submit('AbC12',step.token);assert.equal(step.kind,'complete');
    assert.equal((await f.portal.home()).kind,'dashboard');
    assert.equal((await f.portal.choose('certificates')).stage,'income');
    await f.portal.page.goto(POLY_ORIGIN+'/PostMatricRenewal/Default.aspx');
    const result=await f.portal.choose('pdf');assert.equal(result.kind,'pdf');assert.equal(result.pages,2);
    assert.equal(f.urls.some(path=>path.startsWith('/PostMatric/')),false);
    await f.portal.page.goto(POLY_ORIGIN+'/LoginStudentPostRenew.aspx');
    await f.portal.refreshLogin();assert.equal((await f.portal.read()).kind,'expired');
  });
  await t.test('Renewal refuses mismatched login mode and unmapped editable fields',async()=>{
    const f=await fixture({applicationType:'Renewal',loginLabel:'Fresh'});
    assert.equal(f.loginResult.kind,'unsupported');assert.equal(f.posts.length,0);
    const g=await fixture({applicationType:'Renewal',extra:'<input id="unknownRenewalField">'});
    assert.equal((await g.portal.choose('fill')).kind,'unsupported');assert.equal(g.posts.filter(post=>post.has('submit')).length,0);
  });
  await t.test('full form, postbacks, leading-zero bank confirmation and exact percentage',async()=>{
    const f=await fixture();let step=await fill(f);
    assert.equal(step.kind,'review');assert.equal(f.portal.values().Gridview1_grid_txt_TotalMarks_0,'600');assert.equal(f.portal.values().Gridview1_grid_txt_Percentage_0,'74.50');
    await f.portal.captcha(true);step=await f.portal.submit('WRONG',step.token);assert.equal(step.kind,'captcha-error');
    step=await f.portal.read();step=await f.portal.submit('AbC12',step.token);
    while(step.kind==='field'||step.kind==='review') {
      if(step.kind==='field') step=await f.portal.fill(step.field,answerFor(step.field),step.token);
      else {if(step.stage==='bank') assert.ok(step.review.includes('Portal IFSC: TEST0000001'));step=await f.portal.submit('AbC12',step.token);}
    }
    assert.equal(step.kind,'complete');assert.equal(f.values.get('txt_std_accno_Re'),'00012345');assert.equal(f.posts.filter(p=>p.has('submit')).length,5);
    for(const key of ['Gridview1_grid_ddl_passyr_1','Gridview1_grid_txt_TotalMarks_1','Gridview1_grid_txt_Obtain_1','Gridview1_grid_txt_Percentage_1','Gridview1_grid_txt_affiliating_1','Gridview1_txt_schoolname_1','Gridview1_txt_fee_1']) assert.equal(f.posts.find(post=>post.has('submit')).get(key),'');
  });
  await t.test('only High School is asked; the blank Intermediate row stays untouched',async()=>{
    const f=await fixture();
    let step=await f.portal.choose('fill');
    const asked=[];
    while(step.kind==='field') {asked.push(step.field.key);step=await f.portal.fill(step.field,answerFor(step.field),step.token);}
    assert.equal(step.kind,'review');
    assert.ok(asked.some(key=>key.endsWith('_0')));
    assert.equal(asked.some(key=>key.endsWith('_1')),false);
    assert.ok(step.review.includes('Intermediate row: left blank as requested.'));
    assert.equal(await f.portal.page.locator('#'+p+'Gridview1_grid_txt_Obtain_1').getAttribute('value'),'');
  });
  await t.test('course year defaults to 1 and keeps portal options 2 and 3 selectable',async()=>{
    const f=await fixture();let step=await f.portal.choose('fill');
    while(step.kind==='field'&&step.field.key!=='courseYear') step=await f.portal.fill(step.field,answerFor(step.field),step.token);
    assert.equal(step.kind,'field');assert.equal(step.field.suggestion,'1');assert.deepEqual(step.field.options.map(option=>option.label),['1','2','3']);
    step=await f.portal.fill(step.field,'3',step.token);assert.equal(f.portal.values().courseYear,'3');
  });
  await t.test('diploma branch maps the newly revealed technical board dropdown',async()=>{
    const f=await fixture();let step=await f.portal.choose('fill');
    while(step.kind==='field'&&step.field.key!=='ddl_UniBrdName') step=await f.portal.fill(step.field,answerFor(step.field),step.token);
    assert.equal(step.kind,'field');assert.equal(step.field.label,'University/Board/Affiliating Agency');
    assert.equal(step.field.suggestion,'pbt');assert.deepEqual(step.field.options.map(option=>option.label),['U.P Board Of Technical Education']);
    step=await f.portal.fill(step.field,'pbt',step.token);assert.equal(f.portal.values().ddl_UniBrdName,'pbt');
    assert.notEqual(step.kind,'unsupported');
  });
  await t.test('pre-filled unused Intermediate row stops for review',async()=>{
    const f=await fixture({intermediateValues:{Gridview1_grid_txt_Obtain_1:'321'}});
    assert.equal((await f.portal.choose('fill')).kind,'unsupported');
  });
  await t.test('completed entry skipped after fresh login; verified certificates skipped',async()=>{
    const f=await fixture({complete:true,certified:true});assert.deepEqual(await f.portal.choose('fill'),{kind:'complete',stage:'form'});assert.deepEqual(await f.portal.choose('certificates'),{kind:'complete',stage:'certificates'});assert.equal(f.posts.length,1);
  });
  await t.test('unknown fields, unsupported parents, external actions and missing dependent options stop',async()=>{
    for(const options of [{extra:'<input id="unknown">'},{stage:'bank',dropDependent:true}]) {
      const f=await fixture(options);const step=await fill(f);assert.equal(step.kind,'unsupported');assert.equal(f.posts.filter(p=>p.has('submit')).length,0);
    }
    const f=await fixture({stage:'personal'});let step=await f.portal.choose('fill');step=await f.portal.fill(step.field,'mother',step.token);assert.equal(step.kind,'unsupported');
    const g=await fixture({stage:'fee'});await g.portal.page.evaluate(()=>document.querySelector('form').action='https://example.invalid/submit');assert.equal((await g.portal.choose('fill')).kind,'unsupported');
  });
  await t.test('uncertain request cannot post twice',async()=>{
    const f=await fixture({stage:'fee',uncertain:true}),step=await fill(f);assert.equal((await f.portal.submit('AbC12',step.token)).kind,'unknown');assert.equal((await f.portal.submit('AbC12',step.token)).kind,'unknown');assert.equal(f.posts.filter(p=>p.has('submit')).length,1);
  });
  await t.test('review changes, incorrect IFSC and an expired session cannot submit',async()=>{
    const f=await fixture({stage:'fee'}),review=await fill(f);
    await f.portal.page.locator('label').evaluate(e=>e.textContent='Changed declaration');
    assert.equal((await f.portal.submit('AbC12',review.token)).kind,'unsupported');assert.equal(f.posts.filter(p=>p.has('submit')).length,0);
    await f.portal.page.goto(POLY_ORIGIN+'/LoginStudentPost.aspx');assert.equal((await f.portal.read()).kind,'expired');
    const g=await fixture({stage:'bank'});await fill(g);await g.portal.page.locator('#'+p+'txt_IfscCode').evaluate(e=>e.value='');assert.equal((await g.portal.read()).kind,'unsupported');
  });
  await t.test('certificate retrieval then explicit verification; wrong certificate rejected',async()=>{
    const f=await fixture();let step=await fill(f,'certificates');step=await f.portal.submit('AbC12',step.token);assert.equal(step.kind,'record');
    step=await f.portal.submit(undefined,step.token,true);assert.equal(step.stage,'caste');
    while(step.kind==='field') step=await f.portal.fill(step.field,'0004321',step.token);
    step=await f.portal.submit('AbC12',step.token);assert.equal(step.kind,'record');step=await f.portal.submit(undefined,step.token,true);assert.deepEqual(step,{kind:'complete',stage:'certificates'});
    const g=await fixture({mismatch:true});step=await fill(g,'certificates');step=await g.portal.submit('AbC12',step.token);assert.equal(step.kind,'unknown');assert.equal(g.posts.some(p=>p.has('verifyIncome')),false);
  });
  await t.test('official check-print HTML becomes a parsed multipage PDF; invalid identity rejected',async()=>{
    const f=await fixture({complete:true}),result=await f.portal.choose('pdf');assert.equal(result.kind,'pdf');assert.equal(result.pages,2);
    await assert.rejects(validatePolyPdf(result.bytes,'999999999999'));await assert.rejects(validatePolyPdf(Buffer.from('<html>error</html>'),'000012345678'));
    if(process.env.POLY_PDF_FIXTURE_DIR) {await mkdir(process.env.POLY_PDF_FIXTURE_DIR,{recursive:true});await writeFile(join(process.env.POLY_PDF_FIXTURE_DIR,'synthetic-check-print.pdf'),result.bytes);}
    const native=await fixture({complete:true});
    await native.portal.context.route('**/native-check.pdf',route=>route.fulfill({contentType:'application/pdf',headers:{'content-disposition':'attachment; filename="check.pdf"'},body:result.bytes}));
    await native.portal.context.route('**/TempPrintInstitute.aspx',route=>route.fulfill({contentType:'text/html',body:'<p>Official check-print fixture 000012345678</p><a href="/native-check.pdf">Download PDF</a>'}));
    const downloaded=await native.portal.choose('pdf');assert.deepEqual(downloaded.bytes,result.bytes);assert.equal(downloaded.pages,2);
  });
});
