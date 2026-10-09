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
  constructor({headless = true, channel = process.platform === 'win32' ? 'msedge' : 'chromium'} = {}) {
    this.headless = headless;
    this.channel = channel;
  }

  async open(details) {
    this.closed = false;
    this.stage = 'browser';
    try { return await this.openForm(details); }
    catch (error) { throw portalFailure(error, this.stage); }
  }

  async openForm(details) {
    this.details = {...details};
    if (!this.browser) {
      const browser = await chromium.launch({headless:this.headless,
        // Default Chromium uses the bundled headless shell, saving RAM on Free.
        channel:this.channel === 'chromium' ? undefined : this.channel, timeout:30_000});
      if (this.closed) { await browser.close(); throw new Error('Cancelled'); }
      this.browser = browser;
      this.context = await this.browser.newContext({viewport:{width:1100, height:900}});
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(10_000);
      this.page.setDefaultNavigationTimeout(30_000);
    }
    this.stage = 'website';
    const response = await this.page.goto(URL, {waitUntil:'domcontentloaded'});
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
    await field('txtLogin').fill(details.registration);
    await field('txtdob').fill(details.dob);
    this.stage = 'board';
    await field('ddl_board').selectOption({label:details.board});
    this.stage = 'year';
    await field('ddl_highschpassyear').selectOption({label:details.year});
    await field('txt_roll').fill(details.roll);
    this.stage = 'verify-fields';
    for (const [id, expected] of [['txtLogin', details.registration], ['txtdob', details.dob], ['txt_roll', details.roll]]) {
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
    await this.page.locator('#ContentPlaceHolder1_txtCaptcha').fill(captcha);
    // All result paths perform a page navigation, including a repeated error URL.
    await Promise.all([
      this.page.waitForNavigation({waitUntil:'domcontentloaded'}),
      this.page.locator('#ContentPlaceHolder1_btnLogin').click(),
    ]);
    const text = await this.page.locator('body').innerText();
    const result = parsePortalResult(this.page.url(), text, this.details.registration);
    // A screenshot failure must not discard a verified recovered password or trigger a repeat.
    if (result.kind === 'success') {
      try { result.slip = await this.page.screenshot({fullPage:true,type:'png'}); }
      catch { /* The verified text result is still usable. */ }
    }
    return result;
  }

  async close() {
    this.closed = true;
    const browser = this.browser;
    this.browser = undefined;
    this.page = undefined;
    this.context = undefined;
    await browser?.close();
  }
}
