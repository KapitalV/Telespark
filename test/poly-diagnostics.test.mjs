import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unmappedPolyFields,obcFieldDiagnostic} from '../poly-diagnostics.mjs';
import {PolyPortal} from '../poly-portal.mjs';
import {ObcPolyPortal} from '../poly-obc-portal.mjs';
import {POLY_ORIGIN,PREFIX,POLY_SECTIONS} from '../poly-schema.mjs';

test('Unmapped field diagnostics exclude all values, labels, options and readonly controls',()=>{
  const diagnostic=unmappedPolyFields([
    {id:'known',type:'text',value:'KNOWN_SECRET'},
    {id:'readonly',disabled:true,type:'text',value:'READONLY_SECRET'},
    {id:PREFIX+'UnknownField',type:'select-one',value:'APPLICANT_SECRET',label:'LABEL_SECRET',options:[{label:'OPTION_SECRET',value:'OTP_SECRET'}]},
  ],new Set(['known']));
  assert.deepEqual(diagnostic,{code:'POLY-FIELDS',count:1,fields:[{id:PREFIX+'UnknownField',type:'select-one'}]});
  assert.equal(unmappedPolyFields([{id:'known',type:'text'}],new Set(['known'])),undefined);
  const message=obcFieldDiagnostic({...diagnostic,stage:'academic'});
  assert.match(message,/OBC-FIELDS/);assert.match(message,/academic/);assert.match(message,/UnknownField/);assert.doesNotMatch(message,/SECRET/);
  assert.equal(obcFieldDiagnostic(undefined),'');
});

test('Structural diagnostics are bounded and reject arbitrary ID/type payloads',()=>{
  const result=unmappedPolyFields(Array.from({length:20},(_,i)=>({id:i===0?'bad\nID':'field_'+i,type:'untrusted type',value:'NEVER'})),new Set());
  assert.equal(result.count,20);assert.equal(result.fields.length,15);assert.equal(result.fields[0].id,'(no stable field ID)');
  assert.ok(result.fields.every(field=>field.type==='unknown'));
  const message=obcFieldDiagnostic({...result,stage:'personal'});assert.match(message,/omitted/);assert.doesNotMatch(message,/bad\nID|NEVER|untrusted type/);
});

test('OBC unknown fields stop before fill, and return the actual stage/ID through the reader',async()=>{
  const section=POLY_SECTIONS.academic;
  const snapshot={url:POLY_ORIGIN+'/PostMatric/ApplicationFormInstitute.aspx',formAction:POLY_ORIGIN+'/PostMatric/ApplicationFormInstitute.aspx',text:'2026-27',target:'',externalFrame:false,
    buttons:[{id:PREFIX+section.button}],fields:[{id:PREFIX+'extra_obc_control',type:'text',disabled:false,value:'PRIVATE_VALUE',label:'PRIVATE_LABEL'}],links:[]};
  const obc=new ObcPolyPortal();obc.snapshot=async()=>snapshot;
  // No page or browser is provided. Reading an unsupported form must not click,
  // fill, take a screenshot, or require any credential/portal connection.
  const step=await obc.read();assert.equal(step.kind,'unsupported');assert.equal(step.diagnostic.stage,'academic');
  assert.match(step.message,/extra_obc_control/);assert.match(step.message,/OBC-FIELDS/);assert.doesNotMatch(step.message,/PRIVATE/);
  const general=new PolyPortal();general.snapshot=async()=>snapshot;
  const original=await general.read();assert.equal(original.kind,'unsupported');assert.doesNotMatch(original.message,/extra_obc_control/);
});
