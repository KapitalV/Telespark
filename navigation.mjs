import {QUESTIONS,questionAt} from './core.mjs';
import {BOARD_KEYBOARD} from './board-options.mjs';
import {POLY_SECTIONS} from './poly-schema.mjs';

const keyboard=rows=>({reply_markup:{keyboard:rows,resize_keyboard:true,one_time_keyboard:true}});
const boundary='There is no earlier editable input in this website step. Completed requests cannot be undone. Use /menu to start another workflow.';
const remove=(object,keys)=>{for(const key of keys) delete object[key];};

// Navigation uses the current conversation and live adapter, never snapshots of
// credentials, CAPTCHA answers, OTPs or submitted pages. No path submits a form.
export async function previousInput(router,id) {
  const send=text=>router.telegram.send(id,text);
  const profile=router.saves?.userProfiles?.get(id);
  if(profile) {
    profile.updated=router.clock();profile.password=undefined;
    if(profile.phase==='otr') return router.menu(id);
    if(profile.phase==='registration') {
      profile.fields={};profile.phase='otr';return send('Enter the OTR number.');
    }
    if(profile.phase==='password-choice') {
      delete profile.fields.registration;profile.phase='registration';return send('Enter the registration number exactly as shown on the registration slip.');
    }
    if(profile.phase==='password') {
      profile.phase='password-choice';
      return router.telegram.send(id,'Choose the saved portal password.',keyboard([...(router.saves.defaultProfilePassword?[['USE DEFAULT PASSWORD']]:[]),['OTHER PASSWORD'],['/cancel']]));
    }
    return send(boundary);
  }
  const route=router.sessions.get(id),module=route?.module;
  if(!route) return send('No active input. Send /menu to choose a service.');
  route.updated=router.clock();
  if(module==='menu') return send('You are already at the first step.');
  if(module==='otr-menu') return router.menu(id);
  const bot=({password:router.recovery,otr:router.otr,registration:router.registration,poly:router.poly,final:router.final,'final-batch':router.batch})[module];
  const s=bot?.sessions?.get(id);
  if(!s||s.busy||['loading','preparing','submitting','printing'].includes(s.phase)) return send('No editable input is available right now. Wait for the current operation or use /menu.');
  if(s.pendingOutcome||s.savedAttemptPending||s.savedOutcomePending||s.terminalRecord||s.lockId) return send(boundary);
  s.updated=router.clock();s.busy=true;
  try {
    if(module==='password') {
      s.reuseFields={};
      let target;
      if(s.phase==='questions') target=s.index-1;
      else if(['captcha','prepare-failed','save-required'].includes(s.phase)) target=QUESTIONS.length-1;
      else if(s.phase==='correction') target=QUESTIONS.findIndex((_,i)=>questionAt(i,s.details)[0]===s.correction)-1;
      else return send(boundary);
      if(target<0) return await router.menu(id);
      await s.portal?.close();s.portal=undefined;
      const keep=new Set(Array.from({length:target},(_,i)=>questionAt(i,s.details)[0]));
      s.details=Object.fromEntries(Object.entries(s.details).filter(([key])=>keep.has(key)));
      s.index=target;s.phase='questions';s.correction=undefined;s.captchaMessageId=undefined;s.captchaAt=undefined;
      const [field,prompt]=questionAt(target,s.details);
      return await router.telegram.send(id,prompt,field==='board'?{reply_markup:BOARD_KEYBOARD}:undefined);
    }
    if(module==='poly') {
      if(s.phase==='poly-menu') return await router.menu(id);
      if(s.phase==='type') return await bot.start(id,s.reuse);
      if(s.phase==='category') {
        s.phase='type';s.applicationType=undefined;
        return await bot.say(id,'Choose Fresh or Renewal for this application.',keyboard([['Fresh','Renewal'],['/cancel']]));
      }
      if(s.phase==='login'||s.phase==='login-captcha') {
        s.quickProfile=false;
        await s.portal?.close();s.portal=undefined;
        if(s.phase==='login-captcha') s.index=2;
        else s.index--;
        if(s.index<0) {
          s.phase='category';s.credentials={};s.categoryRoute=undefined;
          return await bot.say(id,'Choose the form-filling route.',keyboard([['1. SC / ST / General'],['2. OBC'],['/cancel']]));
        }
        remove(s.credentials,['registration','otr','password'].slice(s.index));
        s.phase='login';return await bot.loginPrompt(id,s);
      }
      if(['captcha','edit'].includes(s.phase)) return await bot.prompt(id,s,await bot.call(s,'read'));
      if(!['questions','confirm'].includes(s.phase)||!s.step?.stage||s.portal?.closed) return send(boundary);
      const fields=(s.portal.sections||POLY_SECTIONS)[s.step.stage].fields.filter(field=>!field.computed);
      const index=s.phase==='confirm'?fields.length:fields.findIndex(field=>field.key===s.step.field?.key);
      const field=fields[index-1];if(!field) return send(boundary);
      s.manualEditKey=field.key;
      for(const later of fields.slice(index-1)) s.autoDefaultAttempted?.delete(s.step.stage+':'+later.key);
      return await bot.prompt(id,s,await bot.call(s,'edit',field.key));
    }
    if(module==='otr'||module==='registration') {
      if(!['questions','confirm'].includes(s.phase)||!s.step?.fields) return send(boundary);
      if(s.phase==='confirm'||s.index>0) {
        const index=s.phase==='confirm'?s.step.fields.length-1:s.index-1;
        remove(s.values,s.step.fields.slice(index).map(field=>field.key));
        if(s.step.fields.slice(index).some(field=>field.type==='mobile')) s.savedMobile=undefined;
        s.index=index;s.phase='questions';return await bot.prompt(id,s);
      }
      if(module==='registration') {
        if(s.step.action.kind==='choose') return await router.menu(id,true);
        if(s.step.action.kind==='lookup') return await bot.start(id);
        if(typeof s.portal?.editPrevious==='function') {
          const next=await s.portal.editPrevious(s.step.fingerprint);
          if(!next) return send(boundary);
          s.reuseFields=undefined;s.values={};s.search='';s.optionPage=0;
          return await bot.apply(id,s,next);
        }
      }
      return send(boundary);
    }
    if(module==='final') {
      if(s.phase==='type') return await router.menu(id);
      if(['registration','otr','password-choice','password','captcha'].includes(s.phase)) {await s.portal?.close();s.portal=undefined;}
      if(s.phase==='registration') return await bot.start(id,s.reuse,!!router.batch&&!!router.access?.isAdmin(id));
      if(s.phase==='otr') {
        remove(s.credentials,['registration','otr','password']);s.phase='registration';return await bot.say(id,'Enter the registration number.');
      }
      if(s.phase==='password-choice') {
        remove(s.credentials,['otr','password']);s.phase='otr';return await bot.say(id,'Enter the OTR number.');
      }
      if(s.phase==='password'||s.phase==='captcha') {
        await s.portal?.close();s.portal=undefined;delete s.credentials.password;
        if(s.phase==='captcha'&&s.passwordStep==='password') {s.phase='password';return await bot.say(id,'Enter the existing portal password.');}
        return await bot.passwordPrompt(id,s);
      }
      return send(boundary);
    }
    if(module==='final-batch') {
      if(s.phase==='upload') {await bot.clear(id);route.module='final';return await router.final.start(id,{},true);}
      if(s.phase==='batch-review') {await bot.clear(id);return await bot.start(id);}
      if(s.phase==='password') return await bot.choosePassword(id,s,s.perRow);
      if(s.phase==='password-choice'&&!s.perRow) {
        s.password=undefined;s.rowPassword=undefined;s.phase='batch-review';
        return await bot.say(id,'Workbook retained. Send YES to process its valid rows in order.',keyboard([['YES'],['/cancel']]));
      }
      if(s.phase==='captcha') {
        await s.portal?.close();s.portal=undefined;s.perRow=true;
        if(s.passwordStep==='password') {s.phase='password';return await bot.say(id,'Enter the existing password. It stays in memory only.');}
        return await bot.choosePassword(id,s,true);
      }
      return send(boundary);
    }
    return send(boundary);
  } catch {
    s.phase='blocked';if(s.credentials) delete s.credentials.password;
    s.values={};await s.portal?.close().catch(()=>{});
    return send('The previous input could not be reopened safely. Use /menu for a fresh session. No submission was repeated.');
  } finally {s.busy=false;}
}
