import {chromium} from 'playwright';
import {classifyOtrPage, OTR_ORIGIN, OTR_PATHS} from './otr-schema.mjs';
import {diagnosticWords, otrDiagnostic} from './otr-diagnostics.mjs';

export function classifyOtrDialog(text) {
  const invalid = /invalid|incorrect|wrong|expired|गलत|अमान्य|समाप्त/i.test(text);
  if (invalid && /captcha|कैप्चा/i.test(text)) return 'captcha';
  if (invalid && /otp|ओ[०.\s]*टी[०.\s]*पी/i.test(text)) return 'otp';
  if (/otp|ओ[०.\s]*टी[०.\s]*पी/i.test(text) && /sent|भेज|भेजा/i.test(text)) return 'notice';
  return 'unknown';
}

// This function runs in the page. It reads visible structure, not hidden
// ASP.NET state, input values, Aadhaar numbers, or cookies.
export function readOtrDocument() {
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const label = e => {
    const explicit = Array.from(e.labels ?? []).map(l => l.innerText).join(' ').trim();
    if (explicit) return explicit;
    return e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.id;
  };
  const inputs = Array.from(document.querySelectorAll('input,select,textarea')).filter(e => visible(e) && !e.disabled && !e.readOnly && !['hidden','submit','button','reset'].includes(e.type));
  const fields = inputs.map(e => ({id:e.id, label:label(e).slice(0,2000), tag:e.tagName,
    inputType:e.type, placeholder:e.getAttribute('placeholder') || '', required:e.required || e.type !== 'checkbox',
    maxLength:e.maxLength > 0 ? e.maxLength : undefined,
    options:e.tagName === 'SELECT' ? Array.from(e.options).filter(o => o.value && !o.disabled).map(o => ({value:o.value,label:o.text})) : undefined}));
  const buttons = Array.from(document.querySelectorAll('button,input[type=submit],input[type=button]')).filter(visible).map(e => ({
    id:e.id,label:e.tagName === 'INPUT' ? e.value : e.innerText,disabled:e.disabled,
    actionUrl:e.hasAttribute('formaction') ? e.formAction : e.form?.action || location.href,
    target:e.getAttribute('formtarget') || e.form?.target || '',
  }));
  const frames = Array.from(document.querySelectorAll('iframe')).filter(visible);
  const externalFrame = frames.some(e => { try { return new URL(e.src, location.href).origin !== location.origin; } catch { return true; } });
  const text = document.body.innerText;
  let error;
  if (/(?:invalid|incorrect|wrong|expired)\s*captcha|captcha[^\n]{0,25}(?:invalid|incorrect|expired)|कैप्चा[^\n]{0,25}(?:गलत|अमान्य)/i.test(text)) error = 'captcha';
  else if (/(?:invalid|incorrect|wrong|expired)\s*(?:otp|one.?time.?password)|otp[^\n]{0,25}(?:invalid|incorrect|expired)|ओटीपी[^\n]{0,25}(?:गलत|अमान्य|समाप्त)/i.test(text)) error = 'otp';
  else if (/(?:already registered|already exists|पहले से पंजीकृत)/i.test(text)) error = 'already-registered';
  else if (/(?:mobile[^\n]{0,30}not (?:found|registered)|record not found|रिकॉर्ड नहीं)/i.test(text)) error = 'not-found';
  else if (/(?:too many|try again later|limit exceeded)/i.test(text)) error = 'rate-limit';
  // Accept only an explicit OTR-labelled output value. Broad body regexes can
  // confuse mobile/Aadhaar numbers in a review page with the generated OTR.
  const otrLabel = /^(?:your\s+)?(?:OTR|ओ[०.]?टी[०.]?आर[०.]?)(?:\s*\(OTR\))?\s*(?:number|no\.?|संख्या|नंबर)\s*[:：]?$/i;
  const candidates = [];
  for (const e of document.querySelectorAll('th,td,dt,label,span,strong,b')) {
    if (!visible(e) || !otrLabel.test(e.innerText.trim())) continue;
    const sibling = e.nextElementSibling;
    if (sibling && visible(sibling) && /^[A-Za-z0-9-]{8,30}$/.test(sibling.innerText.trim())) candidates.push(sibling.innerText.trim());
  }
  const unique = [...new Set(candidates)];
  // Recovery pages can render the labelled number inline or as a read-only
  // textbox. Read only explicit output labels, not numbers from arbitrary prose.
  const recoveryResults = [...unique];
  const inlineOtr = /^(?:(?:your|आपका|आपकी)\s+)?(?:OTR|ओ[०.\s]*टी[०.\s]*आर[०.]*)(?:\s*\(OTR\))?\s*(?:number|no\.?|संख्या|नंबर)\s*[:：]\s*([A-Za-z0-9-]{8,30})\s*$/i;
  for (const e of document.querySelectorAll('td,dd,p,span,label,strong,b,output')) {
    if (!visible(e)) continue;
    const match = inlineOtr.exec(e.innerText.trim());
    if (match) recoveryResults.push(match[1]);
  }
  for (const e of document.querySelectorAll('input[readonly],input:disabled')) {
    if (visible(e) && otrLabel.test(label(e).trim()) && /^[A-Za-z0-9-]{8,30}$/.test(e.value.trim())) recoveryResults.push(e.value.trim());
  }
  // Observed live recovery output: a dedicated finalotr_div containing an
  // H3 "Your OTR is" label and an H1 identifier, rather than a table/textbox.
  // Keep this scoped to that panel; unrelated page headings are not results.
  const finalOtr = document.getElementById('ContentPlaceHolder1_finalotr_div');
  let recoveryPanel;
  if (location.pathname.toLowerCase() === '/forgetotr.aspx' && finalOtr && visible(finalOtr)) {
    const headings = Array.from(finalOtr.querySelectorAll('h3')).filter(visible).map(e => e.innerText.trim());
    const labelled = headings.some(value => /^your\s+otr\s+is[\s\p{P}]*$/iu.test(value.normalize('NFKC')));
    const values = Array.from(finalOtr.querySelectorAll('h1')).filter(visible).map(e => e.innerText.trim());
    recoveryPanel = {labelled,headings,values};
    if (labelled) {
      for (const value of values) {
        if (/^(?=.{8,64}$)(?=.*\d{8})[A-Za-z0-9]+(?:[ /\-\u2010-\u2015][A-Za-z0-9]+)*$/u.test(value)) recoveryResults.push(value);
      }
    }
  }
  // Kept only in this in-memory snapshot. Diagnostics reduce these blocks to
  // an allowlisted vocabulary and number lengths; raw page text is never logged.
  const resultBlocks = [];
  if (fields.length === 0) {
    const seen = new Set();
    for (const e of document.querySelectorAll('body,main,section,div,h1,h2,h3,h4,p,span,label,td,dd,output')) {
      if (!visible(e)) continue;
      const value = e.innerText.trim();
      if (!value || value.length > 500 || seen.has(value)) continue;
      seen.add(value);
      resultBlocks.push({tag:e.tagName,id:e.id,text:value});
      if (resultBlocks.length >= 40) break;
    }
  }
  return {url:location.href, fields, buttons, externalFrame, error, result:unique.length === 1 ? unique[0] : undefined,recoveryResults:[...new Set(recoveryResults)],resultBlocks,recoveryPanel};
}

export class OtrPortal {
  constructor({mode, headless = true, channel = process.platform === 'win32' ? 'msedge' : 'chromium', launch = options => chromium.launch(options), onDiagnostic = () => {}} = {}) {
    if (!['recover','register'].includes(mode)) throw new Error('Invalid OTR mode.');
    Object.assign(this, {mode, headless, channel, launch, onDiagnostic});
    this.closed = false;
  }

  async open() {
    if (this.closed) throw new Error('OTR session closed.');
    const browser = await this.launch({headless:this.headless, channel:this.channel === 'chromium' ? undefined : this.channel, timeout:30_000});
    if (this.closed) { await browser.close(); throw new Error('OTR session closed.'); }
    this.browser = browser;
    this.context = await browser.newContext({viewport:{width:1100,height:900}});
    // Enforce the destination before transmission, including JS-driven redirects
    // or form actions that differ from the current page's origin.
    await this.context.route('**/*', async route => {
      const request = route.request();
      if (new URL(request.url()).origin === OTR_ORIGIN) return route.fallback();
      if (request.isNavigationRequest() || ['xhr','fetch'].includes(request.resourceType())) this.externalBlocked = true;
      return route.abort();
    });
    // Unexpected permissions and browser dialogs are never accepted blindly.
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(10_000);
    this.page.setDefaultNavigationTimeout(30_000);
    this.page.on('dialog', async dialog => {
      const text = dialog.message();
      const kind = classifyOtrDialog(text);
      this.report({event:'otr-dialog',kind,words:diagnosticWords(text)});
      this.dialogError = kind === 'notice' ? undefined : kind;
      await dialog.dismiss().catch(() => {});
    });
    const response = await this.page.goto(`${OTR_ORIGIN}${OTR_PATHS[this.mode]}`, {waitUntil:'domcontentloaded'});
    if (response?.status() >= 400) {
      const error = new Error('OTR website unavailable.');
      error.code = `HTTP_${response.status()}`;
      throw error;
    }
    return this.read();
  }

  async snapshot() { return this.page.evaluate(readOtrDocument); }
  classify(snapshot) { return classifyOtrPage(snapshot, this.mode); }
  report(event) { try { this.onDiagnostic(event); } catch { /* Diagnostics cannot interrupt a submission. */ } }

  async read() {
    if (this.externalBlocked) return {kind:'unsupported',reason:'external-verification'};
    const snapshot = await this.snapshot();
    let step;
    const url = new URL(snapshot.url);
    if (this.mode === 'register' && url.origin === OTR_ORIGIN && url.pathname.toLowerCase() === '/popup.aspx') {
      const checkbox = snapshot.fields.find(f => f.id === 'chk' && f.inputType === 'checkbox');
      // Consent must be the full current declaration, never a guessed summary.
      if (checkbox && /guidelines/i.test(checkbox.label) && /consent/i.test(checkbox.label)) {
        step = {kind:'form',stage:'consent',fields:[{...checkbox,key:'chk',type:'consent'}],action:{kind:'consent',label:'Accept OTR declaration'},fingerprint:checkbox.label};
      }
    }
    step ??= this.classify(snapshot);
    if (this.dialogError) {
      if (step.kind === 'form' && ['captcha','otp'].includes(this.dialogError)) step.error = this.dialogError;
      else step = {kind:'unsupported',reason:'dialog'};
      this.dialogError = undefined;
    }
    if (step.kind === 'unsupported') this.report(otrDiagnostic(snapshot,step.reason));
    if (step.kind === 'success') this.report({event:'otr-result-recognized',mode:this.mode});
    if (step.kind === 'form' && step.fields.some(f => f.type === 'captcha')) step.image = await this.captchaImage();
    this.step = step;
    return step;
  }

  async captchaImage() {
    await this.page.waitForFunction(() => {
      const e = document.querySelector('#Captcha');
      return e?.complete && e.naturalWidth > 0;
    });
    return this.page.locator('#Captcha').screenshot({type:'png'});
  }

  field(id) { return this.page.locator(`[id=${JSON.stringify(id)}]`); }

  async submit(values, fingerprint) {
    const current = await this.read();
    if (current.kind !== 'form' || current.fingerprint !== fingerprint) return {kind:'unsupported',reason:'changed-form'};
    if (current.stage === 'consent') {
      if (values.chk !== true) return {kind:'unsupported',reason:'consent'};
      await this.field('chk').check();
      // Observed public Popup.aspx control, revealed by its checkbox change handler.
      const proceed = this.field('btnsub');
      if (!await proceed.isVisible() || !await proceed.isEnabled() || !/^Proceed to OTR Registration\s*→?$/.test(await proceed.inputValue())) return {kind:'unsupported',reason:'consent-continuation'};
      const consentAction = (await this.snapshot()).buttons.find(b => b.id === 'btnsub');
      const destination = new URL(consentAction.actionUrl);
      if (destination.origin !== OTR_ORIGIN || destination.pathname.toLowerCase() !== '/popup.aspx' || !['','_self'].includes(consentAction.target)) return {kind:'unsupported',reason:'external-verification'};
      await Promise.all([
        this.page.waitForURL(url => url.origin === OTR_ORIGIN && url.pathname.toLowerCase() === '/regwithotr.aspx', {waitUntil:'domcontentloaded'}),
        proceed.click(),
      ]);
      return this.read();
    }
    for (const field of current.fields) {
      if (!(field.key in values)) return {kind:'unsupported',reason:'missing-field'};
    }
    for (const field of current.fields) {
      const locator = this.field(field.id);
      const postback = /__doPostBack|WebForm_DoPostBackWithOptions/.test(await locator.getAttribute('onchange') ?? '');
      const fill = async () => {
        if (field.type === 'consent') await locator.setChecked(values[field.key] === true);
        else if (field.options?.length) await locator.selectOption(values[field.key]);
        else {
          await locator.fill(values[field.key]);
          if (postback) await locator.press('Tab');
        }
      };
      if (postback) await Promise.all([this.page.waitForNavigation({waitUntil:'domcontentloaded'}),fill()]);
      else await fill();
    }
    // Recheck shape after change/postback events and before the consequential click.
    const beforeClick = this.classify(await this.snapshot());
    if (beforeClick.kind !== 'form' || beforeClick.fingerprint !== fingerprint) return {kind:'unsupported',reason:'changed-form'};
    for (const field of current.fields) {
      const actual = field.type === 'consent' ? await this.field(field.id).isChecked() : await this.field(field.id).inputValue();
      if (actual !== values[field.key]) return {kind:'unsupported',reason:'changed-values'};
    }
    this.beforeSubmit?.(current);
    await this.performSubmit(current);
    const result = await this.read();
    // An unchanged form without a recognized validation error is ambiguous,
    // not permission to request a second OTP or repeat final registration.
    if (result.kind === 'form' && result.fingerprint === fingerprint && !result.error) return {kind:'unknown'};
    return result;
  }

  async performSubmit(step) {
    await Promise.all([this.page.waitForNavigation({waitUntil:'domcontentloaded'}),this.field(step.action.id).click()]);
  }

  async refresh(fingerprint) {
    const current = await this.read();
    if (current.kind !== 'form' || current.fingerprint !== fingerprint || !current.fields.some(f => f.type === 'captcha')) return {kind:'unsupported',reason:'changed-form'};
    const previous = await this.page.locator('#Captcha').getAttribute('src');
    const button = this.page.getByRole('button', {name:'Refresh Captcha',exact:true});
    if (await button.count() !== 1) return {kind:'unsupported',reason:'refresh'};
    await button.click();
    await this.page.waitForFunction(src => document.querySelector('#Captcha')?.getAttribute('src') !== src, previous);
    return this.read();
  }

  async resend() {
    // Only a specifically labelled, currently enabled resend control is eligible.
    const current = await this.read();
    if (current.kind !== 'form' || current.stage !== 'otp') return {kind:'unsupported',reason:'resend'};
    const buttons = (await this.snapshot()).buttons.filter(b => /^(?:resend|re-send)\s+otp$/i.test(b.label));
    if (buttons.length !== 1 || buttons[0].disabled) return {kind:'resend-unavailable'};
    const destination = new URL(buttons[0].actionUrl);
    if (destination.origin !== OTR_ORIGIN || destination.pathname !== new URL(this.page.url()).pathname || !['','_self'].includes(buttons[0].target)) return {kind:'unsupported',reason:'external-verification'};
    await Promise.all([this.page.waitForNavigation({waitUntil:'domcontentloaded'}),this.field(buttons[0].id).click()]);
    return this.read();
  }

  async close() {
    this.closed = true;
    const browser = this.browser;
    this.browser = this.context = this.page = this.step = undefined;
    await browser?.close();
  }
}
