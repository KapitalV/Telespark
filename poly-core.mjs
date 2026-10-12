import {POLY_FIELDS,POLY_SECTIONS,normalizePoly} from './poly-schema.mjs';

const operations={'1':'fill','2':'certificates','3':'pdf'};
const keyboard=rows=>({reply_markup:{keyboard:rows,resize_keyboard:true,one_time_keyboard:true}});
const loginFields=[{key:'registration',label:'Registration number',type:'digits'},{key:'otr',label:'OTR number',type:'text'},{key:'password',label:'Existing portal password (temporary; never saved)',type:'text'}];
export class PolyBot {
  constructor({telegram,portalFactory,store,canUse=()=>false,clock=()=>Date.now(),activity,timeoutMs=75_000}) {Object.assign(this,{telegram,portalFactory,store,canUse,clock,activity,timeoutMs});this.sessions=new Map();}
  async call(s,method,...args) {
    let timer;
    const userId=[...this.sessions].find(([,state])=>state===s)?.[0];
    await this.activity?.record({event:'portal_started',userId,module:'poly',action:method,phase:s.phase,stage:s.step?.stage});
    try {
      const result=await Promise.race([s.portal[method](...args),new Promise((_,reject)=>{timer=setTimeout(()=>{void s.portal.close();reject(Error('Portal timeout.'));},this.timeoutMs);})]);
      await this.activity?.record({event:'portal_result',userId,module:'poly',action:method,phase:s.phase,stage:result?.stage,result:Buffer.isBuffer(result)?'captcha':result?.kind});return result;
    } catch(error) {await this.activity?.record({event:'portal_error',userId,module:'poly',action:method,result:'failed'});throw error;}
    finally {clearTimeout(timer);}
  }
  async clear(id) {const s=this.sessions.get(id);this.sessions.delete(id);if(s) {s.credentials={};s.reuse={};s.result=undefined;await s.portal?.close();}}
  async expire() {for(const [id,s] of this.sessions) if(!s.busy&&this.clock()-s.updated>20*60_000) await this.clear(id);}
  async say(id,text,options) {if(!this.canUse(id)) return;const reply=await this.telegram.send(id,text,options);const s=this.sessions.get(id);if(s&&reply?.message_id) s.promptId=reply.message_id;return reply;}
  async start(id,fields={}) {
    await this.clear(id);if(!this.canUse(id)) return;
    this.sessions.set(id,{phase:'poly-menu',credentials:{},reuse:fields,index:0,updated:this.clock()});
    return this.say(id,'OTNew-Poly — choose an action. Form details and check-print PDFs are saved encrypted for your user ID. Passwords, CAPTCHA answers and cookies are temporary. No final locking is performed.',keyboard([['1. Fill/continue application'],['2. Verify income and caste'],['3. Download check-print PDF'],['/menu']]));
  }
  savedFields(s) {
    const fields={};for(const key of ['registration','otr']) if(s.credentials[key]) fields[key]={value:s.credentials[key]};
    if(s.operation) fields.operation={value:s.operation};if(s.step?.stage) fields.status={value:s.step.stage};
    for(const [key,answer] of s.portal?.answers||[]) if(Object.hasOwn(POLY_FIELDS,key)) fields[key]={value:answer.value,label:answer.display};
    if(s.portal?.ifsc) fields.ifsc={value:s.portal.ifsc};return fields;
  }
  async checkpoint(id,{ready=false}={}) {
    const s=this.sessions.get(id);if(!s||!s.credentials.registration) return;
    if(s.result&&s.pdfFields) {await this.persistPdf(id,s);return s.savedId;}
    if(s.pendingOutcome) {await this.store.outcome(s.savedId,id,s.pendingOutcome);s.pendingOutcome=undefined;}
    if(s.terminalRecord||s.phase==='unknown'||s.phase==='done') return s.savedId;
    const record=await this.store.save({id:s.savedId,userId:id,module:'poly',fields:this.savedFields(s),ready});s.savedId=record.id;return record.id;
  }
  async loginPrompt(id,s) {
    const field=loginFields[s.index],saved=s.reuse[field.key]?.value;
    return this.say(id,field.label+(saved?'\nSaved: '+saved+'\nSend USE SAVED or enter another value.':''),saved?keyboard([['USE SAVED'],['/cancel']]):undefined);
  }
  async continueTo(id,s,operation) {
    s.phase='preparing';s.operation=operation;
    const home=await this.call(s,'home');
    if(home.kind!=='dashboard'&&!(home.kind==='complete'&&home.stage==='certificates')) return this.prompt(id,s,home);
    if(this.sessions.get(id)!==s||!this.canUse(id)) return;
    return this.prompt(id,s,await this.call(s,'choose',operation));
  }
  async prompt(id,s,step) {
    if(this.sessions.get(id)!==s||!this.canUse(id)) {await s.portal?.close();return;}
    s.step=step;s.updated=this.clock();s.options=undefined;
    if(step.kind==='dashboard') {s.phase='loading';return this.prompt(id,s,await this.call(s,'choose',s.operation));}
    if(step.kind==='field') {
      s.phase='questions';s.search='';s.page=0;return this.fieldPrompt(id,s);
    }
    if(step.kind==='review') {
      s.phase='confirm';await this.checkpoint(id,{ready:true});
      const rows=step.review||[];await this.lines(id,[`Review ${step.stage}:`,...rows]);
      if(step.declaration) await this.lines(id,['Official declaration:',step.declaration]);
      return this.say(id,'Send CONFIRM to approve these details'+(step.declaration?' and accept the declaration':'')+'. I will then ask the current CAPTCHA.\nUse /edit to correct this section.',keyboard([['CONFIRM'],['/edit','/cancel']]));
    }
    if(step.kind==='record') {
      s.phase='record';await this.checkpoint(id,{ready:true});await this.lines(id,['Retrieved '+step.stage+' certificate:',step.record]);
      return this.say(id,'Check the holder, parent name, income/category, district and certificate numbers against your application. Send MATCH only if all details are correct; MISMATCH stops verification.',keyboard([['MATCH','MISMATCH'],['/cancel']]));
    }
    if(step.kind==='complete') {
      if(step.stage==='certificates'&&s.operation==='certificates') {
        s.certificatesConfirmed=true;
        await this.say(id,'The portal confirms income and caste verification. Preparing your check-print PDF; it will be saved and sent to this chat automatically.');
        return this.continueTo(id,s,'pdf');
      }
      if(step.stage==='form'&&s.operation==='fill') {
        await this.say(id,'The portal confirms application entry is complete. Continuing to income and caste verification; completed sections will not be submitted again.');
        return this.continueTo(id,s,'certificates');
      }
      return this.prompt(id,s,{kind:'unsupported'});
    }
    if(step.kind==='pdf') {
      s.phase='done';s.result=step.bytes;
      // Save the document before delivery; a Telegram failure must not lose it.
      const fields=this.savedFields(s);fields.status={value:'check-print PDF'};
      s.pdfFields=fields;s.savedId=undefined;s.pdfPersisted=false;await this.persistPdf(id,s);
      await s.portal.close();return this.deliver(id,s);
    }
    if(step.kind==='expired') {s.phase='blocked';await s.portal?.close();s.credentials.password=undefined;return this.say(id,'The portal session expired. Use /save to retrieve saved details, then /reuse SESSION_ID for a fresh login. No submission was repeated.');}
    s.phase=step.kind==='unknown'?'unknown':'unsupported';await s.portal?.close();s.credentials.password=undefined;
    return this.say(id,s.certificatesConfirmed?'Income and caste verification is confirmed, but the check-print page could not be verified. Use /menu → OTNew-Poly → Download check-print PDF for a fresh login. Certificate verification will not be repeated.':step.kind==='unknown'?'The submission outcome is uncertain. I will not repeat it. Start a fresh login and check portal status before proceeding. /save retains the attempt status.':step.message||'This portal page is not mapped or could not be verified. No unknown form was submitted. Use /menu; this branch needs inspection.');
  }
  async lines(id,lines) {let text='';for(const line of lines) {for(let i=0;i<line.length;i+=3000) {const part=line.slice(i,i+3000);if(text.length+part.length>3400){await this.say(id,text);text='';}text+=(text?'\n':'')+part;}}if(text) await this.say(id,text);}
  async fieldPrompt(id,s) {
    const f=s.step.field,options=f.options;
    if(options) {
      const filtered=options.filter(o=>!s.search||o.label.toLowerCase().includes(s.search.toLowerCase()));
      s.options=filtered.slice(s.page*12,(s.page+1)*12);
      const rows=s.options.map((o,i)=>[`${i+1}. ${o.label}`]);
      if(filtered.length>12) rows.push(['/next']);
      if(f.suggestion!==undefined) rows.push(['USE DEFAULT']);
      if(s.reuse[f.key]) rows.push(['USE SAVED']);
      rows.push(['/cancel']);
      const suggested=options.find(o=>o.value===f.suggestion)?.label;
      return this.say(id,`${f.label}${suggested?'\nDefault: '+suggested:''}\nChoose a listed option. /search words filters the list; /next shows more.`,keyboard(rows));
    }
    const saved=s.reuse[f.key]?.value;
    return this.say(id,`${f.label}${f.suggestion!==undefined?'\nDefault: '+f.suggestion:''}${saved?'\nSaved: '+saved:''}\nEnter the value${f.suggestion!==undefined?' or send USE DEFAULT':''}${saved?' or USE SAVED':''}.`,keyboard([...(f.suggestion!==undefined?[['USE DEFAULT']]:[]),...(saved?[['USE SAVED']]:[]),['/cancel']]));
  }
  async persistPdf(id,s) {
    if(s.pdfPersisted) return;
    if(!s.savedId) {const record=await this.store.save({userId:id,module:'poly',fields:s.pdfFields,ready:true});s.savedId=record.id;}
    const record=await this.store.get(s.savedId,id);
    if(record.status==='ready') await this.store.begin(record.id,id,s.pdfFields);
    if(record.status!=='confirmed') await this.store.outcome(record.id,id,{status:'confirmed',result:{kind:'pdf',pdf:s.result.toString('base64')}});
    s.pdfPersisted=true;s.terminalRecord=true;
  }
  async deliver(id,s) {if(!this.canUse(id)) return;await this.persistPdf(id,s);await this.telegram.document(id,s.result,`${s.savedId}-check-print.pdf`,'Official check-print copy for review. This does not final-lock or forward the application.');return this.say(id,`PDF saved: ${s.savedId}. Retrieve with /result ${s.savedId}.`);}
  async storedResult(id,sessionId) {
    const record=await this.store.get(sessionId,id);if(record.module!=='poly'||record.result?.kind!=='pdf') return this.say(id,'That record has no saved check-print PDF. Use /save to find a PDF record.');
    if(!this.canUse(id)) return;await this.telegram.document(id,Buffer.from(record.result.pdf,'base64'),`${record.id}-check-print.pdf`,'Saved official check-print PDF. No portal request was made.');
  }
  async attempt(id,s,captcha,record=false) {
    s.phase='submitting';await this.checkpoint(id,{ready:true});
    await this.store.begin(s.savedId,id,this.savedFields(s));s.terminalRecord=true;
    let next;try {next=await this.call(s,'submit',captcha,s.step.token,record);} catch {next={kind:'unknown'};}
    s.pendingOutcome={status:next.kind==='captcha-error'?'ready':['field','record','complete'].includes(next.kind)?'confirmed':'uncertain',result:{kind:next.kind==='captcha-error'?'unknown':['field','record','complete'].includes(next.kind)?'success':'unknown'}};
    await this.store.outcome(s.savedId,id,s.pendingOutcome);s.pendingOutcome=undefined;
    if(next.kind==='captcha-error') {
      s.terminalRecord=false;
      const fresh=await this.call(s,'read');
      if(fresh.kind!=='review'||fresh.stage!==s.step.stage||fresh.declaration!==s.step.declaration||JSON.stringify(fresh.review)!==JSON.stringify(s.step.review)) return this.prompt(id,s,fresh);
      s.step=fresh;s.phase='captcha';await this.say(id,'The portal rejected the CAPTCHA. Enter the new image; the form is not confirmed.');return this.showCaptcha(id,s);
    }
    if(['field','record','complete'].includes(next.kind)) {s.savedId=undefined;s.terminalRecord=false;}
    return this.prompt(id,s,next);
  }
  async showCaptcha(id,s) {
    const bytes=await this.call(s,'captcha');if(!this.canUse(id)) return;
    const reply=await this.telegram.photo(id,bytes,'Reply with the CAPTCHA exactly as shown. /refresh requests a new image.');if(reply?.message_id) s.promptId=reply.message_id;
  }
  async handle(message) {
    const id=message.chat.id;if(!this.canUse(message.from.id)||message.chat.type!=='private') return;
    const s=this.sessions.get(id);if(!s) return await this.say(id,'Use /menu to start OTNew-Poly.');
    const text=message.text.trim(),command=text.split(/\s+/)[0].toLowerCase();s.updated=this.clock();
    if(message.reply_to_message&&message.reply_to_message.message_id!==s.promptId) return await this.say(id,'That reply belongs to an older step. Answer the current prompt.');
    if(s.busy) return;
    s.busy=true;
    try {
      if(command==='/result') return text.split(/\s+/)[1]?await this.storedResult(id,text.split(/\s+/)[1]):s.result?await this.deliver(id,s):await this.say(id,'No PDF in this session. Use /result SESSION_ID for a saved PDF.');
      if(s.phase==='poly-menu'||s.phase==='done') {
        const operation=operations[text[0]];if(!operation) return await this.say(id,'Choose 1, 2 or 3.');s.operation=operation;
        if(s.phase==='done'&&!s.portal.closed) {await this.call(s,'home');return await this.prompt(id,s,await this.call(s,'choose',operation));}
        if(s.phase==='done') {s.reuse={...s.reuse,...this.savedFields(s)};s.result=undefined;s.pdfFields=undefined;s.pdfPersisted=false;s.savedId=undefined;s.terminalRecord=false;s.pendingOutcome=undefined;s.step=undefined;s.certificatesConfirmed=false;}
        s.index=0;s.phase='login';return await this.loginPrompt(id,s);
      }
      if(s.phase==='login') {
        if(text.startsWith('/')) return await this.say(id,'Enter the requested login field, or use /menu or /cancel.');
        const field=loginFields[s.index],input=text==='USE SAVED'?s.reuse[field.key]?.value:text;
        let value;try {value=normalizePoly(field,input||'');} catch(error) {return await this.say(id,error.message);}
        s.credentials[field.key]=value;s.index++;
        if(s.index<loginFields.length) return await this.loginPrompt(id,s);
        s.phase='loading';await s.portal?.close();s.portal=this.portalFactory();const image=await this.call(s,'open');s.phase='login-captcha';
        if(!this.canUse(id)) return await this.clear(id);const reply=await this.telegram.photo(id,image,'Login CAPTCHA: enter the characters shown. /refresh replaces the image.');s.promptId=reply?.message_id;return;
      }
      if(command==='/refresh'&&['captcha','login-captcha'].includes(s.phase)) {
        const image=s.phase==='login-captcha'?await this.call(s,'refreshLogin'):await this.call(s,'captcha',true);
        const reply=await this.telegram.photo(id,image,'Enter this new CAPTCHA.');s.promptId=reply?.message_id;return;
      }
      if(s.phase==='login-captcha') {
        if(text.startsWith('/')) return await this.say(id,'Enter the current CAPTCHA or /refresh.');
        let next;try {next=await this.call(s,'login',{...s.credentials,captcha:text});} finally {delete s.credentials.password;}
        if(next.kind==='login-error') {s.phase='login';s.index=2;return await this.say(id,'Login was not accepted. Re-enter the existing password; a fresh CAPTCHA will be requested.');}
        return await this.prompt(id,s,next);
      }
      if(s.phase==='questions') {
        if(command==='/search'||command==='/next') {
          if(!s.step.field.options) return await this.say(id,'This field needs a typed answer.');
          if(command==='/search'){s.search=text.slice(7).trim();s.page=0;}else {const length=s.step.field.options.filter(o=>!s.search||o.label.toLowerCase().includes(s.search.toLowerCase())).length;s.page=(s.page+1)%Math.max(1,Math.ceil(length/12));}return await this.fieldPrompt(id,s);
        }
        if(text.startsWith('/')) return await this.say(id,'Enter the requested field. Use /search or /next for choices, or /menu to stop.');
        const f=s.step.field;let value=text;
        if(text==='USE DEFAULT') value=f.suggestion;
        else if(text==='USE SAVED') value=s.reuse[f.key]?.value;
        else if(s.options) {const numbered=/^(\d+)(?:\.|$)/.exec(text);if(numbered) value=s.options[Number(numbered[1])-1]?.value;}
        try {value=normalizePoly(f,value||'',s.portal.values());} catch(error) {return await this.say(id,error.message);}
        return await this.prompt(id,s,await this.call(s,'fill',f,value,s.step.token));
      }
      if(s.phase==='confirm'&&command==='/edit') {
        const fields=POLY_SECTIONS[s.step.stage].fields.filter(f=>!f.computed);s.editFields=fields;s.phase='edit';return await this.lines(id,['Choose the field number to correct:',...fields.map((f,i)=>`${i+1}. ${f.label}`)]);
      }
      if(s.phase==='edit') {const f=s.editFields[Number(text)-1];if(!f) return await this.say(id,'Enter a field number from the list.');return await this.prompt(id,s,await this.call(s,'edit',f.key));}
      if(s.phase==='confirm'&&text.toUpperCase()==='CONFIRM') {s.phase='captcha';return await this.showCaptcha(id,s);}
      if(s.phase==='record') {
        if(text.toUpperCase()==='MISMATCH') return await this.prompt(id,s,{kind:'unsupported',message:'Certificate mismatch reported. Verification stopped. Check the certificate and application on the portal.'});
        if(text.toUpperCase()==='MATCH') return await this.attempt(id,s,undefined,true);
        return await this.say(id,'Send MATCH only if the retrieved record matches, or MISMATCH to stop.');
      }
      if(s.phase==='captcha'&&!text.startsWith('/')) return await this.attempt(id,s,text);
      return await this.say(id,'Use the current prompt, /save, or /menu. An uncertain submission cannot be retried automatically.');
    } catch {
      // Do not expose portal/transport exception text: it may include personal data.
      if(s.phase==='submitting'||s.terminalRecord&&!s.result) s.phase='unknown';else if(!s.result) s.phase='blocked';
      delete s.credentials.password;await s.portal?.close();
      return await this.say(id,s.result?'The PDF is retained in this session. Use /save to retry saving its result, then /result to retry delivery; no portal submission will be repeated.':s.certificatesConfirmed?'Income and caste verification is confirmed, but PDF preparation failed. Use /menu → OTNew-Poly → Download check-print PDF for a fresh login. Certificate verification will not be repeated.':'The operation stopped safely. Check /save for its recorded status and use a fresh login to inspect the portal. No submission will be repeated automatically.');
    } finally {s.busy=false;}
  }
}
