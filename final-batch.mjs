import {readFile} from 'node:fs/promises';
import {parseBatchWorkbook,MAX_WORKBOOK_BYTES} from './batch-workbook.mjs';

const keyboard=rows=>({reply_markup:{keyboard:rows,resize_keyboard:true,one_time_keyboard:true}});
const csvCell=value=>'"'+String(value??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
export function batchReport(rows) {
  return Buffer.from('\uFEFF'+[['Row','Registration Number','Status','Saved PDF Session ID'],...rows.map(r=>[r.row,r.registration,r.status,r.pdfId||''])].map(r=>r.map(csvCell).join(',')).join('\r\n'));
}
export class FinalBatch {
  constructor({telegram,isAdmin,portalFactory,deliver,activity,presets={},parse=parseBatchWorkbook,clock=()=>Date.now(),timeoutMs=75000,templatePath=new URL('./assets/Final_Print_Batch_Template.xlsx',import.meta.url)}) {
    Object.assign(this,{telegram,isAdmin,portalFactory,deliver,activity,presets,parse,clock,timeoutMs,templatePath});this.sessions=new Map();
  }
  alive(id,s) {return this.sessions.get(id)===s&&this.isAdmin(id);}
  async clear(id) {const s=this.sessions.get(id);this.sessions.delete(id);if(s){s.password=undefined;s.rowPassword=undefined;s.rows=[];s.delivery=undefined;await s.portal?.close();}}
  async expire() {for(const [id,s] of this.sessions)if(!this.isAdmin(id)||(!s.busy&&this.clock()-s.updated>20*60_000))await this.clear(id);}
  async say(id,text,options) {if(this.isAdmin(id))return this.telegram.send(id,text,options);}
  async template(id) {if(this.isAdmin(id))return this.telegram.document(id,await readFile(this.templatePath),'Final_Print_Batch_Template.xlsx','Fill the Candidates sheet, then send /finalbatch and upload this .xlsx file. Passwords are selected in Telegram.');}
  async start(id) {
    if(!this.isAdmin(id))return;
    if(this.sessions.has(id)&&this.sessions.get(id).phase!=='done')return this.say(id,'A batch is already active. Use /batchstatus or /cancel before replacing it.');
    await this.clear(id);this.sessions.set(id,{phase:'upload',updated:this.clock(),lastMessageId:0,rows:[],index:0});
    return this.say(id,'Upload the completed Final Print .xlsx template (maximum 2 MB and 100 candidates). This batch only prints; it never locks applications. /finaltemplate downloads a blank copy.',keyboard([['/finaltemplate'],['/cancel']]));
  }
  async upload(message) {
    const id=message.chat.id,s=this.sessions.get(id);
    if(!this.isAdmin(message.from.id)||message.chat.type!=='private'||!s)return;
    if(s.phase!=='upload'||s.busy)return this.say(id,'This batch cannot be replaced by another upload. Use /batchstatus or /cancel.');
    s.busy=true;s.updated=this.clock();
    try {
      const d=message.document;
      if(!/\.xlsx$/i.test(d?.file_name||'')||!Number.isSafeInteger(d.file_size)||d.file_size<1||d.file_size>MAX_WORKBOOK_BYTES)return await this.say(id,'Upload an .xlsx file no larger than 2 MB.');
      const bytes=await this.telegram.download(d,MAX_WORKBOOK_BYTES);
      const rows=await this.parse(bytes);if(!this.alive(id,s))return;
      s.rows=rows;s.phase='batch-review';
      const valid=rows.filter(r=>r.status==='pending').length,invalid=rows.filter(r=>r.status==='invalid'),duplicates=rows.filter(r=>r.status==='duplicate').length;
      await this.say(id,`Workbook checked: ${valid} valid, ${invalid.length} invalid, ${duplicates} duplicate.\n${invalid.slice(0,10).map(r=>`Row ${r.row}: ${r.note}`).join('\n')}\n${valid?'Send YES to process valid rows in order.':'No valid rows. Use /cancel and upload a corrected workbook.'}`,keyboard(valid?[['YES'],['/cancel']]:[['/cancel']]));
    } catch {if(this.alive(id,s)){s.phase='upload';s.rows=[];await this.say(id,'Could not read the workbook. Use the original Candidates headers, text identifiers, at most 100 candidates and a plain .xlsx file under 2 MB. Upload a corrected copy.');}}
    finally{s.busy=false;}
  }
  async choosePassword(id,s,perRow=false) {
    s.phase='password-choice';s.perRow=perRow;
    const choices=Object.keys(this.presets).filter(k=>this.presets[k]);
    return this.say(id,perRow?'Login was not accepted. Choose a password for this candidate only, or /retry for the same password and a fresh CAPTCHA. /skip moves on.':'Choose one password for the whole batch. A candidate-specific correction will not change it.',keyboard([...choices.map(k=>[k]),['Other'],...(perRow?[['/retry','/skip']]:[]),['/cancel']]));
  }
  async call(id,s,method,...args) {
    if(!['open','login','refreshLogin','finalPdf'].includes(method))throw Error('Unsupported batch operation');
    if(!this.alive(id,s))throw Error('Session closed');
    const portal=s.portal;let timer;
    await this.activity?.record({event:'portal_started',module:'final-batch',userId:id,action:method});
    try {
      const result=await Promise.race([portal[method](...args),new Promise((_,reject)=>{timer=setTimeout(()=>{void portal.close();reject(Error('Timeout'));},this.timeoutMs);})]);
      if(!this.alive(id,s))throw Error('Session closed');
      await this.activity?.record({event:'portal_result',module:'final-batch',userId:id,action:method,result:result?.kind});return result;
    } catch {await this.activity?.record({event:'portal_error',module:'final-batch',userId:id,action:method,result:'failed'});throw Error('Portal operation failed');}
    finally{clearTimeout(timer);}
  }
  async captcha(id,s,image) {
    s.phase='captcha';const row=s.rows[s.index];
    const sent=await this.telegram.photo(id,image,`Row ${row.row} | Registration ${row.registration}\nReply to THIS photo with the CAPTCHA. /refresh gets a new image; /skip moves on.`,{reply_markup:JSON.stringify({force_reply:true,selective:true})});
    s.promptId=sent?.message_id;
  }
  async openCurrent(id,s) {
    await s.portal?.close();s.phase='loading';const row=s.rows[s.index];
    s.portal=this.portalFactory(row.applicationType);
    await this.say(id,`Candidate ${s.index+1}/${s.rows.length}: ${row.registration} (${row.applicationType}). Loading login.`);
    return this.captcha(id,s,await this.call(id,s,'open'));
  }
  async advance(id,s) {
    await s.portal?.close();s.portal=undefined;s.delivery=undefined;s.rowPassword=undefined;
    while(s.index<s.rows.length&&s.rows[s.index].status!=='pending')s.index++;
    if(s.index>=s.rows.length){s.password=undefined;s.phase='done';return this.finish(id,s);}
    s.rowPassword=s.password;return this.openCurrent(id,s);
  }
  async completeRow(id,s,status) {
    const row=s.rows[s.index];row.status=status;delete row.otr;delete row.name;
    await this.say(id,`Registration ${row.registration}: ${status}.`);
    return this.advance(id,s);
  }
  async sendPdf(id,s) {
    s.phase='delivery';await this.deliver(id,s.delivery);
    if(!this.alive(id,s))return;
    s.rows[s.index].pdfId=s.delivery.pdfId;
    return this.completeRow(id,s,s.delivery.incomplete?'INCOMPLETE PDF sent':'PDF sent');
  }
  async status(id) {
    const s=this.sessions.get(id);if(!s)return this.say(id,'No Excel batch is active. Use /finalbatch.');
    s.updated=this.clock();
    const lines=[`Batch: ${s.phase}. ${s.rows.filter(r=>r.status!=='pending').length}/${s.rows.length} rows resolved.`,...s.rows.map(r=>`Row ${r.row}: ${r.registration||'(invalid identifier)'} — ${r.status}${r.pdfId?' — '+r.pdfId:''}`)];
    for(let i=0;i<lines.length;i+=25)await this.say(id,lines.slice(i,i+25).join('\n'));
  }
  async finish(id,s) {
    s.phase='done';s.password=undefined;s.rowPassword=undefined;
    for(const row of s.rows){delete row.otr;delete row.name;}
    await this.status(id);
    await this.telegram.document(id,batchReport(s.rows),'Final_Print_Batch_Results.csv','Batch results. Saved L session IDs can be retrieved with /result Lxxxx. No applications were locked by this batch.');
  }
  async handle(message) {
    const id=message.chat.id,s=this.sessions.get(id);
    if(!this.isAdmin(message.from.id)||message.chat.type!=='private'||!s||s.busy||message.message_id<=s.lastMessageId)return;
    s.lastMessageId=message.message_id;s.updated=this.clock();const text=message.text.trim();
    if(text==='/batchstatus')return this.status(id);
    s.busy=true;
    try {
      if(text==='/skip'&&s.password&&s.rows[s.index]?.status==='pending')return await this.completeRow(id,s,'Skipped by admin');
      if(s.phase==='retry-next'&&text==='/retry')return await this.advance(id,s);
      if(s.phase==='done')return await this.finish(id,s);
      if(s.phase==='batch-review') {
        if(/^yes$/i.test(text)&&s.rows.some(r=>r.status==='pending'))return await this.choosePassword(id,s);
        return await this.say(id,'Send YES to start the valid rows, or /cancel.');
      }
      if(s.phase==='password-choice'||s.phase==='password') {
        if(text==='/retry'&&s.perRow)return await this.openCurrent(id,s);
        if(s.phase==='password-choice'&&text==='Other'){s.phase='password';return await this.say(id,'Enter the existing password. It stays in memory only.');}
        const password=s.phase==='password'?text:this.presets[text];
        if(!password||password.startsWith('/')||password.length>128)return await this.say(id,'Choose a password button, or enter the password after choosing Other.');
        if(s.perRow){s.rowPassword=password;return await this.openCurrent(id,s);}
        s.password=password;return await this.advance(id,s);
      }
      if(s.phase==='delivery'&&(text==='/retry'||text==='/result'))return await this.sendPdf(id,s);
      if(s.phase==='retry'&&text==='/retry')return await this.openCurrent(id,s);
      if(s.phase==='captcha') {
        if(text==='/refresh')return await this.captcha(id,s,await this.call(id,s,'refreshLogin'));
        if(message.reply_to_message?.message_id!==s.promptId)return await this.say(id,'Reply directly to the latest CAPTCHA photo so an older answer cannot reach another candidate.');
        if(!/^[A-Za-z0-9]{4,8}$/.test(text))return await this.say(id,'Enter the CAPTCHA exactly, or /refresh.');
        const row=s.rows[s.index],step=await this.call(id,s,'login',{registration:row.registration,otr:row.otr,password:s.rowPassword,captcha:text});
        if(step.kind==='login-error')return await this.choosePassword(id,s,true);
        if(step.kind==='lock-review'||step.kind==='dialog-review')return await this.completeRow(id,s,'Not locked — use option 5 individually');
        if(step.kind==='waiting') {
          if(step.notice)await this.say(id,'Portal status: '+String(step.notice).slice(0,700));
          return await this.completeRow(id,s,'Locked — final print not available yet');
        }
        if(step.kind!=='print-ready')return await this.completeRow(id,s,step.kind==='expired'?'Session expired':'Unsupported portal status — inspect individually');
        s.phase='printing';const result=await this.call(id,s,'finalPdf');
        if(!Buffer.isBuffer(result.bytes)||!['pdf','print-error-pdf'].includes(result.kind))throw Error('No PDF');
        s.delivery={credentials:{registration:row.registration,otr:row.otr},applicationType:row.applicationType,pdf:result.bytes,incomplete:result.kind==='print-error-pdf'};
        await s.portal.close();return await this.sendPdf(id,s);
      }
      return await this.say(id,'Use /retry for the failed step, /skip for the current candidate, /batchstatus or /cancel.');
    } catch {
      if(this.alive(id,s)) {
        await s.portal?.close();
        if(s.rows[s.index]?.status!=='pending') {s.phase='retry-next';await this.say(id,'Progress was retained. Send /retry to continue the next pending row or resend the completion report.');}
        else {s.phase=s.delivery?'delivery':'retry';if(s.delivery?.pdfId)s.rows[s.index].pdfId=s.delivery.pdfId;await this.say(id,s.delivery?'PDF retained. Use /retry to resend it without login or printing again, or /skip.':'Portal operation stopped. Use /retry for a fresh login or /skip. No application was locked.',keyboard([['/retry','/skip'],['/cancel']]));}
      }
    } finally{s.busy=false;}
  }
}
