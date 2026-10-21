import {PolyPortal} from './poly-portal.mjs';
import {OBC_SECTIONS,OBC_IGNORED_EMPTY_FIELDS,isFirstYearOfThree,filterObcOptions,preferredObcValue} from './poly-obc-schema.mjs';
import {obcFieldDiagnostic} from './poly-diagnostics.mjs';
import {POLY_ORIGIN,PREFIX,normalizePoly} from './poly-schema.mjs';
import {randomUUID} from 'node:crypto';
import {readObcDeclarations} from './poly-obc-declaration.mjs';

export class ObcPolyPortal extends PolyPortal {
  constructor({cascadeTimeoutMs=30_000,...options}={}) {
    super({...options,sections:structuredClone(OBC_SECTIONS),ignoredEmptyFields:[...OBC_IGNORED_EMPTY_FIELDS],ignoredDefaultValues:{Gridview1_txt_fee_1:['0']}});
    this.cascadeTimeoutMs=cascadeTimeoutMs;
  }
  optionalBlankFields(stage,snapshot) {
    if(stage!=='personal') return [];
    // User-approved optional omissions. Do not select a disability category,
    // invent a family ID, clear existing data or suppress any dependent field.
    return [
      {id:PREFIX+'ddl_Handitype',type:'select-one'},
      {id:PREFIX+'txtfamilyid',type:'text'},
    ].filter(rule=>{
      const matches=snapshot.fields.filter(field=>field.id===rule.id);
      if(matches.length!==1) return false;
      const field=matches[0];
      if(field.type!==rule.type||field.required) return false;
      const value=String(field.value||'').trim();
      if(rule.type==='text') return value==='';
      const option=field.options?.find(option=>option.value===field.value);
      // Placeholder values can be "", "0" or another ASP.NET sentinel.
      // Use the live label, not a hardcoded value for a real category.
      const label=option?.label.trim().replace(/^-+\s*|\s*-+$/g,'').trim();
      return option?/^(?:|select(?:\s.*)?|चुन.*)$/i.test(label):value==='';
    }).map(rule=>rule.id);
  }
  review(stage,snapshot) {
    const review=super.review(stage,snapshot);
    const optional=this.optionalBlankFields(stage,snapshot);
    if(optional.includes(PREFIX+'ddl_Handitype')) review.push('Disability type: left unselected.');
    if(optional.includes(PREFIX+'txtfamilyid')) review.push('Family ID: left blank.');
    return review;
  }
  async snapshot() {
    const snapshot=await super.snapshot();
    const ids=Object.values(this.sections).filter(section=>section.declaration).map(section=>'ContentPlaceHolder1_'+section.declaration);
    const declarations=await this.page.evaluate(readObcDeclarations,ids);
    for(const declaration of declarations) {
      const field=snapshot.fields.find(field=>field.id===declaration.id);
      if(field) field.label=declaration.label;
    }
    return snapshot;
  }
  async read() {
    let step=await super.read();
    if(step.kind==='field'&&['obc-course','obc-branch'].includes(step.field.filter)) {
      const options=filterObcOptions(step.field,step.field.options||[]);
      step=options.length?{...step,field:{...step.field,options,suggestion:preferredObcValue(step.field,options)}}:
        {kind:'unsupported',message:'The portal has no supported OBC '+(step.field.filter==='obc-course'?'engineering course':'branch')+' options. Wait for the portal update or inspect its options before continuing.'};
    }
    if(step.kind==='field'&&step.field.key==='courseYear') {
      const first=step.field.options?.find(option=>isFirstYearOfThree({value:option.value,display:option.label}));
      return first?{...step,field:{...step.field,suggestion:first.value}}:step;
    }
    if(step.kind==='field'&&step.field.key==='txt_currentsessiondate'&&isFirstYearOfThree(this.answers.get('courseYear'))) {
      return {...step,field:{...step.field,sameAs:'txt_fstyr_addmissiondt',suggestion:this.values().txt_fstyr_addmissiondt,note:'Course year is 1/3: this must match question 15. Send USE DEFAULT to use that date.'}};
    }
    if(step.kind==='review'&&step.stage==='academic'&&isFirstYearOfThree(this.answers.get('courseYear'))) {
      const values=this.values();
      if(values.txt_currentsessiondate!==values.txt_fstyr_addmissiondt) return {kind:'unsupported',message:'For course year 1/3, admission dates 15 and 16 must match. No form was submitted.'};
    }
    if(step.kind!=='unsupported') return step;
    return {...step,message:'OBC setup paused. '+(step.message||'This portal page has not been mapped.')+obcFieldDiagnostic(step.diagnostic)+' Share the field labels and required choices so the OBC mapping can be checked. No unrecognized form was submitted. Use /menu to return.'};
  }

  async fill(field,value,token) {
    if(field.key!=='ddl_CourseName') return super.fill(field,value,token);
    const current=await this.read();
    if(current.kind!=='field'||current.field.key!==field.key||current.token!==token) return {kind:'unsupported'};
    value=normalizePoly(current.field,value,this.values());
    const snapshot=await this.snapshot(),live=snapshot.fields.find(control=>control.id===current.field.id);
    const branch=this.sections.academic.fields.find(control=>control.key==='ddl_CurrentCourse_Branch');
    const changed=live.value!==value,marker='__telesparkObcCascade_'+randomUUID().replaceAll('-','');
    if(changed) await this.page.evaluate(({id,marker})=>{
      const state={changed:false};
      state.observer=new MutationObserver(records=>{
        for(const record of records) {
          const select=document.getElementById(id);
          if(record.target===select||select?.contains(record.target)||[...record.addedNodes,...record.removedNodes].some(node=>node.id===id||node.querySelector?.('#'+id))) state.changed=true;
        }
      });
      state.observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['value']});
      window[marker]=state;
    },{id:branch.id,marker});
    try {
      if(changed) {
        const action=()=>this.page.locator('#'+current.field.id).selectOption(value);
        if(live.postback) {
          // ASP.NET UpdatePanel uses the same __doPostBack trigger as a full
          // navigation. Wait for the actual response, not navigation alone.
          const [response]=await Promise.all([
            this.page.waitForResponse(response=>{
              const request=response.request();
              return new URL(response.url()).origin===POLY_ORIGIN&&((request.isNavigationRequest()&&request.method()==='POST')||['xhr','fetch'].includes(request.resourceType()));
            },{timeout:this.cascadeTimeoutMs}),action(),
          ]);
          if(response.status()>=400||await response.finished()||this.externalBlocked) throw Error('OBC course update failed.');
          if(response.request().isNavigationRequest()) await this.page.waitForLoadState('domcontentloaded',{timeout:this.cascadeTimeoutMs});
        } else await action();
      }
      const settled=await this.page.waitForFunction(({courseId,branchId,value,marker,changed})=>{
        const course=document.getElementById(courseId),branch=document.getElementById(branchId);
        const manager=window.Sys?.WebForms?.PageRequestManager?.getInstance?.();
        if(course?.value!==value||!branch||branch.disabled||manager?.get_isInAsyncPostBack?.()) return false;
        if(changed&&window[marker]&&!window[marker].changed) return false;
        return [...branch.options].some(option=>!option.disabled&&option.value&&!/^(-+|select|चुन|--चुन)/i.test(option.text.trim()));
      },{courseId:current.field.id,branchId:branch.id,value,marker,changed},{timeout:this.cascadeTimeoutMs});
      await settled.dispose();
      const after=await this.snapshot();
      if(!this.safe(after)||after.fields.find(control=>control.id===current.field.id)?.value!==value) return {kind:'unsupported'};
      // Even identical branch values can mean different choices under another
      // course. Require a fresh branch answer and clear later dependents.
      const fields=this.sections.academic.fields,index=fields.findIndex(control=>control.key===field.key);
      for(const dependent of fields.slice(index+1)) this.answers.delete(dependent.key);
      this.answers.set(field.key,{value,display:current.field.options.find(option=>option.value===value).label});this.revision++;
      return this.read();
    } finally {
      await this.page.evaluate(marker=>{window[marker]?.observer?.disconnect();delete window[marker];},marker).catch(()=>{});
    }
  }
}

export function createPolyPortal({categoryRoute='sc-st-general',...options}={}) {
  if(categoryRoute==='obc') return new ObcPolyPortal(options);
  if(categoryRoute==='sc-st-general') return new PolyPortal(options);
  throw Error('Choose SC / ST / General or OBC.');
}
