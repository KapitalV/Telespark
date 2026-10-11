// Text reply keyboards keep polling and webhook transports message-only.
export class BotRouter {
  constructor({telegram, recovery, otr, registration, access, allowedUserId = '', enableOtr = false, clock = () => Date.now()}) {
    Object.assign(this, {telegram, recovery, otr, registration, access, allowedUserId:String(allowedUserId), enableOtr, clock});
    this.sessions = new Map();
    this.lastMessages = new Map();
    this.locks = new Map();
  }

  handle(message) {
    if (!message?.from || message.from.is_bot || message.chat?.type !== 'private' || !message.text) return Promise.resolve();
    // Serialize even when called outside the polling/webhook queues.
    const id = message.chat.id;
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.route(message));
    this.locks.set(id, next);
    return next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); });
  }

  async clear(id) {
    this.sessions.delete(id);
    await Promise.all([this.recovery.clear(id), this.otr.clear(id), this.registration?.clear(id)]);
  }

  async expire() {
    await Promise.all([this.recovery.expire(), this.otr.expire(), this.registration?.expire()]);
    for (const [id, state] of this.sessions) {
      if (this.clock() - state.updated > 20 * 60_000) await this.clear(id);
    }
  }

  async menu(id, submenu = false) {
    await this.clear(id);
    this.sessions.set(id, {module:submenu ? 'otr-menu' : 'menu', updated:this.clock()});
    const rows = submenu ? [['1. Recover OTR'], ['2. Scholarship registration using OTR'], ['Back']] : [['1. Password recovery'], ['2. OTR']];
    return this.telegram.send(id, submenu ? 'OTR — recover your number or register a fresh scholarship application using an existing OTR.' : 'UP Scholarship — choose an option.', {
      reply_markup:{keyboard:rows, resize_keyboard:true, one_time_keyboard:true},
    });
  }

  async route(message) {
    const id = message.chat.id;
    const text = message.text.trim();
    const command = text.split(/\s/)[0].toLowerCase();
    if (command === '/id') return this.recovery.handle(message);
    if (!(this.access ? this.access.canUse(message.from.id) : this.allowedUserId && String(message.from.id)===this.allowedUserId)) {
      return this.telegram.send(id, 'Access is restricted. Send /id and ask the admin to add that user ID.');
    }
    if (!Number.isSafeInteger(message.message_id) || message.message_id <= (this.lastMessages.get(id) ?? -1)) return;
    this.lastMessages.set(id, message.message_id);
    if (['/adduser','/removeuser','/users','/admin'].includes(command)) return this.adminCommand(message,command);
    await this.expire();
    if (command === '/cancel') {
      await this.clear(id);
      return this.telegram.send(id, 'Cancelled. Details cleared. Send /start for the menu.');
    }
    if (command === '/start' || command === '/menu') return this.menu(id);
    if (command === '/otr') {
      if (!this.enableOtr) return this.telegram.send(id, 'OTR is disabled pending testing. Password recovery remains available from /menu.');
      return this.menu(id, true);
    }
    if (command === '/help') return this.telegram.send(id, '/menu — main menu\n/cancel — clear this session\n/refresh — current CAPTCHA\n/retry — retry a failed page load\n/resend — request another OTP only when offered by the portal\n/result — resend a saved result or screenshot\n/boards — password recovery boards\n/search words, /next — registration institution search\n/id — your Telegram user ID'+(this.access?.isAdmin(message.from.id)?'\n/admin — manage allowed users':''));
    let state = this.sessions.get(id);
    if (!state) return this.telegram.send(id, 'Send /start to choose a service.');
    state.updated = this.clock();
    if (state.module === 'menu') {
      if (/^1(?:\.|$)/.test(text)) {
        state.module = 'password';
        return this.recovery.handle({...message, text:'/start'});
      }
      if (/^2(?:\.|$)/.test(text)) {
        if (!this.enableOtr) return this.telegram.send(id, 'OTR is disabled pending testing. Choose 1 for password recovery.');
        return this.menu(id, true);
      }
      return this.telegram.send(id, 'Choose 1 for Password recovery or 2 for OTR.');
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
    if (state.module === 'registration') return this.registration.handle(message);
    return this.otr.handle(message);
  }

  async adminCommand(message,command) {
    const id=message.chat.id;
    if (!this.access?.isAdmin(message.from.id)) return this.telegram.send(id,'Only the admin can manage user access.');
    if(command==='/admin') return this.telegram.send(id,'Admin commands:\n/adduser ID — allow a Telegram user\n/removeuser ID — revoke access and clear their active session\n/users — list allowed users\nAsk each person to send /id to this bot.');
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
      if(command==='/removeuser') await this.clear(Number(args[1]));
      return this.telegram.send(id,command==='/adduser'
        ? `User ${args[1]} ${changed?'now has access':'already has access'}. They can send /start.`
        : `User ${args[1]} ${changed?'was removed':'was not on the allowed list'}. Access is disabled.`);
    } catch(error) {return this.telegram.send(id,error.message);}
  }
}
