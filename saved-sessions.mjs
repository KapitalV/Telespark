import {FINAL_FIELDS,PASSWORD_FIELDS,REGISTRATION_SAVED_FIELDS,SAVED_POLY_FIELDS,projectFields,SAVE_STATUS} from './saved-schema.mjs';
import {questionAt,normalizeAnswer} from './core.mjs';
import {normalizePoly} from './poly-schema.mjs';
import {savedIdPattern} from './saved-store.mjs';

const dateFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',dateStyle:'short',timeStyle:'short',hour12:false});
const commandFor=module=>module==='password'?'/psave':['poly','final'].includes(module)?'/save':'/dsave';
export class SavedSessions {
  constructor({store,telegram,access,activity,clock=()=>Date.now(),defaultProfilePassword=''}) {Object.assign(this,{store,telegram,access,activity,clock,defaultProfilePassword});this.userProfiles=new Map();this.selectedProfiles=new Map();}
  bind(router) {this.router=router;}
  bot(module) {return module==='password'?this.router.recovery:module==='poly'?this.router.poly:module==='final'?this.router.final:this.router.registration;}
  async log(userId,event,module) {await this.activity?.record({event,userId,module});}
  async sendLines(id,lines) {
    let chunk='';
    for(const raw of lines) for(let offset=0;offset<Math.max(raw.length,1);offset+=3000) {
      if(!this.access.canUse(id)) return;
      const line=raw.slice(offset,offset+3000);
      if(chunk.length+line.length+1>3500) {await this.telegram.send(id,chunk);chunk='';}
      chunk+=(chunk?'\n':'')+line;
    }
    if(chunk && this.access.canUse(id)) await this.telegram.send(id,chunk);
  }
  fields(module,state) {
    const fields={};
    if(module==='password') {
      for(const key of Object.keys(PASSWORD_FIELDS)) if(typeof state.details?.[key]==='string') fields[key]={value:state.details[key]};
    } else {
      for(const [key,answer] of state.portal?.answers || []) if(Object.hasOwn(REGISTRATION_SAVED_FIELDS,key)) {
        fields[key]={value:answer.value};if(answer.type==='choice' || answer.options) fields[key].label=answer.options?.find(o=>o.value===answer.value)?.label ?? answer.display;
      }
      if(state.portal?.identity?.[0]) fields.studentName={value:state.portal.identity[0]};
      if(state.portal?.identity?.[1]) fields.linkedMobile={value:state.portal.identity[1]};
    }
    return projectFields(module,fields);
  }
  ready(module,state) {
    if(module==='registration') return state.phase==='confirm';
    try {for(let i=0;i<6;i++) {const [key]=questionAt(i,state.details);normalizeAnswer(key,state.details[key] ?? '');}return true;} catch {return false;}
  }
  async prompt(id,module) {
    return this.telegram.send(id,`Details are saved automatically before submission. ${commandFor(module)} optionally saves a draft; /save lists your records. OTPs, CAPTCHA answers and cookies are excluded.`);
  }
  async startUserProfile(id) {
    if(!this.access.canUse(id)) return;
    // A saved-user entry replaces any unfinished portal conversation.  This
    // closes its isolated browser and prevents a later reply from being
    // applied to the wrong candidate.
    await this.router?.clear(id);
    this.userProfiles.set(id,{phase:'otr',fields:{},updated:this.clock()});
    return this.telegram.send(id,'Save an encrypted user profile for the bot menus. Enter the OTR number. The short command is based on its last two digits; passwords stay encrypted and are hidden when viewed. Send /cancel to stop.');
  }
  hasUserProfile(id) {return this.userProfiles.has(id);}
  async clearUserProfile(id) {const profile=this.userProfiles.get(id);if(profile) {profile.fields={};profile.password=undefined;this.userProfiles.delete(id);}}
  clearSelectedProfile(id) {this.selectedProfiles.delete(id);}
  async selectedFields(id) {
    const selected=this.selectedProfiles.get(id);
    if(!selected) return {};
    if(!this.access.canUse(id)||this.clock()-selected.updated>20*60_000) {this.clearSelectedProfile(id);return {};}
    try {
      const record=await this.store.get(selected.id,id);
      selected.updated=this.clock();
      return structuredClone(record.fields);
    } catch {
      this.clearSelectedProfile(id);
      await this.telegram.send(id,'The selected profile is unavailable. Enter details normally or select another saved-user command.');
      return {};
    }
  }
  async expire() {
    for(const [id,profile] of this.userProfiles) if(this.clock()-profile.updated>20*60_000) await this.clearUserProfile(id);
    for(const [id,profile] of this.selectedProfiles) if(!this.access.canUse(id)||this.clock()-profile.updated>20*60_000) this.clearSelectedProfile(id);
  }
  async userProfileReply(message) {
    const id=message.chat.id,profile=this.userProfiles.get(id),text=message.text.trim(),command=text.split(/\s+/)[0].toLowerCase();
    if(!profile||!this.access.canUse(id)) {await this.clearUserProfile(id);return;}
    profile.updated=this.clock();
    if(command==='/cancel') {await this.clearUserProfile(id);return this.telegram.send(id,'Saved-user entry cancelled. No profile was changed.');}
    if(command==='/menu'||command==='/start') {await this.clearUserProfile(id);return this.router.menu(id);}
    if(command==='/saveuser') return this.startUserProfile(id);
    if(text.startsWith('/')) return this.telegram.send(id,'Finish the saved-user prompt or send /cancel.');
    if(profile.phase==='otr') {
      try {profile.fields.otr=normalizePoly({key:'otr',type:'text'},text);} catch {return this.telegram.send(id,'Enter a valid OTR in the format UP26-0000000001.');}
      profile.phase='registration';return this.telegram.send(id,'Enter the registration number exactly as shown on the registration slip.');
    }
    if(profile.phase==='registration') {
      try {profile.fields.registration=normalizePoly({key:'registration',type:'digits'},text);} catch {return this.telegram.send(id,'Enter the registration number using digits only; leading zeros are preserved.');}
      profile.phase='password-choice';
      const rows=this.defaultProfilePassword?[['USE DEFAULT PASSWORD'],['OTHER PASSWORD'],['/cancel']]:[['OTHER PASSWORD'],['/cancel']];
      return this.telegram.send(id,'Choose the saved portal password. The default is stored from local environment configuration; choose Other to enter a different password.',{reply_markup:{keyboard:rows,resize_keyboard:true,one_time_keyboard:true}});
    }
    if(profile.phase==='password-choice') {
      const choice=text.toUpperCase();
      if(choice==='USE DEFAULT PASSWORD'||choice==='USE DEFAULT') {
        if(!this.defaultProfilePassword) return this.telegram.send(id,'No default password is configured locally. Choose Other password and enter it.');
        profile.password=this.defaultProfilePassword;return this.saveUserProfile(id,profile);
      }
      if(choice==='OTHER PASSWORD'||choice==='OTHER') {profile.phase='password';return this.telegram.send(id,'Enter the portal password to save encrypted.');}
      return this.telegram.send(id,'Choose USE DEFAULT PASSWORD or OTHER PASSWORD.');
    }
    if(profile.phase==='password') {
      if(!text||text.length>200||/[\u0000-\u001f]/.test(text)) return this.telegram.send(id,'Enter a password of 1–200 characters.');
      profile.password=text;return this.saveUserProfile(id,profile);
    }
  }
  async saveUserProfile(id,profile) {
    const otr=profile.fields.otr,registration=profile.fields.registration,password=profile.password;
    const suffix=otr.replace(/\D/g,'').slice(-2);
    const fields={otr:{value:otr},registration:{value:registration},profileSuffix:{value:suffix},password:{value:password}};
    try {
      const existing=await this.store.findByField({userId:id,module:'poly',key:'profileSuffix',value:suffix});
      if(existing&&existing.fields.otr?.value!==otr) {
        await this.clearUserProfile(id);return this.telegram.send(id,`Cannot save: /saveuser${suffix} already belongs to a different OTR. The existing profile was left unchanged.`);
      }
      if(existing&&!['draft','ready'].includes(existing.status)) {
        await this.clearUserProfile(id);return this.telegram.send(id,`/saveuser${suffix} is already tied to a protected session and was not overwritten. Use the existing profile command to load it.`);
      }
      const record=await this.store.save({id:existing?.id,userId:id,module:'poly',fields,ready:false});
      await this.log(id,'session_saved','poly');await this.clearUserProfile(id);
      return this.telegram.send(id,`Encrypted user profile saved as ${record.id}. Use /saveuser${suffix} from the menu or a selected module to fill available details automatically. Password is hidden in saved-session views.`);
    } catch {
      await this.log(id,'save_failed','poly');await this.clearUserProfile(id);
      return this.telegram.send(id,'Could not save the encrypted user profile. No portal request was made; check local saved-session storage and try again.');
    }
  }
  async useUserProfile(id,suffix) {
    if(!this.access.canUse(id)) return;
    try {
      const record=await this.store.findByField({userId:id,module:'poly',key:'profileSuffix',value:suffix});
      if(!record||!record.fields.registration?.value||!record.fields.otr?.value||!record.fields.password?.value) return this.telegram.send(id,`No complete saved profile exists for /saveuser${suffix}. Send /saveuser to create it.`);
      const module=this.router.sessions.get(id)?.module;
      if(module==='final-batch') return this.telegram.send(id,'A saved-user shortcut cannot replace an Excel batch. Use /cancel first, then select an individual service.');
      const poly=this.router.poly?.sessions.get(id);
      const final=this.router.final?.sessions.get(id);
      const context=module==='poly'?{operation:poly?.operation,applicationType:poly?.applicationType,categoryRoute:poly?.categoryRoute}
        :module==='final'?{applicationType:final?.applicationType}:{};
      await this.router.clear(id);
      this.selectedProfiles.set(id,{id:record.id,suffix,updated:this.clock()});
      await this.log(id,'session_reused','poly');
      await this.telegram.send(id,`Selected /saveuser${suffix}. Available details fill automatically; the password stays hidden. Missing choices and fresh CAPTCHA/OTP answers are still required.`);
      if(['poly','final','password','registration','otr'].includes(module)) return await this.router.startWithProfile(id,module,record.fields,context);
      return await this.router.menu(id,module==='otr-menu');
    } catch {return this.telegram.send(id,'Could not load this saved profile. Check the two-digit suffix and that the profile belongs to this Telegram account.');}
  }
  async dashboard(id,args=[]) {
    if(this.router.sessions.get(id)?.module==='poly') await this.router.poly?.checkpoint(id,{ready:this.router.poly.sessions.get(id)?.phase==='confirm'});
    const state=this.router.sessions.get(id),active=state && this.bot(state.module)?.sessions.get(id);
    if(active && ['password','registration'].includes(state.module)) {active.saveMenuOpened=true;active.updated=this.clock();}
    let userId=String(id),page=1;
    if(args[0]==='user' && this.access.isAdmin(id) && [2,3].includes(args.length)) {userId=args[1];page=Number(args[2] || 1);}
    else if(args.length<=1) {page=Number(args[0] || 1);if(this.access.isAdmin(id)) userId=undefined;}
    else return this.telegram.send(id,'Use /save [page]. Admin: /save user ID [page].');
    const list=await this.store.list({userId,page});
    await this.sendLines(id,[`Saved sessions — ${userId?'your records':'all users, status only'} — page ${page}`,
      ...list.records.map(r=>`${r.id}\nUser ${r.userId} | ${r.module}${r.stage?' / '+r.stage:''} | ${SAVE_STATUS[r.status]} | ${dateFormat.format(new Date(r.updatedAt))} IST | Attempts: ${r.attempts}`),
      ...(list.total?[]:['No saved sessions yet.']),`Total: ${list.total}. /save ${page+1} shows the next page.`,
      'Choose /saveuser to save a login profile. /saveuserNN selects it across the menus using the last two OTR digits. Choose /dsave for registration or /psave for password recovery. OTNew-Poly: /save SESSION_ID for details, /result SESSION_ID for the PDF. Retrieval makes no website request.']);
    await this.telegram.send(id,'Save current details or browse your records:',{reply_markup:{keyboard:[['/saveuser'],['/dsave','/psave']],resize_keyboard:true,one_time_keyboard:true}});
  }
  async handle(message,command) {
    const id=message.chat.id,args=message.text.trim().split(/\s+/).slice(1);
    try {
      if(command==='/save') {
        if(args.length===1&&savedIdPattern.test(args[0])) {
          const record=await this.store.get(args[0],id);return await this.show(id,args[0],record.module);
        }
        return await this.dashboard(id,args);
      }
      if(command==='/reuse') {
        if(args.length!==1) return this.telegram.send(id,'Use /reuse SESSION_ID to start a fresh session from your saved fields.');
        return await this.reuse(id,args[0]);
      }
      const module=command==='/psave'?'password':'registration';
      if(args[0]==='list' && args.length<=2) return await this.list(id,module,Number(args[1] || 1));
      if(args.length===1) return await this.show(id,args[0],module);
      if(args.length) return this.telegram.send(id,`Use ${command}, ${command} SESSION_ID, or ${command} list [page].`);
      const state=this.bot(module).sessions.get(id);
      if(state?.savedOutcomePending) {
        await this.persistOutcome(id,state,module,state.savedOutcomePending);
        if(state.savedOutcomePending) return;
      }
      if(!state || ['done','unknown','blocked','unsupported','load-failed'].includes(state.phase)) {
        return state?.savedId?await this.show(id,state.savedId,module):await this.list(id,module,1);
      }
      if(module==='registration' && !state.portal) return this.telegram.send(id,'No registration fields are loaded yet. Return to the registration flow first.');
      const fields=this.fields(module,state),ready=this.ready(module,state);
      const record=await this.store.save({id:state.savedId,userId:id,module,fields,ready});
      state.savedId=record.id;state.updated=this.clock();
      await this.log(id,'session_saved',module);
      await this.telegram.send(id,`${SAVE_STATUS[record.status]} saved: ${record.id}\nRetrieve later with ${command} ${record.id}. The encrypted copy survives /cancel, timeout and restart.`);
      if(this.bot(module).sessions.get(id)!==state || !this.access.canUse(id)) return;
      if(ready && module==='password' && ['save-required','prepare-failed'].includes(state.phase)) return this.bot(module).prepare(id,state);
      if(ready && module==='registration') return this.bot(module).confirmRegistration(id,state);
      if(!ready) return this.telegram.send(id,'Draft saved. Continue the current questions; save again when all required fields are complete.');
    } catch {
      await this.log(id,'save_failed',command==='/psave'?'password':command==='/dsave'?'registration':undefined);
      return this.telegram.send(id,'Could not access the saved session. Check the session ID and that it belongs to you, or retry saving after checking local storage. No new final submission was made by this command.');
    }
  }
  async list(id,module,page) {
    const list=await this.store.list({userId:id,module,page});
    await this.sendLines(id,[`${module==='password'?'Password recovery':'Registration'} records — page ${page}`,
      ...list.records.map(r=>`${commandFor(module)} ${r.id}\n${SAVE_STATUS[r.status]} | ${dateFormat.format(new Date(r.updatedAt))} IST`),
      ...(list.total?[]:['No saved records. Details are saved automatically before submission; you can also save a draft.']),
      `Total: ${list.total}. ${commandFor(module)} list ${page+1} shows the next page.`]);
  }
  async show(id,sessionId,module) {
    const record=await this.store.get(sessionId,id);if(record.module!==module) throw new Error('Wrong module.');
    const labels=module==='password'?PASSWORD_FIELDS:module==='poly'?SAVED_POLY_FIELDS:module==='final'?FINAL_FIELDS:REGISTRATION_SAVED_FIELDS;
    const lines=[`${record.id} — ${SAVE_STATUS[record.status]}`,`Updated: ${dateFormat.format(new Date(record.updatedAt))} IST`,
      ...Object.entries(record.fields).map(([key,field])=>`${labels[key]}: ${key==='password'?'(saved encrypted; hidden)':(field.label ?? field.value) || '(none)'}`)];
    if(record.result?.password) lines.push(`Latest recovered password: ${record.result.password}`);
    if(['attempted','uncertain'].includes(record.status)) lines.push('The website outcome is not confirmed. Check the official portal before considering another submission.');
    lines.push(`Viewing this record does not contact the website. /reuse ${record.id} loads its fields into a fresh session; fresh verification is required; saving is automatic.`);
    await this.sendLines(id,lines);
    if(!this.access.canUse(id)) return;
    if(record.result?.kind==='pdf') await this.bot(module).storedResult(id,sessionId);
    if(record.result?.image) await this.telegram.document(id,Buffer.from(record.result.image,'base64'),`${record.id}.png`,'Saved official website response. Use the saved status and image to assess the outcome.');
    await this.telegram.send(id,'Reuse saved details only when you intend to start a new request:',{reply_markup:{keyboard:[[`/reuse ${record.id}`],['/save']],resize_keyboard:true,one_time_keyboard:true}});
    await this.log(id,'session_viewed',module);
  }
  async beforeSubmit(id,state,module) {
    try {
      const previousId=state.savedId;
      const record=await this.store.save({id:state.savedId,userId:id,module,fields:this.fields(module,state),ready:true});
      state.savedId=record.id;
      await this.log(id,'session_saved',module);
      if(!previousId) await this.telegram.send(id,`Saved automatically: ${record.id}. Retrieve later with ${commandFor(module)} ${record.id}.`);
      await this.store.begin(state.savedId,id,this.fields(module,state));state.savedAttemptPending=true;return true;
    } catch {
      await this.log(id,'save_failed',module);
      await this.telegram.send(id,'No final request was submitted. Automatic encrypted saving failed or this record has already been attempted. Check storage or the saved status before retrying. An attempted/uncertain record cannot be submitted again automatically.');return false;
    }
  }
  async outcome(id,state,module,result) {
    if(!state.savedAttemptPending) return;
    state.savedAttemptPending=false;
    const status=result.kind==='success'?'confirmed':result.kind==='captcha'?'ready':result.kind==='correction'?'draft':'uncertain';
    const savedResult=['success','response-image','result-image'].includes(result.kind)?{
      kind:result.kind,registration:result.registration,password:result.password,
      image:(result.slip || result.image)?.toString('base64'),
    }:['ready','draft'].includes(status)?undefined:{kind:'unknown'};
    await this.persistOutcome(id,state,module,{status,result:savedResult});
  }
  async persistOutcome(id,state,module,outcome) {
    state.savedOutcomePending=outcome;
    try {await this.store.outcome(state.savedId,id,outcome);state.savedOutcomePending=undefined;await this.log(id,'session_saved',module);}
    catch {
      await this.log(id,'save_failed',module);
      await this.telegram.send(id,`The website attempt finished, but its saved status/result could not be updated. I will not repeat it. Use ${commandFor(module)} to retry saving the outcome while this session is open; /result shows any result still in memory.`);
    }
  }
  async reuse(id,sessionId) {
    const record=await this.store.get(sessionId,id);
    if(record.module==='final') {
      if(!this.router.enableFinal) return this.telegram.send(id,'Form lock & Final Print is disabled.');
      await this.router.clear(id);this.router.sessions.set(id,{module:'final',updated:this.clock()});
      return this.router.final.start(id);
    }
    if(record.module==='poly'&&!this.router.enablePoly) return this.telegram.send(id,'OTNew-Poly is disabled pending live validation. Saved details and PDFs remain available.');
    if(record.module==='registration' && !this.router.enableOtr) return this.telegram.send(id,'Registration is disabled in this bot build.');
    await this.router.clear(id);
    if(!this.access.canUse(id)) return;
    this.router.sessions.set(id,{module:record.module,updated:this.clock()});
    await this.telegram.send(id,`Reusing fields from ${record.id} (${SAVE_STATUS[record.status]}). This creates a new session. Previously submitted or uncertain records are never replayed automatically. Review the live details and complete fresh verification before submission. Saving is automatic.`);
    await this.log(id,'session_reused',record.module);
    if(record.module==='password') return this.router.recovery.reuse(id,record.fields);
    if(record.module==='poly') return this.router.poly.start(id,record.fields);
    return this.router.registration.start(id,record.fields);
  }
}
