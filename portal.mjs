import {chromium} from 'playwright';
import {parsePortalResult} from './core.mjs';

const URL = 'https://scholarship.up.gov.in/ForgetPwd.aspx';

// Only these categories may leave the adapter. Playwright errors can contain
// filled values, so never log or send their original message/stack.
export function portalFailure(error, stage = 'form') {
  const network = /net::(ERR_[A-Z_]+)/.exec(error?.message ?? '')?.[1];
  const code = network || (error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED');
  const safe = new Error(`Recovery form unavailable (${stage}/${code}).`);
  safe.stage = stage;
  safe.code = code;
  return safe;
}

export class ScholarshipPortal {
  constructor({headless = true, channel = process.platform === 'win32' ? 'msedge' : 'chromium', launch = options => chromium.launch(options), onDiagnostic = () => {}, responseTimeoutMs = 20_000} = {}) {
    this.headless = headless;
    this.channel = channel;
    this.launch = launch;
    this.onDiagnostic = onDiagnostic;
    this.responseTimeoutMs = responseTimeoutMs;
  }

  async open(details) {
    this.closed = false;
    this.stage = 'browser';
    try { return await this.openForm(details); }
    catch (error) { throw portalFailure(error, this.stage); }
  }

  async openForm(details) {
    this.details = {...details};
    this.submissionAttempted = false;
    if (!this.browser) {
      const browser = await this.launch({headless:this.headless,
        // Default Chromium uses the bundled headless shell, saving RAM on Free.
        channel:this.channel === 'chromium' ? undefined : this.channel, timeout:30_000});
      if (this.closed) { await browser.close(); throw new Error('Cancelled'); }
      this.browser = browser;
      this.context = await this.browser.newContext({viewport:{width:1100, height:900}});
      await this.context.route('**/*',async route => {
        if (new globalThis.URL(route.request().url()).origin === 'https://scholarship.up.gov.in') return route.fallback();
        return route.abort();
      });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(10_000);
      this.page.setDefaultNavigationTimeout(30_000);
    }
    this.stage = 'website';
    // The form can be usable before all scripts finish loading. Do not make
    // every recovery wait for unrelated resources to reach DOMContentLoaded.
    const response = await this.page.goto(URL, {waitUntil:'commit'});
    if (response && response.status() >= 400) throw new Error('Website HTTP error');
    if (!this.page.url().startsWith('https://scholarship.up.gov.in/')) throw new Error('Unexpected destination.');
    const field = id => this.page.locator(`#ContentPlaceHolder1_${id}`);
    this.stage = 'application-type';
    const type = field(details.applicationType === 'Renewal' ? 'rbtnFR_0' : 'rbtnFR_1');
    if (!await type.isChecked()) {
      // The radio schedules an ASP.NET postback. Wait before filling fields;
      // otherwise that response can overwrite details we just entered.
      await Promise.all([this.page.waitForNavigation({waitUntil:'domcontentloaded'}), type.check()]);
    }
    this.stage = 'details';
    const identityField = details.applicationType === 'Fresh' ? 'txtmobilenumber' : 'txtdob';
    const identityValue = details.applicationType === 'Fresh' ? details.mobile : details.dob;
    await field('txtLogin').fill(details.registration);
    await field(identityField).fill(identityValue);
    this.stage = 'board';
    await field('ddl_board').selectOption({label:details.board});
    this.stage = 'year';
    await field('ddl_highschpassyear').selectOption({label:details.year});
    await field('txt_roll').fill(details.roll);
    this.stage = 'verify-fields';
    for (const [id, expected] of [['txtLogin', details.registration], [identityField, identityValue], ['txt_roll', details.roll]]) {
      if (await field(id).inputValue() !== expected) throw new Error('Form value did not persist.');
    }
    if (await field('ddl_highschpassyear').inputValue() !== details.year) throw new Error('Year did not persist.');
    this.stage = 'captcha';
    await this.page.waitForFunction(() => {
      const image = document.querySelector('#Captcha');
      return image?.complete && image.naturalWidth > 0;
    });
    return this.page.locator('#Captcha').screenshot({type:'png'});
  }

  async submit(captcha) {
    if (this.submissionAttempted) return {kind:'unknown'};
    const beforeUrl = this.page.url();
    if (new globalThis.URL(beforeUrl).origin !== 'https://scholarship.up.gov.in' || new globalThis.URL(beforeUrl).pathname.toLowerCase() !== '/forgetpwd.aspx') return {kind:'unknown'};
    const action = await this.page.locator('#ContentPlaceHolder1_btnLogin').evaluate(e=>({url:e.hasAttribute('formaction')?e.formAction:e.form.action,target:e.formTarget || e.form.target || ''}));
    if (new globalThis.URL(action.url).origin !== 'https://scholarship.up.gov.in' || new globalThis.URL(action.url).pathname.toLowerCase() !== '/forgetpwd.aspx' || !['','_self'].includes(action.target)) return {kind:'unknown'};
    await this.page.locator('#ContentPlaceHolder1_txtCaptcha').fill(captcha);
    const beforeText = await this.page.locator('body').innerText();
    let dialogText = '', httpStatus, clickFailed = false;
    let dialogArrived;
    const dialogSignal = new Promise(resolve=>{dialogArrived=resolve;});
    const onDialog = async dialog => {dialogText=dialog.message(); await dialog.dismiss().catch(()=>{}); dialogArrived(true);};
    const onResponse = response => {
      if (response.request().isNavigationRequest() && new globalThis.URL(response.url()).origin === 'https://scholarship.up.gov.in') httpStatus=response.status();
    };
    this.page.on('dialog',onDialog);
    this.page.on('response',onResponse);
    // Observe both document navigations and in-place responses. A navigation
    // timeout must not discard a result already rendered on the official page.
    const navigation = this.page.waitForNavigation({waitUntil:'domcontentloaded',timeout:this.responseTimeoutMs}).catch(()=>null);
    const changed = this.page.waitForFunction(({url,text})=>location.href!==url || document.body?.innerText!==text,
      {url:beforeUrl,text:beforeText},{timeout:this.responseTimeoutMs}).catch(()=>null);
    this.submissionAttempted = true;
    try {
      try { await this.page.locator('#ContentPlaceHolder1_btnLogin').click({noWaitAfter:true}); }
      catch {clickFailed=true;}
      await Promise.race([navigation,changed,dialogSignal]);
      await this.page.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{});
      const text = await this.page.locator('body').innerText();
      let result = parsePortalResult(this.page.url(),text,this.details.registration);
      if (result.kind === 'unknown' && !result.reason && dialogText && new globalThis.URL(this.page.url()).pathname.toLowerCase()==='/forgetpwd.aspx') result=parsePortalResult(this.page.url(),dialogText,this.details.registration);
      this.report({event:'recovery-response',kind:result.kind,reason:result.reason || undefined,
        page:new globalThis.URL(this.page.url()).pathname.toLowerCase()==='/forgetpasswordprint.aspx'?'print':new globalThis.URL(this.page.url()).pathname.toLowerCase()==='/forgetpwd.aspx'?'form':'other',
        httpStatus,clickFailed});
      return await this.captureResult(result);
    } catch {
      this.report({event:'recovery-response',kind:'unreadable',httpStatus,clickFailed});
      return {kind:'unknown'};
    } finally {
      this.page?.off('dialog',onDialog);
      this.page?.off('response',onResponse);
      dialogText='';
    }
  }

  report(event) {try {this.onDiagnostic(event);} catch { /* Never interrupt recovery. */ }}

  async captureResult(result) {
    // A screenshot failure must not discard a verified recovered password or trigger a repeat.
    if (result.kind === 'success') {
      try { result.slip = await this.page.screenshot({fullPage:true,type:'png'}); }
      catch { /* The verified text result is still usable. */ }
    }
    if (result.kind === 'unknown' && result.reason !== 'registration-mismatch' && new globalThis.URL(this.page.url()).origin === 'https://scholarship.up.gov.in') {
      try {
        const imageUrl=this.page.url();
        let slip=await this.page.screenshot({fullPage:true,type:'png'});
        // Rendering/screenshotting can finish after a late redirect. Re-read
        // before labelling the captured page as unconfirmed or closing it.
        const text=await this.page.locator('body').innerText();
        const latestUrl=this.page.url();
        if (new globalThis.URL(latestUrl).origin !== 'https://scholarship.up.gov.in') return {kind:'unknown'};
        const latest=parsePortalResult(latestUrl,text,this.details.registration);
        if (latest.reason === 'registration-mismatch') return latest;
        if (latest.kind !== 'unknown') {
          this.report({event:'recovery-response-rechecked',kind:latest.kind});
          if (latest.kind === 'success') {
            if (imageUrl !== latestUrl) {
              try {slip=await this.page.screenshot({fullPage:true,type:'png'});} catch {slip=undefined;}
            }
            latest.slip=slip;
          }
          return latest;
        }
        return {kind:'response-image',slip};
      }
      catch { /* A missing screenshot must never trigger resubmission. */ }
    }
    return result;
  }

  async close() {
    this.closed = true;
    const browser = this.browser;
    this.browser = undefined;
    this.page = undefined;
    this.context = undefined;
    this.details = undefined;
    await browser?.close();
  }
}
