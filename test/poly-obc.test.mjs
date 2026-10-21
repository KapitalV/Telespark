import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizePoly,POLY_SECTIONS,filterOptions} from '../poly-schema.mjs';
import {OBC_EXTRA_FIELDS,OBC_SECTIONS,isFirstYearOfThree,filterObcOptions,preferredObcValue} from '../poly-obc-schema.mjs';
import {projectFields,SAVED_POLY_FIELDS} from '../saved-schema.mjs';

test('High-school names accept spaced initials, full words and pasted whitespace while retaining portal length limits',()=>{
  for(const sections of [POLY_SECTIONS,OBC_SECTIONS]) {
    const field=sections.academic.fields.find(f=>f.key==='Gridview1_txt_schoolname_0');
    const name='Y Y B INTER COLLEGE USRA BAZAR DEORIA';
    assert.equal(field.type,'school-name');
    assert.equal(normalizePoly(field,name),name);
    assert.equal(normalizePoly(field,' Y  Y B INTER\nCOLLEGE USRA BAZAR DEORIA '),name);
    assert.equal(normalizePoly(field,"ST. MARY'S HIGH SCHOOL NO. 2"),"ST. MARY'S HIGH SCHOOL NO. 2");
    assert.equal(normalizePoly(field,'राजकीय इंटर कॉलेज'),'राजकीय इंटर कॉलेज');
    assert.throws(()=>normalizePoly(field,'123456'),/school name/);
    assert.throws(()=>normalizePoly({...field,maxLength:10},name),/length/);
  }
});

test('OBC date input preserves DD/MM/YYYY and rejects impossible dates',()=>{
  const date=OBC_EXTRA_FIELDS[0];
  for(const value of ['01/08/2026','29/02/2024','31/12/2026']) assert.equal(normalizePoly(date,value),value);
  for(const value of ['1/8/2026','2026-08-01','29/02/2025','31/04/2026','00/08/2026','10/13/2026','01/01/0000']) assert.throws(()=>normalizePoly(date,value));
  const same={...OBC_EXTRA_FIELDS[1],sameAs:'txt_fstyr_addmissiondt'};
  assert.equal(normalizePoly(same,'01/08/2026',{txt_fstyr_addmissiondt:'01/08/2026'}),'01/08/2026');
  assert.throws(()=>normalizePoly(same,'02/08/2026',{txt_fstyr_addmissiondt:'01/08/2026'}),/same date/);
  assert.equal(normalizePoly(OBC_EXTRA_FIELDS[1],'02/08/2026'),'02/08/2026');
});

test('Only first year of three years activates matching dates',()=>{
  for(const answer of [{value:'1,3'},{value:'1/3'},{value:'first',display:'1 / 3'}]) assert.equal(isFirstYearOfThree(answer),true);
  for(const answer of [undefined,{value:'3,3',display:'3/3'},{value:'2,3'},{value:'1,2'},{value:'1'}]) assert.equal(isFirstYearOfThree(answer),false);
});

test('Enrolment is E plus fourteen digits and preserves leading zeros',()=>{
  const field=OBC_EXTRA_FIELDS[2];
  assert.equal(normalizePoly(field,'e00000000000001'),'E00000000000001');
  for(const value of ['123456789012345','A12345678901234','E123','E123456789012345','E0000000000000A']) assert.throws(()=>normalizePoly(field,value));
});

test('OBC fields have isolated ordered mappings and an explicit saved-field allowlist',()=>{
  const names=OBC_SECTIONS.academic.fields.map(f=>f.key),start=names.indexOf('txt_fstyr_addmissiondt');
  assert.deepEqual(names.slice(start,start+4),OBC_EXTRA_FIELDS.map(f=>f.key));
  assert.equal(names[start+4],'Gridview1_grid_ddl_passyr_0');
  assert.equal(POLY_SECTIONS.academic.fields.some(f=>f.key==='txt_UniBrdRegno'),false);
  const fields=Object.fromEntries(OBC_EXTRA_FIELDS.map((f,i)=>[f.key,{value:['01/08/2026','01/08/2026','E00000000000001','day'][i]}]));
  const saved=projectFields('poly',{...fields,otp:{value:'DO_NOT_SAVE'},captcha:{value:'DO_NOT_SAVE'}});
  assert.deepEqual(saved,fields);assert.ok(OBC_EXTRA_FIELDS.every(f=>SAVED_POLY_FIELDS[f.key]===f.label));
});

test('Only OBC fixed defaults auto-fill; new applicant fields and the general schema stay manual',()=>{
  for(const section of Object.values(OBC_SECTIONS)) for(const field of section.fields) {
    assert.equal(!!field.autoDefault,field.defaultLabel!==undefined||field.defaultValue!==undefined);
  }
  assert.equal(OBC_SECTIONS.academic.fields.find(field=>field.key==='ddl_uptu_type').autoDefault,true);
  assert.ok(OBC_EXTRA_FIELDS.every(field=>!field.autoDefault));
  assert.ok(Object.values(POLY_SECTIONS).every(section=>section.fields.every(field=>!field.autoDefault)));
});

test('OBC suggests Group 4 using the current option value across observed/requested label spellings',()=>{
  const field=OBC_SECTIONS.academic.fields.find(field=>field.key==='ddl_CourseName');
  for(const label of ['Diploma Engg. 3 yrs Group 4','Diploma In Engg. 3 Yrs (Group 4)','Diploma in Engineering 3 Years (Group4)','Diploma Engg. 3 yrs Group4']) {
    const options=filterObcOptions(field,[{value:'',label:'SELECT'},{value:'g3-live',label:'Diploma Engg (Group3)'},{value:'opaque-g4-live',label},{value:'wrong',label:'Diploma Engineering 2 Years (Group4)'},{value:'degree',label:'B.Tech Engineering Group4'}]);
    assert.deepEqual(options.map(option=>option.value),['g3-live','opaque-g4-live']);
    assert.equal(preferredObcValue(field,options),'opaque-g4-live');assert.equal(field.autoDefault,undefined);
    assert.equal(normalizePoly({...field,options},'opaque-g4-live'),'opaque-g4-live');
  }
  assert.equal(preferredObcValue(field,[{value:'x',label:'Diploma Engg (Group3)'}]),undefined);
  assert.equal(preferredObcValue(field,[{value:'a',label:'Diploma Engg 3 Yrs Group4'},{value:'b',label:'Diploma In Engineering 3 Years (Group4)'}]),undefined);
});

test('OBC offers all live branches and never guesses a missing/ambiguous Electrical preference; general mapping is unchanged',()=>{
  const obc=OBC_SECTIONS.academic.fields.find(field=>field.key==='ddl_CurrentCourse_Branch'),general=POLY_SECTIONS.academic.fields.find(field=>field.key===obc.key);
  const options=[{value:'cs',label:'Diploma in Computer Science & Engg.'},{value:'el',label:'Diploma in Electronics'},{value:'ee-live',label:'Electrical Engineering'},{value:'mechanical',label:'Mechanical Engineering'}];
  assert.deepEqual(filterObcOptions(obc,options).map(option=>option.value),['cs','el','ee-live','mechanical']);
  assert.equal(preferredObcValue(obc,filterObcOptions(obc,options)),'ee-live');
  assert.deepEqual(filterOptions(general,options).map(option=>option.value),['cs','el']);
  assert.equal(general.filter,'branch');assert.equal(POLY_SECTIONS.academic.fields.find(field=>field.key==='ddl_CourseName').filter,'course');
  assert.equal(preferredObcValue(obc,options.slice(0,2)),undefined);
  assert.equal(preferredObcValue(obc,[{value:'a',label:'Electrical Engineering'},{value:'b',label:'Diploma in Electrical Engg.'}]),undefined);
  const observed=filterObcOptions(obc,[{value:'',label:'Select Branch'},{value:'observed-label-synthetic-value',label:'Diploma in Electrical'}]);
  assert.equal(preferredObcValue(obc,observed),'observed-label-synthetic-value');
  assert.equal(normalizePoly({...obc,options:observed},'observed-label-synthetic-value'),'observed-label-synthetic-value');
  assert.equal(preferredObcValue(obc,[...observed,{value:'another-electrical',label:'Electrical Engineering'}]),undefined);
  assert.equal(preferredObcValue(obc,[{value:'different-branch',label:'Diploma in Electrical and Electronics'}]),undefined);
  const formatted=filterObcOptions(obc,[{value:'',label:'SELECT'},{value:'live-04',label:'04 - ELECTRICAL ENGG. (REGULAR)'}]);
  assert.equal(formatted.length,1);assert.equal(formatted[0].label,'04 - ELECTRICAL ENGG. (REGULAR)');assert.equal(preferredObcValue(obc,formatted),undefined);
  assert.equal(normalizePoly({...obc,options:formatted},'live-04'),'live-04');assert.throws(()=>normalizePoly({...obc,options:formatted},'made-up-value'));
});
