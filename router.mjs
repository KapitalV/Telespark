// Text reply keyboards keep polling and webhook transports message-only.
export class BotRouter {
  constructor({telegram, recovery, otr, allowedUserId = '', enableOtr = false, clock = () => Date.now()}) {
    Object.assign(this, {telegram, recovery, otr, allowedUserId:String(allowedUserId), enableOtr, clock});
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
    await Promise.all([this.recovery.clear(id), this.otr.clear(id)]);
  }

  async expire() {
    await Promise.all([this.recovery.expire(), this.otr.expire()]);
    for (const [id, state] of this.sessions) {
      if (this.clock() - state.updated > 20 * 60_000) await this.clear(id);
    }
  }

  async menu(id, submenu = false) {
    await this.clear(id);
    this.sessions.set(id, {module:submenu ? 'otr-menu' : 'menu', updated:this.clock()});
    const rows = submenu ? [['1. Recover OTR'], ['2. Register OTR'], ['Back']] : [['1. Password recovery'], ['2. OTR']];
    return this.telegram.send(id, submenu ? 'OTR — choose an option. Registration is experimental and awaits your manual test.' : 'UP Scholarship — choose an option.', {
      reply_markup:{keyboard:rows, resize_keyboard:true, one_time_keyboard:true},
    });
  }

  async route(message) {
    const id = message.chat.id;
    const text = message.text.trim();
    const command = text.split(/\s/)[0].toLowerCase();
    if (command === '/id') return this.recovery.handle(message);
    if (!this.allowedUserId || String(message.from.id) !== this.allowedUserId) {
      return this.telegram.send(id, 'This bot is restricted to the configured owner. Send /id for setup.');
    }
    if (!Number.isSafeInteger(message.message_id) || message.message_id <= (this.lastMessages.get(id) ?? -1)) return;
    this.lastMessages.set(id, message.message_id);
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
    if (command === '/help') return this.telegram.send(id, '/menu — main menu\n/cancel — clear this session\n/refresh — current CAPTCHA\n/retry — retry a failed page load\n/resend — request another OTP only when offered by the portal\n/result — show a verified result\n/boards — password recovery boards\n/id — setup ID');
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
        state.module = 'otr';
        return this.otr.start(id, text.startsWith('1') ? 'recover' : 'register');
      }
      return this.telegram.send(id, 'Choose 1 to Recover OTR, 2 to Register OTR, or Back.');
    }
    if (state.module === 'password') return this.recovery.handle(message);
    return this.otr.handle(message);
  }
}
