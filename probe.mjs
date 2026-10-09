import {ScholarshipPortal} from './portal.mjs';

// Synthetic values only. Exercises all six fields and image rendering, but
// never calls submit, fills a CAPTCHA, or resets an account password.
export async function probePortal(options = {}) {
  const portal = new ScholarshipPortal(options);
  let timer;
  try {
    const image = await Promise.race([
      portal.open({applicationType:'Renewal',registration:'000000000000000',dob:'01/01/2000',board:'UP BOARD',year:'2021',roll:'000000000'}),
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
