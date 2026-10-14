import {normalizePoly} from './poly-schema.mjs';

const keyboard=rows=>({reply_markup:{keyboard:rows,resize_keyboard:true,one_time_keyboard:true}});
export class FinalBot {
  constructor({telegram,portalFactory,store,canUse,activity,defaultPassword='',clock=()=>Date.now(),timeoutMs=75_000}) {
    Object.assign(this,{telegram,portalFactory,store,canUse,activity,defaultPassword,clock,timeoutMs});this.sessions=new Map();
  }
  async clear(id) {const s=this.sessions.get(id);this.sessions.delete(id);if(s){s.credentials={};s.pdf=undefined;await s.portal?.close();}}
  async expire() {for(const [id,s] of this.sessions) if(!s.busy&&this.clock()-s.updated>20*60_000) await this.clear(id);}
  async say(id,text,options) {if(!this.canUse(id))return;const message=await this.telegram.send(id,text,options);const s=this.sessions.get(id);if(s)s.promptId=message?.message_id;return message;}
  async start(id,fields={}) {
    await this.clear(id);if(!this.canUse(id))return;
    this.sessions.set(id,{phase:'type',credentials:{},updated:this.clock(),lastMessageId:0,reuse:fields});
    return this.say(id,'Form lock & Final Print — choose Fresh or Renewal. The bot checks the portal status before offering a final lock. Institution print may only become available after the portal waiting period.',keyboard([['Fresh','Renewal'],['/menu']]));
  }
  async call(id,s,method,...args) {
    let timer;await this.activity?.record({event:'portal_started',module:'final',userId:id,action:method});
    try {
      const result=await Promise.race([s.portal[method](...args),new Promise((_,reject)=>{timer=setTimeout(()=>{void s.portal.close();reject(Error('timeout'));},this.timeoutMs);})]);
      if(this.sessions.get(id)!==s||!this.canUse(id)) throw Error('Session closed');
      await this.activity?.record({event:'portal_result',module:'final',userId:id,action:method,result:result?.kind});return result;
    } catch {await this.activity?.record({event:'portal_error',module:'final',userId:id,action:method,result:'failed'});throw Error('Portal operation stopped');}
    finally {clearTimeout(timer);}
  }
  fields(s) {return {registration:{value:s.credentials.registration},otr:{value:s.credentials.otr},applicationType:{value:s.applicationType}};}
  async passwordPrompt(id,s) {
    s.phase='password-choice';
    return this.say(id,'Choose the configured default password or enter another password. Login passwords are temporary and are not saved in session records.',keyboard(this.defaultPassword?[['Use default password','Other'],['/cancel']]:[['Other'],['/cancel']]));
  }
  async open(id,s) {
    s.phase='loading';await s.portal?.close();s.portal=this.portalFactory(s.applicationType);
    const image=await this.call(id,s,'open');s.phase='captcha';return this.photo(id,s,image);
  }
  async photo(id,s,image) {
    if(!this.canUse(id))return;const message=await this.telegram.photo(id,image,'Login CAPTCHA: enter the characters shown. /refresh gets a new image.');s.promptId=message?.message_id;
  }
  async status(id,s,step) {
    s.step=step;
    if(step.kind==='lock-review'||step.kind==='dialog-review') {
      s.phase='confirm';
      return this.say(id,`${step.identity}\n\n${step.notice||''}${step.declaration?'\nPortal confirmation:\n'+step.declaration:''}\n\nFinal locking submits this application and may prevent further editing. Check the application and applicant carefully. Send YES to lock this application once, or /cancel.`,keyboard([['YES'],['/cancel']]));
    }
    if(step.kind==='print-ready') {s.lockConfirmed=true;return this.download(id,s);}
    if(step.kind==='waiting') {
      s.phase='waiting';s.lockConfirmed=true;await s.portal.close();
      return this.say(id,'The portal confirms the application is locked, but institution print is not available yet. The portal asks for printing after three days. Return through /start → 5 with a fresh login when available. The bot will skip locking an already locked application.');
    }
    s.phase=step.kind==='unknown'?'unknown':'blocked';await s.portal?.close();
    return this.say(id,step.kind==='unknown'?'A lock request may have been submitted, but the outcome is uncertain. Check the official portal before any new attempt. No automatic resubmission will occur.':step.kind==='expired'?'The portal session expired. Use /start → 5 for a fresh login.':step.message||'This portal stage is not mapped. No further action was submitted. Complete or inspect this stage on the official portal.');
  }
  async download(id,s) {
    s.phase='printing';const result=await this.call(id,s,'finalPdf');
    s.incomplete=result.kind==='print-error-pdf';s.pdf=result.bytes;s.phase='done';
    await s.portal.close();return this.deliver(id,s);
  }
  async deliver(id,s) {
    if(!s.pdfSaved) {
      const fields={...this.fields(s),status:{value:s.incomplete?'INCOMPLETE portal-error PDF':'final-print PDF'}};
      if(!s.pdfId) s.pdfId=(await this.store.save({userId:id,module:'final',fields,ready:true})).id;
      const record=await this.store.get(s.pdfId,id);
      if(record.status==='ready') await this.store.begin(s.pdfId,id,fields);
      if(record.status!=='confirmed') await this.store.outcome(s.pdfId,id,{status:s.incomplete?'uncertain':'confirmed',result:{kind:'pdf',pdf:s.pdf.toString('base64'),incomplete:s.incomplete}});
      s.pdfSaved=true;
    }
    if(!this.canUse(id))return;
    await this.telegram.document(id,s.pdf,`${s.pdfId}-${s.incomplete?'INCOMPLETE-portal-error':'final-print'}.pdf`,s.incomplete?'INCOMPLETE: printout of the official portal error page. Applicant details may be blank. This is not a valid final application; use option 5 later after the portal is fixed. Locking will not be repeated.':'Official institution-submission print. Follow the portal instructions for submitting the hard copy.');
    return this.say(id,`${s.incomplete?'Incomplete portal printout':'Final PDF'} saved: ${s.pdfId}. Retrieve it with /result ${s.pdfId}.`);
  }
  async storedResult(id,recordId) {
    if(!this.canUse(id))throw Error('Access denied');const record=await this.store.get(recordId,id);
    if(record.module!=='final'||record.result?.kind!=='pdf')throw Error('No final PDF');
    return this.telegram.document(id,Buffer.from(record.result.pdf,'base64'),`${record.id}-${record.result.incomplete?'INCOMPLETE-portal-error':'final-print'}.pdf`,record.result.incomplete?'INCOMPLETE: saved portal-error printout, not a valid final application. No portal request was made.':'Saved official institution-submission print. No portal request was made.');
  }
  async lock(id,s) {
    const fields=this.fields(s);
    const record=await this.store.save({id:s.lockId,userId:id,module:'final',fields,ready:true});s.lockId=record.id;
    await this.store.begin(s.lockId,id,fields);s.phase='submitting';
    const next=await this.call(id,s,'lock',s.step.token,s.step.declaration);
    const status=['print-ready','waiting'].includes(next.kind)?'confirmed':next.kind==='dialog-review'?'ready':'uncertain';
    await this.store.outcome(s.lockId,id,{status});
    return this.status(id,s,next);
  }
  async handle(message) {
    const id=message.chat.id,s=this.sessions.get(id);
    if(!s||!this.canUse(message.from.id)||message.chat.type!=='private'||s.busy||message.message_id<=s.lastMessageId)return;
    s.lastMessageId=message.message_id;s.updated=this.clock();
    const text=message.text.trim();
    if(message.reply_to_message&&message.reply_to_message.message_id!==s.promptId)return this.say(id,'Answer the latest prompt; that reply belongs to an older step.');
    s.busy=true;
    try {
      if(text==='/result') return s.pdf?await this.deliver(id,s):await this.say(id,'No final PDF is available in this session yet.');
      if(s.phase==='type') {
        const type=/^fresh$/i.test(text)?'Fresh':/^renewal$/i.test(text)?'Renewal':undefined;
        if(!type)return await this.say(id,'Choose Fresh or Renewal.');s.applicationType=type;s.phase='registration';return await this.say(id,'Enter the registration number.');
      }
      if(s.phase==='registration'||s.phase==='otr') {
        try {s.credentials[s.phase]=normalizePoly({type:s.phase==='registration'?'digits':'text',key:s.phase},text);}catch{return await this.say(id,'Enter a valid '+s.phase+' number.');}
        if(s.phase==='registration') {s.phase='otr';return await this.say(id,'Enter the OTR number.');}
        return await this.passwordPrompt(id,s);
      }
      if(s.phase==='password-choice') {
        if(text==='Other') {s.phase='password';return await this.say(id,'Enter the existing portal password.');}
        if(text!=='Use default password'||!this.defaultPassword)return await this.say(id,'Choose Use default password or Other.');
        s.credentials.password=this.defaultPassword;return await this.open(id,s);
      }
      if(s.phase==='password') {
        if(text.startsWith('/')||!text||text.length>128)return await this.say(id,'Enter the existing password or /cancel.');s.credentials.password=text;return await this.open(id,s);
      }
      if(s.phase==='captcha') {
        if(text==='/refresh')return await this.photo(id,s,await this.call(id,s,'refreshLogin'));
        if(!/^[A-Za-z0-9]{4,8}$/.test(text))return await this.say(id,'Enter the CAPTCHA exactly, or /refresh.');
        let next;try{next=await this.call(id,s,'login',{...s.credentials,captcha:text});}finally{delete s.credentials.password;}
        if(next.kind==='login-error') {await this.say(id,'Login was not accepted. Choose the password again for a fresh CAPTCHA.');return await this.passwordPrompt(id,s);}
        return await this.status(id,s,next);
      }
      if(s.phase==='confirm') return /^yes$/i.test(text)?await this.lock(id,s):await this.say(id,'Send YES only after reviewing the application, or /cancel.');
      return await this.say(id,'Use /result to retrieve an available PDF, or /start for a fresh portal status check. No lock will be repeated automatically.');
    } catch {
      const uncertain=s.phase==='submitting';s.phase=s.pdf?'done':uncertain?'unknown':'blocked';delete s.credentials.password;await s.portal?.close();
      return await this.say(id,s.pdf?'The PDF is retained. Use /result to retry saving or delivery; locking will not be repeated.':uncertain?'The lock outcome is uncertain. Check the official portal before another attempt. No automatic retry will occur.':s.lockConfirmed?'Locking is confirmed, but final PDF generation failed. Use a fresh login through option 5 to check print availability; do not lock again.':'The operation stopped. Check the portal or local storage, then use /start for a fresh session. No automatic submission retry will occur.');
    } finally {s.busy=false;}
  }
}
