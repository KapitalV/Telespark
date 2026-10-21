import {PREFIX,POLY_SECTIONS,POLY_IGNORED_EMPTY_FIELDS,filterOptions} from './poly-schema.mjs';

// Independent starting copy. Add OBC differences only after inspecting the
// actual portal controls; shared validators and submission checks stay common.
export const OBC_SECTIONS=structuredClone(POLY_SECTIONS);
// These filters belong only to OBC. Suggestions use the current option value
// and remain explicit choices, including when a saved answer is available.
Object.assign(OBC_SECTIONS.academic.fields.find(field=>field.key==='ddl_CourseName'),{filter:'obc-course',preferredGroup:4});
Object.assign(OBC_SECTIONS.academic.fields.find(field=>field.key==='ddl_CurrentCourse_Branch'),{filter:'obc-branch',preferredLabel:'Electrical Engineering'});
// The user requested automatic fixed defaults in OBC. Live suggestions without
// an explicit fixed default (such as admission date 16) remain questions.
for(const section of Object.values(OBC_SECTIONS)) for(const field of section.fields) {
  if(field.defaultLabel!==undefined||field.defaultValue!==undefined) field.autoDefault=true;
}
export const OBC_IGNORED_EMPTY_FIELDS=[...POLY_IGNORED_EMPTY_FIELDS];
const field=(key,label,type,extra={})=>({key,id:PREFIX+key,label,type,...extra});
export const OBC_EXTRA_FIELDS=[
  field('txt_fstyr_addmissiondt','15. First-year admission date (DD/MM/YYYY)','date',{maxLength:10}),
  field('txt_currentsessiondate','16. Current-session admission date (DD/MM/YYYY)','date',{maxLength:10}),
  field('txt_UniBrdRegno','17. Student enrolment number (E followed by 14 digits)','enrolment',{maxLength:15}),
  field('rb_regidancestdnt','18. Day scholar / Residential student','radio'),
];
const index=OBC_SECTIONS.academic.fields.findIndex(f=>f.key==='Gridview1_grid_ddl_passyr_0');
OBC_SECTIONS.academic.fields.splice(index,0,...structuredClone(OBC_EXTRA_FIELDS));
export const OBC_SAVED_FIELDS=Object.fromEntries(OBC_EXTRA_FIELDS.map(f=>[f.key,f.label]));

const optionLabel=value=>String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const courseGroup=label=>/\bgroup\s*([34])\b/.exec(optionLabel(label))?.[1];
// The authenticated OBC page labels this branch "Diploma in Electrical".
// Keep canonical Engineering/Engg spellings too, without broad substring matches.
const electrical=label=>/^(?:diploma in electrical|(?:diploma (?:in )?)?electrical (?:engineering|engg))$/.test(optionLabel(label));

export function filterObcOptions(field,options) {
  const usable=filterOptions({},options);
  if(field.filter==='obc-course') return usable.filter(option=>{
    const label=optionLabel(option.label);
    return /\bdiploma\b/.test(label)&&/\b(?:engg|engineering|eng)\b/.test(label)&&!!courseGroup(label)&&!/\b[124-9]\s*(?:yrs?|years?)\b/.test(label);
  });
  // This control is already mapped and its values come from the authenticated
  // course-dependent dropdown. Offer every live branch for explicit selection;
  // display-name formatting must not hide valid branches. Preference stays
  // conservative, and unknown dependent controls still stop the portal reader.
  if(field.filter==='obc-branch') return usable;
  return usable;
}

export function preferredObcValue(field,options) {
  const preferred=field.filter==='obc-course'?options.filter(option=>courseGroup(option.label)===String(field.preferredGroup)):
    field.filter==='obc-branch'?options.filter(option=>electrical(option.label)):[];
  // Do not guess when the portal offers multiple matching courses/branches.
  return preferred.length===1?preferred[0].value:undefined;
}

export function isFirstYearOfThree(answer) {
  // The observed year/duration selection is 1/3 (ASP.NET can use 1,3 as
  // its option value). Do not interpret 3/3 as the first year.
  return [answer?.value,answer?.display].some(value=>/^1\s*[,/]\s*3$/.test(String(value||'').trim()));
}
