import {chromium} from 'playwright';
import {parsePortalResult} from './core.mjs';

const URL = 'https://scholarship.up.gov.in/ForgetPwd.aspx';

export class ScholarshipPortal {
  constructor({headless = true, channel = process.platform === 'win32' ? 'msedge' : 'chromium'} = {}) {
    this.headless = headless;
    this.channel = channel;
  }

  async open(details) {
    this.details = {...details};
    if (!this.browser) {
      this.browser = await chromium.launch({headless:this.headless,channel:this.channel});
      this.context = await this.browser.newContext({viewport:{width:1100, height:900}});
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(20_000);
      this.page.setDefaultNavigationTimeout(45_000);
    }
    await this.page.goto(URL, {waitUntil:'domcontentloaded'});
    if (!this.page.url().startsWith('https://scholarship.up.gov.in/')) throw new Error('Unexpected destination.');
    const field = id => this.page.locator(`#ContentPlaceHolder1_${id}`);
    await field(details.applicationType === 'Renewal' ? 'rbtnFR_0' : 'rbtnFR_1').check();
    // Radio controls may cause an ASP.NET postback. Locators re-resolve after it.
    await field('txtLogin').fill(details.registration);
    await field('txtdob').fill(details.dob);
    await field('ddl_board').selectOption({label:details.board});
    await field('ddl_highschpassyear').selectOption({label:details.year});
    await field('txt_roll').fill(details.roll);
    for (const [id, expected] of [['txtLogin', details.registration], ['txtdob', details.dob], ['txt_roll', details.roll]]) {
      if (await field(id).inputValue() !== expected) throw new Error('Form value did not persist.');
    }
    if (await field('ddl_highschpassyear').inputValue() !== details.year) throw new Error('Year did not persist.');
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
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
    this.context = undefined;
  }
}
