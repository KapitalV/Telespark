import {OtrPortal} from './otr-portal.mjs';
import {classifyOtrPage, fieldType, OTR_ORIGIN} from './otr-schema.mjs';
import {setTimeout as delay} from 'node:timers/promises';

export function normalizeRecoveryLabel(text = '') {
  return text.normalize('NFKC')
    .replace(/ओ[०.\s]*टी[०.\s]*पी[०.]*/gu, 'OTP')
    .replace(/ओ[०.\s]*टी[०.\s]*आर[०.]*/gu, 'OTR')
    .replace(/\(\s*OTR\s*\)/gi, '')
    .replace(/\s+/g, ' ').trim();
}

// Recognize the operation of a rendered recovery control, never invent its ID
// or call a guessed endpoint. Registration has its own existing adapter.
export function normalizeRecoverySnapshot(snapshot) {
  return {...snapshot, fields:snapshot.fields.map(field => {
    const label = normalizeRecoveryLabel(field.label);
    const isOtp = /otp|one.?time.?password/i.test(`${field.id} ${label}`);
    return {...field,label,inputType:isOtp && field.inputType === 'password' ? 'text' : field.inputType};
  }), buttons:snapshot.buttons.map(button => {
    let label = normalizeRecoveryLabel(button.label);
    if (/^(?:otp\s*)?(?:पुनः भेजें|दोबारा भेजें)$|^पुनः\s*otp\s*भेजें$/i.test(label)) label = 'Resend OTP';
    else if (/^(?:otp\s*)?सत्यापित करें$|^(?:verify|validate)(?:\s+otp)?$/i.test(label)) label = 'Verify OTP';
    else if (/^otr\s*पुनः प्राप्त करें$/i.test(label)) label = 'Recover OTR';
    return {...button,label};
  })};
}

export function classifyRecovery(snapshot, {verificationSubmitted = false} = {}) {
  let url;
  try { url = new URL(snapshot.url); } catch { return {kind:'unsupported',reason:'page'}; }
  if (url.origin !== OTR_ORIGIN || snapshot.externalFrame) return {kind:'unsupported',reason:'external-verification'};
  const candidates = [...new Set([snapshot.result,...(snapshot.recoveryResults ?? [])].filter(value => typeof value === 'string' && (/^[A-Za-z0-9-]{8,30}$/.test(value) || /^(?=.{8,64}$)(?=.*\d{8})[A-Za-z0-9]+(?:[ /\-\u2010-\u2015][A-Za-z0-9]+)*$/u.test(value))))];
  // A labelled value is only a result after this session actually submitted
  // OTP verification, and never while a verification input/error remains.
  if (verificationSubmitted && candidates.length === 1 && !snapshot.error && snapshot.fields.length === 0) {
    return {kind:'success',otr:candidates[0]};
  }
  // A screenshot does not require parsing the website's heading text. The
  // observed final result panel is enough to show the user the portal response,
  // after this session submitted verification and no input/error remains.
  const panel = snapshot.recoveryPanel;
  if (verificationSubmitted && url.pathname.toLowerCase() === '/forgetotr.aspx' && !snapshot.error && !snapshot.fields.length && !candidates.length && panel?.values.length === 1 && panel.values[0].length <= 80 && /\d{8}/.test(panel.values[0])) {
    return {kind:'result-image'};
  }
  if (snapshot.fields.some(field => !['mobile','captcha','otp'].includes(fieldType(field)))) return {kind:'unsupported',reason:'fields'};
  const step = classifyOtrPage({...snapshot,result:undefined},'recover');
  if (step.kind !== 'form') return step;
  if (step.action.kind === 'send-otp' && !step.fields.some(field => field.type === 'captcha')) return {kind:'unsupported',reason:'fields'};
  return step;
}

export class OtrRecoveryPortal extends OtrPortal {
  constructor(options = {}) { super({...options,mode:'recover'}); this.verificationSubmitted = false; }
  async snapshot() { return normalizeRecoverySnapshot(await super.snapshot()); }
  classify(snapshot) { return classifyRecovery(snapshot,{verificationSubmitted:this.verificationSubmitted}); }
  async read() {
    const step = await super.read();
    if (!['success','result-image'].includes(step.kind)) return step;
    try {
      const panel = this.page.locator('#ContentPlaceHolder1_finalotr_div');
      const image = await panel.isVisible()
        ? await panel.screenshot({type:'png'})
        : await this.page.screenshot({type:'png',fullPage:true});
      this.report({event:'otr-result-image',mode:'recover'});
      return {...step,image};
    } catch {
      // Keep a verified text result if image capture alone fails. Never repeat
      // the OTP submission to obtain another screenshot.
      if (step.kind === 'success') return step;
      return {kind:'unknown'};
    }
  }
  beforeSubmit(step) { if (step.action.kind === 'verify-otp') this.verificationSubmitted = true; }
  async performSubmit(step) {
    const pathname = new URL(this.page.url()).pathname;
    const [response] = await Promise.all([
      this.page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().method() === 'POST' && url.origin === OTR_ORIGIN && url.pathname === pathname;
      },{timeout:30_000}),
      this.field(step.action.id).click(),
    ]);
    await response.finished();
    if (response.status() >= 400) throw Object.assign(new Error('Recovery response unavailable'),{code:`HTTP_${response.status()}`});
    // ASP.NET can replace a document or update its existing form. Wait for a
    // meaningful visible state in either case, without clicking a second time.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (this.closed) throw new Error('Recovery cancelled');
      try {
        const next = this.classify(await this.snapshot());
        if (['success','result-image'].includes(next.kind) || this.dialogError || (next.kind === 'form' && (next.fingerprint !== step.fingerprint || next.error))) return;
      } catch { /* A full navigation briefly destroys the old DOM context. */ }
      await delay(100);
    }
    // The common submit handler marks an unchanged form as uncertain.
  }
  async close() { this.verificationSubmitted = false; await super.close(); }
}
