// Synthetic, offline check only. Does not log in, contact Telegram or read .env.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {validatePolyPdf} from '../poly-pdf.mjs';

let browser;
try {
  const channel=process.env.BROWSER_CHANNEL || (process.platform==='win32'?'msedge':'chromium');
  browser=await chromium.launch({headless:true,channel:channel==='chromium'?undefined:channel,timeout:30000});
  const first=await browser.newContext(),second=await browser.newContext();
  for(const context of [first,second]) {
    await context.setOffline(true);
    await context.route('**/*',route=>route.abort());
  }
  await first.addCookies([{name:'fixture',value:'synthetic',url:'https://example.invalid'}]);
  assert.equal((await second.cookies()).length,0,'Contexts must remain isolated');
  const page=await first.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><h1>Synthetic migration check</h1><p>Registration number: 000012345678</p><p>No applicant data or portal request is used.</p>');
  assert.ok((await page.screenshot()).length>100);
  const pdf=await page.pdf({format:'A4',printBackground:true});
  const result=await validatePolyPdf(pdf,'000012345678');
  console.log(JSON.stringify({result:'passed',platform:process.platform,architecture:process.arch,node:process.version,browser:browser.version(),isolatedContexts:true,screenshot:true,pdfPages:result.pages}));
} catch {
  console.error('VPS browser smoke check failed. Verify the pinned browser installation, OS dependencies, fonts, permissions and available memory. No live portal action was attempted.');
  process.exitCode=1;
} finally {
  await browser?.close();
}
