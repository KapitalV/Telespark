import {chromium} from 'playwright';
import {POLY_ORIGIN,PREFIX,POLY_SECTIONS,POLY_IGNORED_EMPTY_FIELDS,filterOptions,normalizePoly,percentage} from './poly-schema.mjs';
import {validatePolyPdf} from './poly-pdf.mjs';
import {unmappedPolyFields} from './poly-diagnostics.mjs';

const paths=new Set(['/loginstudentpost.aspx','/postmatric/default.aspx','/postmatric/applicationforminstitute.aspx','/postmatric/applicationformupdateinstitute.aspx','/postmatric/applicationaccept.aspx','/postmatric/getincomecasteauth.aspx','/postmatric/tempprintinstitute.aspx']);
const selector=id=>'#'+id;
export function readPolyDocument() {
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const label=e=>[...(e.labels||[])].map(l=>l.innerText).join(' ').trim();
  const nodes=[...document.querySelectorAll('input,select,textarea')].filter(e=>visible(e)&&!['hidden','submit','button','reset'].includes(e.type));
  const fields=nodes.map(e=>({id:e.id,type:e.type,value:e.value,checked:e.checked,disabled:e.disabled||e.readOnly,label:label(e),required:e.required,maxLength:e.maxLength>0?e.maxLength:undefined,
    postback:/__doPostBack|WebForm_DoPostBackWithOptions/.test(e.getAttribute('onchange')||e.getAttribute('onclick')||''),
    options:e.tagName==='SELECT'?[...e.options].filter(o=>!o.disabled).map(o=>({value:o.value,label:o.text.trim()})):undefined}));
  for(const id of ['ContentPlaceHolder1_rb_regular','ContentPlaceHolder1_rb_regidancestdnt']) {
    const radios=fields.filter(f=>f.type==='radio'&&f.id.startsWith(id+'_'));
    if(radios.length) {for(const r of radios) fields.splice(fields.indexOf(r),1);fields.push({id,type:'radio',value:radios.find(r=>r.checked)?.value||'',disabled:radios.every(r=>r.disabled),postback:radios.some(r=>r.postback),options:radios.map(r=>({value:r.value,label:r.label,id:r.id}))});}
  }
  const buttons=[...document.querySelectorAll('input[type=submit],input[type=button],button')].filter(visible).map(e=>({id:e.id,disabled:e.disabled,action:e.formAction||e.form?.action||location.href,target:e.formTarget||e.form?.target||''}));
  const links=[...document.querySelectorAll('a[href]')].filter(visible).map(e=>({id:e.id,href:e.href,text:e.innerText.trim(),target:e.target}));
  const record=id=>{const e=document.getElementById(id);return visible(e)?e.innerText.trim():'';};
  const incomeNodes=[...document.querySelectorAll('a,span,li,td')].filter(e=>visible(e)&&e.innerText.includes('आय एवं जाति प्रमाणीकरण हेतु')&&e.innerText.length<400);
  const certificatesComplete=incomeNodes.some(e=>!e.matches('a[href]')&&!e.querySelector('a[href]')&&(/\uf058|✔|✓/.test(e.innerText)||e.querySelector('.fa-check-circle,.fa-check,.glyphicon-ok')));
  return {url:location.href,text:document.body.innerText,fields,buttons,links,certificatesComplete,
    incomeRecord:record('ContentPlaceHolder1_gvRecord'),casteRecord:record('ContentPlaceHolder1_gvRecord_caste'),
    formAction:document.querySelector('form')?.action,target:document.querySelector('form')?.target||'',externalFrame:[...document.querySelectorAll('iframe')].some(visible)};
}

export class PolyPortal {
  constructor({applicationType='Fresh',sections=POLY_SECTIONS,ignoredEmptyFields=POLY_IGNORED_EMPTY_FIELDS,ignoredDefaultValues={},headless=true,channel=process.platform==='win32'?'msedge':'chromium',launch=options=>chromium.launch(options)}={}) {
    if(!['Fresh','Renewal'].includes(applicationType)) throw Error('Choose Fresh or Renewal.');
    Object.assign(this,{applicationType,sections,ignoredEmptyFields,ignoredDefaultValues,headless,channel,launch});
    this.loginPath=applicationType==='Fresh'?'/LoginStudentPost.aspx':'/LoginStudentPostRenew.aspx';
    this.loginRadioId=applicationType==='Fresh'?'rbtnFR_0':'rbtnFR_1';
    // Renewal uses the same strict page-name allowlist in its own directory.
    // Links still come from the authenticated page; unknown fields stop filling.
    this.paths=new Set([...paths].map(path=>applicationType==='Renewal'?path.replace('/postmatric/','/postmatricrenewal/').replace('/loginstudentpost.aspx','/loginstudentpostrenew.aspx'):path));
    this.answers=new Map();this.revision=0;this.closed=false;this.attempted=false;
  }
  pagePath(url) {
    const path=new URL(url).pathname.toLowerCase();
    return this.applicationType==='Renewal'?path.replace(/^\/postmatricrenewal\//,'/postmatric/'):path;
  }
  async open() {
    const browser=await this.launch({headless:this.headless,channel:this.channel==='chromium'?undefined:this.channel,timeout:30_000});
    if(this.closed) {await browser.close();throw Error('Session closed.');}this.browser=browser;
    this.context=await browser.newContext({viewport:{width:1280,height:960},acceptDownloads:true});
    await this.context.route('**/*',async route=>{
      const request=route.request(),u=new URL(request.url());
      if(u.origin!==POLY_ORIGIN || (request.isNavigationRequest()&&!this.paths.has(u.pathname.toLowerCase())&&request.url()!==this.nativePdfUrl)) {
        if(request.isNavigationRequest()||['xhr','fetch'].includes(request.resourceType())) this.externalBlocked=true;
        return route.abort();
      }
      return route.fallback();
    });
    this.page=await this.context.newPage();this.page.setDefaultTimeout(12_000);this.page.setDefaultNavigationTimeout(45_000);
    this.page.on('dialog',async dialog=>{this.dialog=/captcha|कैप्चा/i.test(dialog.message())&&/invalid|incorrect|wrong|गलत|अमान्य/i.test(dialog.message())?'captcha':'unknown';await dialog.dismiss().catch(()=>{});});
    await this.page.goto(POLY_ORIGIN+this.loginPath,{waitUntil:'domcontentloaded'});
    return this.loginImage();
  }
  async snapshot() {return this.page.evaluate(readPolyDocument);}
  safe(s) {
    try {const u=new URL(s.url),a=new URL(s.formAction||s.url);return !this.closed&&!this.externalBlocked&&!s.externalFrame&&u.origin===POLY_ORIGIN&&this.paths.has(u.pathname.toLowerCase())&&a.origin===POLY_ORIGIN&&a.pathname===u.pathname&&['','_self'].includes(s.target);} catch {return false;}
  }
  async loginImage() {const s=await this.snapshot();if(!this.safe(s)||new URL(s.url).pathname.toLowerCase()!==this.loginPath.toLowerCase()) throw Error('Expected official login page.');return this.page.locator('#Captcha').screenshot();}
  async navigate(action) {
    const [response]=await Promise.all([this.page.waitForNavigation({waitUntil:'domcontentloaded'}),action()]);
    if(response?.status()>=400||this.externalBlocked) throw Error('Portal transition failed.');this.revision++;
  }
  async login({registration,otr,password,captcha}) {
    let s=await this.snapshot();if(!this.safe(s)||new URL(s.url).pathname.toLowerCase()!==this.loginPath.toLowerCase()) return {kind:'unsupported'};
    if(this.applicationType==='Renewal') {
      const selected=s.fields.find(f=>f.type==='radio'&&f.checked&&f.id.startsWith(PREFIX+'rbtnFR_'));
      if(!selected||!/renew|नवीनीकरण/i.test(selected.label)) return {kind:'unsupported',message:'The portal has not confirmed the selected Renewal login type. No credentials were submitted.'};
      this.loginRadioId=selected.id.slice(PREFIX.length);
    }
    this.registration=registration;this.otr=otr;this.dialog=undefined;
    for(const id of [this.loginRadioId,'rbtnLoginType_0']) {
      const element=this.page.locator(selector(PREFIX+id));
      if(!await element.isChecked()) {const live=(await this.snapshot()).fields.find(f=>f.id===PREFIX+id);if(live?.postback) await this.navigate(()=>element.check());else await element.check();}
    }
    s=await this.snapshot();if(!this.safe(s)) return {kind:'unsupported'};
    for(const [id,value] of Object.entries({txtLogin:registration,txtmob:otr,txt_pwd:password,txtCaptcha:captcha})) await this.page.locator(selector(PREFIX+id)).fill(value);
    const button=s.buttons.find(b=>b.id===PREFIX+'btnLogin');if(!this.safeButton(button,s)) return {kind:'unsupported'};
    await this.navigate(()=>this.page.locator(selector(button.id)).click());
    const next=await this.snapshot();
    if(new URL(next.url).pathname.toLowerCase()===this.loginPath.toLowerCase()) return {kind:'login-error',image:await this.loginImage()};
    return this.read();
  }
  safeButton(button,s) {return button&&!button.disabled&&['','_self'].includes(button.target)&&new URL(button.action).origin===POLY_ORIGIN&&new URL(button.action).pathname===new URL(s.url).pathname;}
  async go(link) {
    if(!link||!['','_self'].includes(link.target)) throw Error('Official navigation unavailable.');
    const url=new URL(link.href);if(url.origin!==POLY_ORIGIN||!this.paths.has(url.pathname.toLowerCase())) throw Error('Unknown destination.');
    // Navigate only to an href just inspected in this authenticated document.
    await this.page.goto(url.href,{waitUntil:'domcontentloaded'});this.revision++;return this.read();
  }
  async choose(operation) {
    const s=await this.snapshot();if(!this.safe(s)||this.pagePath(s.url)!=='/postmatric/default.aspx') return {kind:'unsupported'};
    this.operation=operation;
    if(operation==='pdf') return this.pdf();
    if(operation==='certificates') {
      if(s.certificatesComplete) return {kind:'complete',stage:'certificates'};
      return this.go(s.links.find(l=>l.id===PREFIX+'Href_IncomeCaste_Form'));
    }
    // An update link is evidence that entry is already complete. Do not replay it.
    if(s.links.some(l=>l.id===PREFIX+'Href_update_Form')) return {kind:'complete',stage:'form'};
    return this.go(s.links.find(l=>this.pagePath(l.href)==='/postmatric/applicationforminstitute.aspx'));
  }
  async home() {
    const s=await this.snapshot();if(!this.safe(s)) return {kind:'unsupported'};
    if(this.pagePath(s.url)==='/postmatric/default.aspx') return this.read();
    return this.go(s.links.find(l=>l.id==='Home'||this.pagePath(l.href)==='/postmatric/default.aspx'));
  }
  values() {return Object.fromEntries([...this.answers].map(([key,v])=>[key,v.value]));}
  optionalBlankFields(stage,snapshot) {return [];}
  token(stage,s,record='') {
    // Includes reviewed values and declaration labels, not cookies or hidden ASP.NET state.
    return JSON.stringify([this.revision,stage,s.url,s.formAction,s.fields.map(f=>[f.id,f.type,f.value,f.checked,f.disabled,f.options,f.label]),record]);
  }
  review(stage,s) {
    const lines=this.sections[stage].fields.filter(f=>!['account-confirm'].includes(f.type)).map(f=>{const v=this.answers.get(f.key);return v?`${f.label}: ${v.display}`:undefined;}).filter(Boolean);
    if(stage==='academic') lines.push('Intermediate row: left blank as requested.');
    const ifsc=s.fields.find(f=>f.id===PREFIX+'txt_IfscCode');if(ifsc?.value) {this.ifsc=ifsc.value;lines.push('Portal IFSC: '+ifsc.value);}
    return lines;
  }
  async read() {
    const s=await this.snapshot();if(!this.safe(s)||this.dialog==='unknown') return {kind:'unsupported'};
    const path=this.pagePath(s.url);
    if(path===this.loginPath.toLowerCase()) return {kind:'expired'};
    if(path==='/postmatric/default.aspx') return this.operation==='certificates'&&s.certificatesComplete?{kind:'complete',stage:'certificates'}:{kind:'dashboard',certificatesComplete:s.certificatesComplete};
    if(path==='/postmatric/applicationaccept.aspx'&&s.text.includes('आपके आवेदन पत्र की प्रविष्टियाँ सफलतापूर्वक भरी गयीं है')) return {kind:'complete',stage:'form'};
    let stage;
    if(path==='/postmatric/getincomecasteauth.aspx') {
      stage=s.casteRecord?'caste':s.incomeRecord&&!s.text.includes('e-District डाटा से आय प्रमाण पत्र संख्या मिलान सफल')?'income':s.buttons.some(b=>b.id===PREFIX+'btn_submit_caste')?'caste':'income';
    } else if(['/postmatric/applicationforminstitute.aspx','/postmatric/applicationformupdateinstitute.aspx'].includes(path)) {
      const candidates=['academic','personal','bank','fee'].filter(k=>s.buttons.some(b=>b.id===PREFIX+this.sections[k].button));
      if(candidates.length!==1) return {kind:'unsupported'};stage=candidates[0];
    } else return {kind:'unsupported'};
    const section=this.sections[stage];this.stage=stage;
    const allowed=new Set([...section.fields.map(f=>f.id),...this.optionalBlankFields(stage,s),...(stage==='academic'?this.ignoredEmptyFields.map(id=>PREFIX+id):[]),PREFIX+section.answer,PREFIX+section.declaration]);
    // Disabled display fields are read-only. Any unmapped editable field stops submission.
    const diagnostic=unmappedPolyFields(s.fields,allowed);
    if(diagnostic) return {kind:'unsupported',message:'This page contains additional editable fields. Please map them before submitting.',diagnostic:{...diagnostic,stage}};
    // The Fresh form renders an additional Intermediate row even when this workflow
    // is filling only the High School row. Leave it untouched and blank; if the
    // portal pre-populates it, stop rather than silently sending those values.
    if(stage==='academic'&&s.fields.some(f=>{
      const key=f.id.slice(PREFIX.length),value=String(f.value||'').trim();
      if(!this.ignoredEmptyFields.includes(key)||!value||this.ignoredDefaultValues[key]?.includes(value)) return false;
      if(f.options?.some(o=>o.value===f.value)&&!filterOptions({},f.options).some(o=>o.value===f.value)) return false;
      return true;
    })) return {kind:'unsupported',message:'The unused Intermediate row contains data. Review the official portal before continuing.'};
    if(stage==='personal') {
      const parents=this.answers.get('DropDownList2');
      if(parents&&!/माता.?पिता दोनों जीवित|both.*alive/i.test(parents.display)) return {kind:'unsupported',message:'This parents-status branch has not been mapped. Please complete it on the official portal.'};
    }
    const record=stage==='income'?s.incomeRecord:stage==='caste'?s.casteRecord:'';
    if(record) {
      const ids=section.fields.map(f=>this.answers.get(f.key)?.value),numbers=record.match(/\d+/g)||[];
      const matched=ids.every(id=>{const index=numbers.indexOf(id);if(!id||index<0) return false;numbers.splice(index,1);return true;});
      if(!matched||!/Certificate\s*Issued|प्रमाण.*जारी/i.test(record)) return {kind:'unsupported',message:'The returned certificate does not match the requested numbers or issued status. Check it on the official portal.'};
      if(!this.safeButton(s.buttons.find(b=>b.id===PREFIX+section.verify),s)) return {kind:'unsupported'};
      return {kind:'record',stage,record,token:this.token(stage,s,record)};
    }
    if(!this.safeButton(s.buttons.find(b=>b.id===PREFIX+section.button),s)) return {kind:'unsupported'};
    for(const field of section.fields) {
      const live=s.fields.find(f=>f.id===field.id);
      // Later dependent fields may be absent until the preceding answer posts back.
      const answer=this.answers.get(field.key);
      if(!live) return {kind:'unsupported',message:'A required mapped field is missing. No form was submitted.'};
      if(answer&&answer.value===live.value) continue;
      this.answers.delete(field.key);
      if(field.computed) {
        const values=this.values(),value=percentage(values.Gridview1_grid_txt_Obtain_0||'',values.Gridview1_grid_txt_TotalMarks_0||'');
        if(live.disabled&&live.value!==value) return {kind:'unsupported'};
        if(!live.disabled) await this.page.locator(selector(field.id)).fill(value);
        this.answers.set(field.key,{value,display:value});this.revision++;return this.read();
      }
      if(live.disabled) return {kind:'unsupported'};
      const choice=['choice','radio'].includes(field.type);
      if(choice&&!live.options) return {kind:'unsupported'};
      const options=choice?filterOptions(field,live.options):undefined;
      if(choice&&!options.length) return {kind:'unsupported'};
      const defaultLabel=field.sessionDefault&&!/2026\s*[-–]\s*(?:20)?27/.test(s.text)?undefined:field.defaultLabel;
      const suggestion=options?.find(o=>o.label.toLowerCase()===defaultLabel?.toLowerCase())?.value ?? field.defaultValue;
      return {kind:'field',stage,field:{...field,maxLength:live.maxLength,options,suggestion},token:this.token(stage,s)};
    }
    const declaration=section.declaration?s.fields.find(f=>f.id===PREFIX+section.declaration)?.label:undefined;
    if(section.declaration&&!declaration) return {kind:'unsupported',message:'The declaration could not be read. No form was submitted.'};
    if(stage==='bank'&&!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(s.fields.find(f=>f.id===PREFIX+'txt_IfscCode')?.value||'')) return {kind:'unsupported',message:'The portal has not provided a valid IFSC for this branch. No bank form was submitted.'};
    return {kind:'review',stage,review:this.review(stage,s),declaration,token:this.token(stage,s)};
  }
  async fill(field,value,token) {
    const current=await this.read();if(current.kind!=='field'||current.field.key!==field.key||current.token!==token) return {kind:'unsupported'};
    value=normalizePoly(current.field,value,this.values());
    const s=await this.snapshot(),live=s.fields.find(f=>f.id===field.id),element=this.page.locator(selector(field.id));
    const action=async()=>{
      if(field.type==='radio') {const option=live.options.find(o=>o.value===value);await this.page.locator(selector(option.id)).check();}
      else if(field.options) await element.selectOption(value);
      else if(field.type==='account-confirm') {await element.fill('');await element.pressSequentially(value);await element.press('Tab');}
      else await element.fill(value);
    };
    // selectOption emits change even when the option is already selected.
    // Accept an inspected existing choice without dispatching a fresh ASP.NET
    // postback, which would otherwise race the next read/default fill.
    if(field.options&&live.value===value) this.revision++;
    else if(live.postback&&live.value!==value) await this.navigate(action);
    else {await action();this.revision++;}
    this.answers.set(field.key,{value,display:field.options?.find(o=>o.value===value)?.label||value});
    return this.read();
  }
  async edit(key) {
    const section=this.sections[this.stage],index=section.fields.findIndex(f=>f.key===key&&!f.computed);
    if(index<0) throw Error('Select a field from this section.');
    for(const field of section.fields.slice(index)) this.answers.delete(field.key);
    // Force an answered-but-unchanged value to be asked again on the next read.
    this.revision++;return this.read();
  }
  async captcha(refresh=false) {
    const section=this.sections[this.stage];if(!section) return this.loginImage();
    if(refresh) {
      const before=await this.page.locator('#'+section.captcha).getAttribute('src');
      await this.page.locator('#'+section.refresh).click();
      await this.page.waitForFunction(({id,before})=>{const img=document.getElementById(id);return img&&img.complete&&img.naturalWidth>0&&img.getAttribute('src')!==before;},{id:section.captcha,before});
    }
    return this.page.locator('#'+section.captcha).screenshot();
  }
  async refreshLogin() {
    const before=await this.page.locator('#Captcha').getAttribute('src');await this.page.locator('#reloadcaptcha').click();
    await this.page.waitForFunction(before=>{const image=document.getElementById('Captcha');return image&&image.complete&&image.naturalWidth>0&&image.getAttribute('src')!==before;},before);
    return this.loginImage();
  }
  async submit(captcha,token,record=false) {
    if(this.attempted) return {kind:'unknown'};
    const step=await this.read();if(step.token!==token||step.kind!==(record?'record':'review')) return {kind:'unsupported'};
    const s=await this.snapshot(),section=this.sections[step.stage],button=s.buttons.find(b=>b.id===PREFIX+(record?section.verify:section.button));
    if(!this.safeButton(button,s)) return {kind:'unsupported'};
    if(!record) {
      await this.page.locator(selector(PREFIX+section.answer)).fill(captcha);
      if(section.declaration) await this.page.locator(selector(PREFIX+section.declaration)).check();
    }
    this.dialog=undefined;this.attempted=true;
    try {await this.navigate(()=>this.page.locator(selector(button.id)).click());} catch {return {kind:'unknown'};}
    const after=await this.snapshot();
    if(this.dialog==='captcha'||/(?:invalid|incorrect|wrong)\s*captcha|captcha[^\n]{0,25}(?:invalid|incorrect)|कैप्चा[^\n]{0,25}(?:गलत|अमान्य)/i.test(after.text)) {this.attempted=false;this.dialog=undefined;return {kind:'captcha-error'};}
    const next=await this.read();
    const confirmed=next.kind==='complete'||next.kind==='record'&&!record||next.stage&&next.stage!==step.stage;
    if(confirmed) {this.attempted=false;return next;}
    return {kind:'unknown'};
  }
  async pdf() {
    const s=await this.snapshot();if(!this.safe(s)||this.pagePath(s.url)!=='/postmatric/default.aspx') throw Error('Return Home before printing.');
    const link=s.links.find(l=>l.id===PREFIX+'Href_temp_Form');
    if(!link||new URL(link.href).origin!==POLY_ORIGIN||this.pagePath(link.href)!=='/postmatric/tempprintinstitute.aspx') throw Error('Official check-print link unavailable.');
    await this.page.goto(link.href,{waitUntil:'domcontentloaded'});this.revision++;
    const print=await this.snapshot();
    if(!this.safe(print)||this.pagePath(print.url)!=='/postmatric/tempprintinstitute.aspx'||!print.text.replaceAll(/\s/g,'').includes(this.registration)||/Some Error Occurred|Your Request Could Not Be Processed/i.test(print.text)) throw Error('Check-print identity could not be verified.');
    const native=print.links.find(l=>/\.pdf(?:[?#]|$)/i.test(l.href)&&new URL(l.href).origin===POLY_ORIGIN);
    let bytes;
    if(native) {
      this.nativePdfUrl=native.href;
      // Native download must be exposed by the inspected official print page.
      const element=this.page.getByRole('link',{name:native.text,exact:true});
      const [download]=await Promise.all([this.page.waitForEvent('download'),element.click()]);
      const stream=await download.createReadStream(),chunks=[];let size=0;
      for await(const chunk of stream) {size+=chunk.length;if(size>16*1024*1024) throw Error('PDF too large.');chunks.push(chunk);}bytes=Buffer.concat(chunks);await download.delete();
    } else {
      await this.page.evaluate(()=>document.fonts.ready);await this.page.emulateMedia({media:'print'});
      bytes=await this.page.pdf({format:'A4',printBackground:true,preferCSSPageSize:true});
    }
    const result=await validatePolyPdf(bytes,this.registration);
    return {kind:'pdf',bytes,pages:result.pages};
  }
  async close() {this.closed=true;this.answers.clear();this.registration=undefined;this.otr=undefined;await this.context?.close().catch(()=>{});await this.browser?.close().catch(()=>{});}
}
