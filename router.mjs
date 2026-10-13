import {LOG_COMMANDS,formatActivity} from './activity.mjs';
import {questionAt} from './core.mjs';
import {telegramUserId} from './access.mjs';

// Text reply keyboards keep polling and webhook transports message-only.
export class BotRouter {
  constructor({telegram, recovery, otr, registration, poly, final, access, activity, saves, allowedUserId = '', enableOtr = false, enablePoly=false, enableFinal=false, clock = () => Date.now()}) {
    Object.assign(this, {telegram, recovery, otr, registration, poly, final, access, activity, saves, allowedUserId:String(allowedUserId), enableOtr, enablePoly, enableFinal, clock});
    this.sessions = new Map();
    this.lastMessages = new Map();
    this.locks = new Map();
    saves?.bind(this);
  }

  handle(message) {
    if (!message?.from || message.from.is_bot || message.chat?.type !== 'private') return Promise.resolve();
    // Serialize even when called outside the polling/webhook queues.
    const id = message.chat.id;
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.route(message));
    this.locks.set(id, next);
    return next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); });
  }

  async clear(id) {
    this.sessions.delete(id);
    await Promise.all([this.recovery.clear(id), this.otr.clear(id), this.registration?.clear(id),this.poly?.clear(id),this.final?.clear(id)]);
  }

  async expire() {
    const previous=[...this.sessions.keys()].map(id=>({id,...this.activityContext(id)}));
    await Promise.all([this.recovery.expire(), this.otr.expire(), this.registration?.expire(),this.poly?.expire(),this.final?.expire()]);
    for (const [id, state] of this.sessions) {
      if (this.clock() - state.updated > 20 * 60_000 && !this.poly?.sessions.get(id)?.busy&&!this.final?.sessions.get(id)?.busy) await this.clear(id);
    }
    for(const before of previous) {
      const after=this.activityContext(before.id);
      if(before.phase!=='none' && after.phase==='none') await this.activity?.record({event:'session_expired',userId:before.id,module:before.module,phase:before.phase});
    }
  }

  async menu(id, submenu = false) {
    await this.clear(id);
    this.sessions.set(id, {module:submenu ? 'otr-menu' : 'menu', updated:this.clock()});
    const rows = submenu ? [['1. Recover OTR'], ['2. Scholarship registration using OTR'], ['Back']] : [['1. Password recovery'], ['2. OTR'],['3. Form filling OTNew-Poly'],['4. Saved sessions'],['5. Form lock & Final Print']];
    return this.telegram.send(id, submenu ? 'OTR — recover your number or register a fresh scholarship application using an existing OTR.' : 'UP Scholarship — choose an option.\nActivity logs exclude your answers, passwords and images.'+(this.saves?'\nDetails are saved automatically before submission. /save lists saved sessions; /dsave and /psave are optional. Saved fields, passwords and results are encrypted and remain available after restart. OTPs, CAPTCHA answers and cookies are never saved. /cancel clears only the active session.':''), {
      reply_markup:{keyboard:rows, resize_keyboard:true, one_time_keyboard:true},
    });
  }

  activityContext(id) {
    const module=this.sessions.get(id)?.module || 'none';
    const state=({password:this.recovery,otr:this.otr,registration:this.registration,poly:this.poly,final:this.final}[module])?.sessions?.get(id);
    const phase=state?.phase || (['menu','otr-menu'].includes(module)?module:'none');
    const field=module==='password'
      ? (phase==='questions'?questionAt(state.index,state.details)?.[0]:phase==='correction'?state.correction:phase==='captcha'?'captcha':undefined)
      : state?.step?.fields?.[state.index]?.type;
    const result=phase==='unknown'?'unknown':phase==='done'?(module==='poly'?'success':module==='password'?state.result?.kind:state.result?'success':'result-image'):undefined;
    return {module,phase,field,result};
  }

  async route(message) {
    const id=message.chat.id,userId=message.from.id,messageId=message.message_id;
    if(!Number.isSafeInteger(messageId) || messageId<1) return;
    if(messageId<=(this.lastMessages.get(id) ?? -1)) {
      await this.activity?.record({event:'ignored',userId,messageId,reason:'duplicate'});return;
    }
    this.lastMessages.set(id,messageId);
    if(typeof message.text!=='string' || !message.text.trim()) {
      await this.activity?.record({event:'ignored',userId,messageId,reason:'unsupported-message'});return;
    }
    const text=message.text.trim(),command=text.split(/\s/)[0].toLowerCase();
    const before=this.activityContext(id);
    let action=text.startsWith('/')?(LOG_COMMANDS.has(command)?command:'unknown-command'):'answer';
    if(before.module==='menu' && /^1(?:\.|$)/.test(text)) action='choose-password';
    if(before.module==='menu' && /^2(?:\.|$)/.test(text)) action='choose-otr';
    if(before.module==='otr-menu' && /^1(?:\.|$)/.test(text)) action='choose-recovery';
    if(before.module==='otr-menu' && /^2(?:\.|$)/.test(text)) action='choose-registration';
    if(before.module==='otr-menu' && /^back$/i.test(text)) action='back';
    if(before.phase==='confirm' && /^(yes|confirm)$/i.test(text)) action='confirm';
    await this.activity?.record({event:'message',userId,messageId,action,...before});
    try {
      const result=await this.dispatch(message);
      await this.activity?.record({event:'handled',userId,messageId,action,...this.activityContext(id)});
      return result;
    } catch(error) {
      await this.activity?.record({event:'handled',userId,messageId,action,...this.activityContext(id),result:'failed'});
      throw error;
    }
  }

  async dispatch(message) {
    const id = message.chat.id;
    const text = message.text.trim();
    const command = text.split(/\s/)[0].toLowerCase();
    if (command === '/id') return this.recovery.handle(message);
    if (!(this.access ? this.access.canUse(message.from.id) : this.allowedUserId && String(message.from.id)===this.allowedUserId)) {
      await this.activity?.record({event:'denied',userId:message.from.id,messageId:message.message_id,reason:'access'});
      return this.telegram.send(id, 'Access is restricted. Send /id and ask the admin to add that user ID.');
    }
    if (['/adduser','/removeuser','/users','/admin','/log'].includes(command)) return this.adminCommand(message,command);
    if (command === '/test') {
      const valid=text.split(/\s+/).length===1;
      await this.activity?.record({event:valid?'handled':'system_error',module:'system',action:'/test',userId:message.from.id,httpStatus:valid?200:400,...(valid?{}:{reason:'invalid-arguments'})});
      if(!valid) {
        const now=this.clock();
        if(now-(this.lastTestAlert??-Infinity)>=60_000) {
          this.lastTestAlert=now;
          const admin=this.access?.adminId||this.allowedUserId;
          if(admin) await this.telegram.send(admin,'Malformed /test request rejected. No portal action was performed. See /log.').catch(()=>{});
        }
      }
      return this.telegram.send(id,JSON.stringify(valid?{ok:true,status:'200 OK',service:'OTNew-Poly',enabled:this.enablePoly,portalVerified:false,message:'Bot is responding. This test does not submit or verify a portal application.'}:{ok:false,error:{code:'INVALID_TEST_REQUEST',message:'Send /test without arguments.'}}));
    }
    if(command==='/result'&&/^L[0-9]{4}$/.test(text.split(/\s+/)[1]||'')) {
      try {return await this.final.storedResult(id,text.split(/\s+/)[1]);} catch {return this.telegram.send(id,'Saved final PDF unavailable. Check the session ID and owner.');}
    }
    if(command==='/result'&&/^(?:D[0-9]{4}|F-[a-f0-9]{32})$/.test(text.split(/\s+/)[1]||'')) {
      try {return await this.poly.storedResult(id,text.split(/\s+/)[1]);} catch {return this.telegram.send(id,'Saved PDF unavailable. Check the session ID and owner.');}
    }
    await this.expire();
    if(['/save','/dsave','/psave','/reuse'].includes(command)) return this.saves?this.saves.handle(message,command):this.telegram.send(id,'Saved sessions are unavailable in this bot build.');
    if (command === '/cancel') {
      await this.clear(id);
      return this.telegram.send(id, 'Cancelled. Active details cleared.'+(this.saves?' Encrypted saved copies remain available through /save.':'')+' Send /start for the menu.');
    }
    if (command === '/start' || command === '/menu') return this.menu(id);
    if (command === '/otr') {
      if (!this.enableOtr) return this.telegram.send(id, 'OTR is disabled pending testing. Password recovery remains available from /menu.');
      return this.menu(id, true);
    }
    if (command === '/help') return this.telegram.send(id, '/test — bot receipt check (does not submit to portal)\n/menu — main menu\n/cancel — clear this active session\n/save — saved sessions and statuses\n/dsave [SESSION_ID] — save/retrieve registration\n/psave [SESSION_ID] — save/retrieve password recovery\n/reuse SESSION_ID — start a fresh session from saved fields\n/refresh — current CAPTCHA\n/retry — retry a failed page load\n/resend — request another OTP only when offered by the portal\n/result [SESSION_ID] — current result or saved OTNew-Poly PDF\n/boards — password recovery boards\n/search words, /next — search live dropdown options\n/edit — correct the current OTNew-Poly section\n/id — your Telegram user ID'+(this.access?.isAdmin(message.from.id)?'\n/admin — manage allowed users\n/log — activity history\n/save user ID — saved statuses for that user':''));
    let state = this.sessions.get(id);
    if (!state) return this.telegram.send(id, 'Send /start to choose a service.');
    state.updated = this.clock();
    if (state.module === 'menu') {
      if(/^4(?:\.|$)/.test(text)) return this.saves?this.saves.dashboard(id):this.telegram.send(id,'Saved sessions are unavailable.');
      if(/^5(?:\.|$)/.test(text)) {
        if(!this.enableFinal||!this.final) return this.telegram.send(id,'Form lock & Final Print is disabled.');
        state.module='final';return this.final.start(id);
      }
      if(/^3(?:\.|$)/.test(text)) {
        if(!this.enablePoly||!this.poly) return this.telegram.send(id,'OTNew-Poly is disabled pending live validation. Existing modules remain available.');
        state.module='poly';return this.poly.start(id);
      }
      if (/^1(?:\.|$)/.test(text)) {
        state.module = 'password';
        return this.recovery.handle({...message, text:'/start'});
      }
      if (/^2(?:\.|$)/.test(text)) {
        if (!this.enableOtr) return this.telegram.send(id, 'OTR is disabled pending testing. Choose 1 for password recovery.');
        return this.menu(id, true);
      }
      return this.telegram.send(id, 'Choose 1 for Password recovery, 2 for OTR, 3 for Form filling OTNew-Poly, 4 for saved sessions, or 5 for Form lock & Final Print.');
    }
    if (state.module === 'otr-menu') {
      if (/^back$/i.test(text)) return this.menu(id);
      if (/^[12](?:\.|$)/.test(text)) {
        if (text.startsWith('2')) {
          if (!this.registration) return this.telegram.send(id,'Scholarship registration is unavailable in this bot build. Use Back.');
          state.module = 'registration';
          return this.registration.start(id);
        }
        state.module = 'otr';
        return this.otr.start(id, 'recover');
      }
      return this.telegram.send(id, 'Choose 1 to Recover OTR, 2 for Scholarship registration using OTR, or Back.');
    }
    if (state.module === 'password') return this.recovery.handle(message);
    if (state.module === 'poly') return this.poly.handle(message);
    if (state.module === 'final') return this.final.handle(message);
    if (state.module === 'registration') return this.registration.handle(message);
    return this.otr.handle(message);
  }

  async adminCommand(message,command) {
    const id=message.chat.id;
    if (!this.access?.isAdmin(message.from.id)) {
      await this.activity?.record({event:'denied',userId:message.from.id,action:command,reason:'admin-only'});
      return this.telegram.send(id,'Only the admin can manage user access or view activity logs.');
    }
    if(command==='/log') return this.logCommand(message);
    if(command==='/admin') return this.telegram.send(id,'Admin commands:\n/adduser ID — allow a Telegram user\n/removeuser ID — revoke access and clear their active session\n/users — list allowed users\n/log — recent activity\n/log user ID — activity for one user\n/log export YYYY-MM-DD — download a daily log\nAsk each person to send /id to this bot.');
    if(command==='/users') {
      const users=this.access.list();
      const lines=[`Admin: ${this.access.adminId}`,`Allowed users: ${users.length}`,...users];
      for(let i=0;i<lines.length;i+=100) await this.telegram.send(id,lines.slice(i,i+100).join('\n'));
      return;
    }
    const args=message.text.trim().split(/\s+/);
    if(args.length!==2) return this.telegram.send(id,`Usage: ${command} 123456789`);
    try {
      const changed=await this.access.change(message.from.id,args[1],command==='/adduser');
      await this.activity?.record({event:'access_changed',userId:message.from.id,targetUserId:args[1],action:command==='/adduser'?'grant':'revoke',result:changed?'changed':'unchanged'});
      if(command==='/removeuser') await this.clear(Number(args[1]));
      return this.telegram.send(id,command==='/adduser'
        ? `User ${args[1]} ${changed?'now has access':'already has access'}. They can send /start.`
        : `User ${args[1]} ${changed?'was removed':'was not on the allowed list'}. Access is disabled.`);
    } catch(error) {
      await this.activity?.record({event:'access_changed',userId:message.from.id,action:command==='/adduser'?'grant':'revoke',result:'failed'});
      return this.telegram.send(id,error.message);
    }
  }

  async logCommand(message) {
    const id=message.chat.id;
    if(!this.activity) return this.telegram.send(id,'Activity logging is unavailable in this bot build.');
    const args=message.text.trim().split(/\s+/).slice(1);
    const usage='Admin activity logs (IST):\n/log — latest 20 entries\n/log 50 — latest 50 (maximum 100)\n/log user ID [count] — filter by actor or affected user\n/log export YYYY-MM-DD — download one day\nLogs contain actions and outcomes, not message text or submitted values.';
    if(args[0]==='help') return this.telegram.send(id,usage);
    let records,file,userId,limit=20;
    try {
      if(args[0]==='export' && args.length===2) file=await this.activity.exportDay(args[1]);
      else {
        if(args[0]==='user' && [2,3].includes(args.length)) {userId=telegramUserId(args[1]);if(args[2]) limit=Number(args[2]);}
        else if(args.length===1 && /^\d+$/.test(args[0])) limit=Number(args[0]);
        else if(args.length) throw new Error('Invalid log command.');
        records=await this.activity.recent({userId,limit});
      }
    } catch {
      await this.activity.record({event:'system_error',userId:message.from.id,action:'/log',reason:'invalid-arguments'});
      return this.telegram.send(id,'Could not read that log. Check the date, user ID and count; the file may be missing or unavailable. Daily downloads are limited to 20 MB.\n'+usage);
    }
    const warning=(this.activity.hadWriteFailure?'\nWarning: a log write failed during this run; history may be incomplete.':'')+(this.activity.hadReadFailure?'\nWarning: damaged or incomplete entries were skipped.':'');
    if(file) {
      await this.telegram.document(id,file.bytes,file.filename,'Daily activity log. Dates use IST; JSON timestamps use UTC. Submitted values are excluded.'+warning);
      await this.activity.record({event:'log_exported',userId:message.from.id,action:'/log'});return;
    }
    const lines=[`Activity log — newest first (IST)${userId?` — User ${userId}`:''}${warning}`,...records.map(formatActivity)];
    if(!records.length) lines.push('No recorded activity for this filter.');
    lines.push('/log help — filters and download commands');
    let chunk='';
    for(const line of lines) {
      if(chunk.length+line.length+1>3500) {await this.telegram.send(id,chunk);chunk='';}
      chunk+=(chunk?'\n':'')+line;
    }
    if(chunk) await this.telegram.send(id,chunk);
    await this.activity.record({event:'log_viewed',userId:message.from.id,targetUserId:userId,action:'/log'});
  }
}
