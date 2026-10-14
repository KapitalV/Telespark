import {POLY_FIELDS} from './poly-schema.mjs';
export const PASSWORD_FIELDS={applicationType:'Application type',registration:'Registration number',dob:'Date of birth',mobile:'Registered mobile',board:'High-school board',year:'Passing year',roll:'Roll number'};
const p='ContentPlaceHolder1_';
export const REGISTRATION_SAVED_FIELDS={
  route:'Department / course',[p+'TextBox3']:'OTR number',[p+'ddl_district']:'District',
  [p+'ddl_institute']:'Institution',[p+'ddl_caste']:'Category',[p+'ddl_relegion']:'Religion',
  [p+'ddl_highschpassyear']:'Passing year',[p+'ddl_board']:'Board',[p+'txt_hghrollnoA']:'Roll prefix',
  [p+'txt_hghrollno']:'Roll number',[p+'txt_pwd']:'Chosen password',studentName:'Student name',linkedMobile:'Linked mobile',
};
export const FINAL_FIELDS={registration:'Registration number',otr:'OTR number',applicationType:'Application type',status:'Stage'};
export const SAVE_STATUS={draft:'Draft',ready:'Ready',attempted:'Submission attempted',confirmed:'Confirmed success',uncertain:'Outcome uncertain'};
export function projectFields(module,fields={}) {
  const allowed=module==='password'?PASSWORD_FIELDS:module==='registration'?REGISTRATION_SAVED_FIELDS:module==='poly'?POLY_FIELDS:module==='final'?FINAL_FIELDS:undefined;
  if(!allowed) throw new Error('Unsupported saved module.');
  const clean={};
  for(const key of Object.keys(allowed).sort()) {
    const field=fields[key];if(!field) continue;
    if(typeof field.value!=='string' || field.value.length>2000 || (field.label!==undefined && (typeof field.label!=='string' || field.label.length>2000))) throw new Error('Invalid saved field.');
    clean[key]={value:field.value};if(field.label!==undefined) clean[key].label=field.label;
  }
  return clean;
}
export function projectResult(result) {
  if(!result) return undefined;
  if(!['success','response-image','result-image','unknown','pdf'].includes(result.kind)) throw new Error('Unsupported saved result.');
  const clean={kind:result.kind};
  if(result.kind==='pdf') {
    if(typeof result.pdf!=='string'||result.pdf.length>23*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.pdf)||Buffer.from(result.pdf,'base64').subarray(0,5).toString()!=='%PDF-') throw Error('Invalid saved PDF.');
    clean.pdf=result.pdf;if(result.incomplete===true)clean.incomplete=true;return clean;
  }
  for(const key of ['registration','password']) if(result[key]!==undefined) {
    if(typeof result[key]!=='string' || result[key].length>2000) throw new Error('Invalid saved result.');
    clean[key]=result[key];
  }
  if(result.image!==undefined) {
    if(typeof result.image!=='string' || result.image.length>24*1024*1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.image)) throw new Error('Invalid saved image.');
    clean.image=result.image;
  }
  return clean;
}
