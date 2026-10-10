import {normalizeOtrAnswer} from './otr-schema.mjs';

const ERRORS = {
  captcha:'The website rejected or expired that CAPTCHA. Answer the current image.',
  otp:'The website rejected or expired that OTP. Enter the correct code; /resend requests a replacement only when available.',
  'already-registered':'The website reports an existing registration. Use Recover OTR instead of creating another OTR.',
  'not-found':'The website could not find a matching record. Check the registered mobile number.',
  'rate-limit':'The website has limited requests. Wait before trying again.',
};

export class OtrBot {
  constructor({telegram, portalFactory, allowedUserId = '', clock = () => Date.now(), timeoutMs = 75_000}) {
    Object.assign(this, {telegram, portalFactory, allowedUserId:String(allowedUserId), clock, timeoutMs});
    this.sessions = new Map();
  }

  async clear(id) {
    const state = this.sessions.get(id);
    this.sessions.delete(id);
    if (state) {
      state.values = {};
      state.result = state.step = undefined;
      const portal = state.portal;
      state.portal = undefined;
      // A hung browser close must not hold cancellation or idle cleanup hostage.
      void portal?.close().catch(() => {});
    }
  }

  async expire() {
    for (const [id, state] of this.sessions) {
      if (this.clock() - state.updated > 20 * 60_000) await this.clear(id);
    }
  }

  async start(id, mode) {
    await this.clear(id);
    const state = {mode,phase:'loading',values:{},updated:this.clock(),lastMessageId:-1};
    this.sessions.set(id, state);
    await this.telegram.send(id, `${mode === 'register' ? 'OTR registration — experimental.' : 'Recover OTR.'} I will ask for the fields shown on the official UP Scholarship website. Your answers and OTPs pass through this private Telegram chat to that website. Type CAPTCHA answers yourself. /cancel clears the session. Only one OTR is permitted per student.`);
    return this.open(id, state);
  }

  async operation(id, state, fn, {submission = false} = {}) {
    let timer;
    state.phase = 'loading';
    let step;
    try {
      step = await Promise.race([fn(), new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('OTR deadline')), this.timeoutMs);})]);
    } catch (error) {
      if (this.sessions.get(id) !== state) return;
      state.values = {};
      state.step = undefined;
      state.phase = submission ? 'unknown' : 'load-failed';
      const portal = state.portal;
      state.portal = undefined;
      void portal?.close().catch(() => {});
      const code = /^HTTP_[45]\d{2}$/.test(error?.code ?? '') ? ` (${error.code})` : '';
      return this.telegram.send(id, submission
        ? 'The website response could not be verified. The request may have completed. I will not repeat it. Check the official website or SMS before starting again with /menu.'
        : `Could not load the OTR page${code}. No OTP or registration was submitted by this action. Use /retry to start a new page session or /cancel.`);
    } finally {
      clearTimeout(timer);
      state.updated = this.clock();
    }
    if (this.sessions.get(id) !== state) return;
    // Keep delivery failures separate from portal failures. Retain verified
    // results so /result can deliver without repeating a portal submission.
    return this.apply(id, state, step);
  }

  async open(id, state) {
    await this.telegram.send(id, 'Loading the official OTR page; this can take up to 75 seconds.');
    return this.operation(id, state, () => {
      state.portal = this.portalFactory(state.mode);
      return state.portal.open();
    });
  }

  async stop(id, state, phase, message) {
    state.phase = phase;
    state.values = {};
    state.step = undefined;
    const portal = state.portal;
    state.portal = undefined;
    void portal?.close().catch(() => {});
    return this.telegram.send(id, message);
  }

  async apply(id, state, step) {
    if (step?.kind === 'unknown') return this.stop(id, state, 'unknown', 'The request outcome is uncertain. Check the official website or SMS before starting again. I will not repeat the submission.');
    if (step?.kind === 'success') {
      state.result = step.otr;
      state.phase = 'done';
      state.values = {};
      state.step = undefined;
      const portal = state.portal;
      state.portal = undefined;
      void portal?.close().catch(() => {});
      return this.deliver(id, state);
    }
    if (step?.kind !== 'form') return this.stop(id, state, 'unsupported', 'The portal reached an unrecognized form or an external verification step. Automation has stopped; no unknown form was submitted. This experimental stage needs verification before it can be supported. Check the official website or SMS for any completed request. Use /menu to return.');
    if (['already-registered','not-found','rate-limit'].includes(step.error)) return this.stop(id, state, 'blocked', `${ERRORS[step.error]} Use /menu when ready.`);
    state.step = step;
    state.phase = 'questions';
    state.index = 0;
    state.values = {};
    if (step.error) await this.telegram.send(id, ERRORS[step.error] ?? 'The website did not accept the details. Check them before continuing.');
    const actionText = {
      'send-otp':'After you answer these fields, I will request an SMS OTP.',
      'verify-otp':'After you answer these fields, I will submit the OTP for verification.',
      'verify-ekyc':'After you answer these fields, I will submit them for Aadhaar e-KYC verification.',
      register:'I will ask you to confirm before submitting final OTR registration.',
      consent:'Read the official declaration below before agreeing.',
    }[step.action.kind];
    await this.telegram.send(id, actionText);
    return this.prompt(id, state);
  }

  async prompt(id, state) {
    const field = state.step.fields[state.index];
    let sent;
    if (field.type === 'captcha') {
      if (!state.step.image) return this.stop(id, state, 'unsupported', 'The CAPTCHA image is unavailable. No submission made. Use /menu to start again.');
      sent = await this.telegram.photo(id, state.step.image, 'Reply with the CAPTCHA exactly as shown. Your reply continues this website step. /refresh gets a new image.');
      state.captchaAt = this.clock();
    } else {
      const options = field.options?.map((o,i) => `${i + 1}. ${o.label}`).join('\n');
      const suffix = field.type === 'consent' ? '\nType AGREE to accept, or /cancel.' : field.type === 'dob' ? '\nUse DD/MM/YYYY.' : field.type === 'otp' ? '\nEnter the OTP received on your phone, keeping any leading zeros.' : '';
      sent = await this.telegram.send(id, `${field.label}${suffix}${options ? `\n${options}` : ''}`);
    }
    state.promptId = sent.message_id;
    state.promptAt = this.clock();
  }

  async deliver(id, state) {
    return this.telegram.send(id, `The official website confirmed your OTR: ${state.result}\nKeep this number safely.`, {protect_content:true});
  }

  async handle(message) {
    if (!message?.from || message.from.is_bot || message.chat?.type !== 'private' || !message.text || !this.allowedUserId || String(message.from.id) !== this.allowedUserId) return;
    const id = message.chat.id;
    await this.expire();
    const state = this.sessions.get(id);
    if (!state) return this.telegram.send(id, 'The OTR session expired. Use /menu to begin again.');
    if (message.message_id <= state.lastMessageId) return;
    state.lastMessageId = message.message_id;
    state.updated = this.clock();
    const text = message.text.trim();
    const command = text.toLowerCase();
    if (command === '/cancel') { await this.clear(id); return this.telegram.send(id, 'Cancelled. Details cleared.'); }
    if (command === '/result' && state.result) return this.deliver(id, state);
    if (state.phase === 'done') return this.telegram.send(id, 'OTR already confirmed. /result shows it again; /menu returns to the menu.');
    if (['unknown','unsupported','blocked'].includes(state.phase)) return this.telegram.send(id, 'This session has stopped. Check the official website or SMS before beginning another request. Use /menu.');
    if (command === '/retry' && state.phase === 'load-failed') return this.open(id, state);
    if (state.phase === 'load-failed') return this.telegram.send(id, 'Use /retry to reopen the page or /cancel to clear the session.');
    if (state.phase === 'loading') return this.telegram.send(id, 'Please wait for the current website request.');
    if (command === '/retry' && state.phase === 'questions') return this.prompt(id, state);
    if (command === '/retry' && state.phase === 'confirm') return this.confirmRegistration(id, state);
    if (command === '/refresh') {
      if (!state.step.fields.some(f => f.type === 'captcha')) return this.telegram.send(id, 'This stage has no CAPTCHA to refresh.');
      return this.operation(id, state, () => state.portal.refresh(state.step.fingerprint));
    }
    if (command === '/resend') {
      if (state.step.stage !== 'otp') return this.telegram.send(id, 'OTP resend is available only during OTP verification.');
      if (this.clock() - (state.otpRequestedAt ?? 0) < 60_000) return this.telegram.send(id, 'Wait at least 60 seconds after the last OTP request. The website may require longer.');
      state.otpRequestedAt = this.clock();
      return this.operation(id, state, async () => {
        const step = await state.portal.resend();
        if (step.kind === 'resend-unavailable') return {...state.step,error:'otp'};
        return step;
      }, {submission:true});
    }
    if (text.startsWith('/')) return this.telegram.send(id, 'Use /menu, /cancel, /refresh, /resend, or /result where available.');
    if ((message.reply_to_message?.message_id && message.reply_to_message.message_id !== state.promptId) || (message.date && (message.date + 1) * 1000 < state.promptAt)) return this.telegram.send(id, 'That reply belongs to an older step. Answer the latest prompt.');
    if (state.phase === 'confirm') {
      if (command !== 'confirm') return this.telegram.send(id, 'Type CONFIRM to submit this final registration, or /cancel.');
      return this.submit(id, state);
    }
    const field = state.step.fields[state.index];
    if (field.type === 'captcha' && this.clock() - state.captchaAt > 5 * 60_000) {
      await this.telegram.send(id, 'That CAPTCHA is old. Loading a fresh image without submitting.');
      return this.operation(id, state, () => state.portal.refresh(state.step.fingerprint));
    }
    try { state.values[field.key] = normalizeOtrAnswer(field, text); }
    catch (error) { return this.telegram.send(id, error.message); }
    state.index++;
    if (state.index < state.step.fields.length) return this.prompt(id, state);
    if (state.step.action.kind === 'register') {
      state.phase = 'confirm';
      return this.confirmRegistration(id, state);
    }
    return this.submit(id, state);
  }

  async confirmRegistration(id, state) {
    const summary = state.step.fields.filter(f => !['captcha','otp','consent'].includes(f.type)).map(f => {
      const value = state.values[f.key];
      const display = ['aadhaar','mobile'].includes(f.type) ? `••••${value.slice(-4)}` : f.options?.find(o => o.value === value)?.label ?? value;
      return `${f.label}: ${display}`;
    }).join('\n');
    const sent = await this.telegram.send(id, `Review the final details:\n${summary}\nType CONFIRM to submit OTR registration, or /cancel. Only one OTR is permitted per student.`, {protect_content:true});
    state.promptId = sent.message_id;
    state.promptAt = this.clock();
  }

  async submit(id, state) {
    if (state.step.fields.some(f => f.type === 'captcha') && this.clock() - state.captchaAt > 5 * 60_000) {
      await this.telegram.send(id, 'The CAPTCHA expired while waiting. Refreshing this step without submitting.');
      return this.operation(id, state, () => state.portal.refresh(state.step.fingerprint));
    }
    const values = state.values;
    state.values = {};
    const fingerprint = state.step.fingerprint;
    if (state.step.action.kind === 'send-otp') state.otpRequestedAt = this.clock();
    try {
      return await this.operation(id, state, () => state.portal.submit(values, fingerprint), {submission:true});
    } finally {
      // Also erase on a timeout when the underlying browser promise is stuck.
      for (const key of Object.keys(values)) delete values[key];
    }
  }
}
