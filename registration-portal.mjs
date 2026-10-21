import {OtrPortal} from './otr-portal.mjs';
import {OTR_ORIGIN} from './otr-schema.mjs';

const prefix = 'ContentPlaceHolder1_';
export const REGISTRATION_FIELDS = [
  ['ddl_district','District where you study','choice'],
  ['ddl_institute','Institution','choice'],
  ['ddl_caste','Category / caste group','choice'],
  ['ddl_relegion','Religion','choice'],
  ['ddl_highschpassyear','High-school passing year','choice'],
  ['ddl_board','High-school board','choice'],
  ['txt_hghrollnoA','Roll-number letter prefix (optional). Send NONE if there are no letters.','prefix'],
  ['txt_hghrollno','High-school roll number — numeric part, keeping leading zeros','roll'],
  ['txt_pwd','Choose a new password: 6–12 characters, including uppercase, lowercase, a digit and one of @ # $ &.','password'],
  ['txt_pwd_confirm','Enter the same password again','password-confirm'],
  ['txtCaptcha','CAPTCHA','captcha'],
].map(([suffix,label,type]) => ({id:prefix+suffix,key:prefix+suffix,label,type}));
const otr = {id:prefix+'TextBox3',key:prefix+'TextBox3',label:'Existing OTR number (for example UP26-0000000001)','type':'otr'};
const routes = {
  [prefix+'lnbPostFreshSW']:'SC / ST / General — Postmatric other than classes 11–12 (UP)',
  [prefix+'lnbPostFreshOBC']:'OBC — Postmatric other than classes 11–12 (UP)',
  [prefix+'lnbPostFreshMin']:'Minority — Postmatric other than classes 11–12 (UP)',
};

// Values remain in the isolated browser/session only. Never log this snapshot.
export function readRegistrationDocument() {
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const fields = [...document.querySelectorAll('input,select,textarea')].filter(e => visible(e) && !e.disabled && !e.readOnly && !['hidden','submit','button','reset'].includes(e.type)).map(e => ({
    id:e.id,inputType:e.type,value:e.value,maxLength:e.maxLength > 0 ? e.maxLength : undefined,
    options:e.tagName === 'SELECT' ? [...e.options].filter(o => o.value && !o.disabled && !/^select/i.test(o.text.trim())).map(o => ({value:o.value,label:o.text.trim()})) : undefined,
  }));
  const buttons = [...document.querySelectorAll('input[type=submit],button')].filter(visible).map(e=>({id:e.id,disabled:e.disabled,action:e.formAction || e.form?.action,target:e.formTarget || e.form?.target || ''}));
  const links = [...document.querySelectorAll('a[id]')].filter(visible).map(e=>({id:e.id,href:e.getAttribute('href')}));
  const identity = ['txt_studentname','txt_mobileno'].map(suffix => {
    const e = document.getElementById('ContentPlaceHolder1_'+suffix);
    return e && visible(e) && (e.disabled || e.readOnly) ? e.value : '';
  });
  const form = document.querySelector('form');
  return {url:location.href,fields,buttons,links,identity,formAction:form?.action,target:form?.target || '',
    externalFrame:[...document.querySelectorAll('iframe')].some(e => visible(e) && new URL(e.src,location.href).origin !== location.origin),
    detailsVisible:!!document.getElementById('ContentPlaceHolder1_dvreg')?.getClientRects().length};
}

export class RegistrationPortal extends OtrPortal {
  constructor(options = {}) {
    super({...options,mode:'register'});
    this.startPath = '/RegistrationNew.aspx';
    this.answers = new Map();
    this.revision = 0;
    this.finalAttempted = false;
  }

  async snapshot() { return this.page.evaluate(readRegistrationDocument); }
  safe(snapshot) {
    const url = new URL(snapshot.url);
    if (url.origin !== OTR_ORIGIN || snapshot.externalFrame || this.externalBlocked) return false;
    const destination = new URL(snapshot.formAction || snapshot.url);
    return destination.origin === OTR_ORIGIN && destination.pathname === url.pathname && ['', '_self'].includes(snapshot.target);
  }
  async read() {
    const s = await this.snapshot();
    if (!this.safe(s)) return {kind:'unsupported',reason:'external-verification'};
    if (this.dialogError) { this.dialogError = undefined; return {kind:'unsupported',reason:'dialog'}; }
    const path = new URL(s.url).pathname.toLowerCase();
    let field, action;
    if (path === '/registrationnew.aspx') {
      const options = s.links.filter(l => routes[l.id] && /^javascript:__doPostBack\(/.test(l.href ?? '')).map(l => ({value:l.id,label:routes[l.id]}));
      if (!options.length || s.fields.length) return {kind:'unsupported',reason:'fields'};
      field = {key:'route',label:'Choose your department. This module supports Fresh Postmatric in UP, excluding classes 11–12 (the form in your screenshot). Renewal applicants should use their existing registration.',type:'choice',options};
      action = {kind:'choose'};
    } else if (path === '/registrationforminstitutedig.aspx') {
      const allowed = new Set([otr.id,...REGISTRATION_FIELDS.map(f=>f.id)]);
      if (s.fields.some(f=>!allowed.has(f.id))) return {kind:'unsupported',reason:'fields'};
      if (!s.detailsVisible) {
        if (s.fields.length !== 1 || s.fields[0].id !== otr.id || s.fields[0].inputType !== 'text') return {kind:'unsupported',reason:'fields'};
        field = {...otr,maxLength:s.fields[0].maxLength};
        action = {kind:'lookup',id:prefix+'btn_sumit_otr'};
      } else {
        // Fail closed on a missing/changed field rather than silently skipping it.
        if (!s.identity.every(Boolean) || REGISTRATION_FIELDS.some(f=>!s.fields.some(a=>a.id===f.id))) return {kind:'unsupported',reason:'fields'};
        if (this.identity && JSON.stringify(s.identity) !== JSON.stringify(this.identity)) return {kind:'unsupported',reason:'changed-values'};
        this.identity ??= [...s.identity];
        if (s.fields.find(f=>f.id===otr.id)?.value !== this.answers.get(otr.key)?.value) return {kind:'unsupported',reason:'changed-values'};
        for (const spec of REGISTRATION_FIELDS) {
          const live = s.fields.find(f=>f.id===spec.id);
          if ((spec.type === 'choice' && live.inputType !== 'select-one') || (spec.type.startsWith('password') && live.inputType !== 'password') || (!['choice','password','password-confirm'].includes(spec.type) && live.inputType !== 'text')) return {kind:'unsupported',reason:'fields'};
          const saved = this.answers.get(spec.key);
          // ASP.NET can reset fields on postback. Re-ask anything it discarded.
          if (saved && live.value !== saved.value) this.answers.delete(spec.key);
        }
        const spec = REGISTRATION_FIELDS.find(f=>!this.answers.has(f.key));
        if (!spec) return {kind:'unknown'};
        const live = s.fields.find(f=>f.id===spec.id);
        if (spec.type === 'choice' && !live.options.length) return {kind:'unsupported',reason:'fields'};
        field = {...live,...spec};
        if (spec.id === prefix+'ddl_board') {
          field.options=live.options.filter(o=>['UP BOARD','CBSE'].includes(o.label.toUpperCase()));
          if (field.options.length!==2) return {kind:'unsupported',reason:'fields'};
        }
        delete field.value;
        action = {kind:spec.type === 'captcha' ? 'register' : 'fill',id:prefix+'btn_submit'};
      }
      const button = s.buttons.find(b=>b.id===action.id);
      if (!button || button.disabled || !['','_self'].includes(button.target) || new URL(button.action).origin !== OTR_ORIGIN || new URL(button.action).pathname !== new URL(s.url).pathname) return {kind:'unsupported',reason:'action'};
    } else return {kind:'unsupported',reason:'page'};
    const step = {kind:'form',stage:action.kind==='register'?'final':'details',fields:[field],action,
      fingerprint:JSON.stringify([this.revision,path,field.key,field.options,field.maxLength,s.fields.map(f=>[f.id,f.inputType,f.options]),action]),
      review:[...this.answers.values()].filter(a=>!a.type.startsWith('password') && a.type!=='captcha').map(a=>`${a.label}: ${a.display}`)};
    if (s.identity[0]) step.review.push(`Student: ${s.identity[0]}`,`Linked mobile: ••••••${s.identity[1].slice(-4)}`);
    if (field.type === 'captcha') step.image = await this.captchaImage();
    this.step = step;
    return step;
  }

  async navigate(action) {
    const [response] = await Promise.all([this.page.waitForNavigation({waitUntil:'domcontentloaded'}),action()]);
    if (response?.status() >= 400) throw new Error('Registration website response failed.');
    if (this.externalBlocked || new URL(this.page.url()).origin !== OTR_ORIGIN) throw new Error('External registration navigation blocked.');
    this.revision++;
  }

  async editPrevious(fingerprint) {
    if(this.finalAttempted) return null;
    const step=await this.read();
    if(step.kind!=='form'||step.fingerprint!==fingerprint||!['fill','register'].includes(step.action.kind)) return null;
    const index=REGISTRATION_FIELDS.findIndex(field=>field.key===step.fields[0].key)-1;
    // District is fixed; the completed OTR lookup and department navigation are
    // outside this editable details stage.
    if(index<1) return null;
    for(const field of REGISTRATION_FIELDS.slice(index)) this.answers.delete(field.key);
    this.revision++;
    return this.read();
  }

  async submit(values,fingerprint) {
    if (this.finalAttempted) return {kind:'unknown'};
    const step = await this.read();
    if (step.kind !== 'form' || step.fingerprint !== fingerprint) return {kind:'unsupported',reason:'changed-form'};
    const field = step.fields[0], value = values[field.key];
    if (typeof value !== 'string') return {kind:'unsupported',reason:'missing-field'};
    if (field.options && !field.options.some(o=>o.value===value)) return {kind:'unsupported',reason:'fields'};
    if (step.action.kind === 'choose') {
      const option = field.options.find(o=>o.value===value);
      if (!option) return {kind:'unsupported',reason:'fields'};
      this.answers.set('route',{type:'choice',label:'Department / course',value,display:option.label});
      await this.navigate(()=>this.field(value).click());
      return this.read();
    }
    const locator = this.field(field.id);
    const postback = /__doPostBack|WebForm_DoPostBackWithOptions/.test(await locator.getAttribute('onchange') ?? '');
    const fill = async () => {
      if (field.options) await locator.selectOption(value);
      else { await locator.fill(value); if (postback) await locator.press('Tab'); }
    };
    if (postback) await this.navigate(fill); else await fill();
    if (await this.field(field.id).inputValue() !== value) return {kind:'unsupported',reason:'changed-values'};
    if (step.action.kind === 'fill') {
      this.answers.set(field.key,{...field,value,display:field.options?.find(o=>o.value===value)?.label ?? (value || '(none)')});
      this.revision++;
      return this.read();
    }
    // Recheck every accepted answer, including disabled OTR-derived identity,
    // immediately before the final click. Never fill any unknown control.
    const current = await this.read();
    if (current.kind !== 'form' || current.fingerprint !== fingerprint) return {kind:'unsupported',reason:'changed-form'};
    if (step.action.kind === 'lookup') {
      this.answers.set(field.key,{...field,label:'OTR number',value,display:value});
      await this.navigate(()=>this.field(step.action.id).click());
      const next = await this.read();
      if (next.kind === 'form' && next.action.kind === 'lookup') return {kind:'unsupported',reason:'otr-lookup'};
      return next;
    }
    if (step.action.kind !== 'register') return {kind:'unsupported',reason:'action'};
    this.finalAttempted = true;
    await this.navigate(()=>this.field(step.action.id).click());
    // The protected receipt layout is not assumed. Deliver the official response
    // once, without asserting success or submitting a continuation form.
    if (this.externalBlocked || new URL(this.page.url()).origin !== OTR_ORIGIN) return {kind:'unsupported',reason:'external-verification'};
    const image = await this.page.screenshot({type:'png',fullPage:true,mask:[this.page.locator('input[type=password],input[id*=txt_pwd], #ContentPlaceHolder1_txtCaptcha, #Captcha, input[autocomplete="one-time-code"], input[id*="otp" i], input[name*="otp" i]')]});
    return {kind:'result-image',image};
  }

  async refresh(fingerprint) {
    if (this.finalAttempted) return {kind:'unknown'};
    const step = await this.read();
    if (step.kind !== 'form' || step.fingerprint !== fingerprint || step.fields[0].type !== 'captcha') return {kind:'unsupported',reason:'changed-form'};
    const button = this.field('reloadcaptcha');
    if (!await button.isVisible()) return {kind:'unsupported',reason:'refresh'};
    const previous = await this.page.locator('#Captcha').getAttribute('src');
    await button.click();
    await this.page.waitForFunction(src=>document.querySelector('#Captcha')?.getAttribute('src') !== src,previous);
    await this.field(prefix+'txtCaptcha').fill('');
    this.revision++;
    return this.read();
  }

  async close() { this.answers.clear(); this.identity=undefined; await super.close(); }
}
