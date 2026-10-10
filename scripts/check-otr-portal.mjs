import {OtrPortal} from '../otr-portal.mjs';
import {OtrRecoveryPortal} from '../otr-recovery.mjs';

// Public pages only. No Telegram token, applicant data, CAPTCHA solving,
// consent acceptance, OTP request, or registration submission.
for (const mode of ['recover','register']) {
  const portal = new (mode === 'recover' ? OtrRecoveryPortal : OtrPortal)({mode, channel:process.env.BROWSER_CHANNEL || undefined});
  try {
    const step = await portal.open();
    console.log(JSON.stringify({mode,kind:step.kind,stage:step.stage,fields:step.fields?.map(f => ({id:f.id,type:f.type,label:f.label})),action:step.action?.label,imageBytes:step.image?.length ?? 0,submitted:false}));
    if (step.kind !== 'form') {
      console.log(JSON.stringify({mode,structure:await portal.snapshot()}));
      process.exitCode = 1;
    }
    if (mode === 'register') {
      // This is the observed public form URL, read without accepting or sending anything.
      await portal.page.goto('https://scholarship.up.gov.in/RegWithOTR.aspx',{waitUntil:'domcontentloaded'});
      const form = await portal.read();
      console.log(JSON.stringify({mode,kind:form.kind,stage:form.stage,registrationFormRequiresConsent:form.stage === 'consent',fields:form.fields?.map(f => ({id:f.id,type:f.type})),action:form.action?.label,submitted:false}));
      if (form.kind !== 'form') {
        console.log(JSON.stringify({mode,structure:await portal.snapshot()}));
        process.exitCode = 1;
      }
    }
  } catch (error) {
    const code = /^HTTP_[45]\d{2}$/.test(error?.code ?? '') ? error.code : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED';
    console.log(JSON.stringify({mode,ok:false,reason:'public-page-unavailable',code,submitted:false}));
    process.exitCode = 1;
  } finally { await portal.close(); }
}
