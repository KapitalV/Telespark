import {ScholarshipPortal} from './portal.mjs';
import {lookup} from 'node:dns/promises';

export async function probeConnection() {
  const started = Date.now();
  let stage = 'dns';
  try {
    const addresses = await lookup('scholarship.up.gov.in',{all:true});
    console.log(JSON.stringify({event:'portal-dns',addresses}));
    stage = 'https';
    const response = await fetch('https://scholarship.up.gov.in/ForgetPwd.aspx',{signal:AbortSignal.timeout(15_000)});
    const status = response.status;
    stage = 'html';
    const html = await response.text();
    return {event:'portal-connection',ok:response.ok,status,formPresent:html.includes('ContentPlaceHolder1_txtLogin'),elapsedMs:Date.now()-started};
  } catch (error) {
    const candidate = error.cause?.code || error.name;
    const code = /^[A-Za-z0-9_]+$/.test(candidate ?? '') ? candidate : 'FAILED';
    return {event:'portal-connection',ok:false,stage,code,elapsedMs:Date.now()-started};
  }
}

// Synthetic values only. Exercises all six fields and image rendering, but
// never calls submit, fills a CAPTCHA, or resets an account password.
export async function probePortal(options = {}) {
  const portal = new ScholarshipPortal(options);
  let timer;
  try {
    const image = await Promise.race([
      portal.open({applicationType:options.applicationType || 'Renewal',registration:'000000000000000',dob:'01/01/2000',mobile:'0000000000',board:'UP BOARD',year:'2021',roll:'000000000'}),
      new Promise((_, reject) => {timer = setTimeout(() => {
        const error = new Error('Probe deadline'); error.code = 'TIMEOUT'; error.stage = portal.stage; reject(error);
      }, 75_000);}),
    ]);
    return {event:'portal-probe',ok:true,imageBytes:image.length};
  } catch (error) {
    return {event:'portal-probe',ok:false,stage:portal.stage,code:error.code || 'FAILED'};
  } finally {
    clearTimeout(timer);
    void portal.close().catch(() => {});
  }
}
