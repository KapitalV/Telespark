export const BOARDS = [
  'UP BOARD', 'CBSE', 'ICSE', 'National Institute of Open Schooling',
  'Jammu and Kashmir Board', 'Rajasthan Board', 'Himachal Pradesh Board',
  'Madhya Pradesh Board', 'Chhattisgarh Board', 'Punjab Board', 'Haryana Board',
  'Bihar Board', 'Gujarat Board', 'Maharashtra Board', 'Andhra Pradesh Board',
  'West Bengal Board', 'UP Sanskrit Board', 'Uttarakhand Board',
  'Jharkhand Academic Council', 'A M U Board', 'U.P. Madarsa Board',
  'Meghalaya Board of School of Education', 'Dayalbagh Educational Institute, Agra',
  'Tamil Nadu Board of Higher Secondary Education', 'Board of Secondary Education Assam',
  'Karanataka Secondary Education Examination Board', 'Dev Sanskriti Vishwavidyalaya Haridwar',
];

export const QUESTIONS = [
  ['applicationType', '1/6 — Application type: Fresh or Renewal?'],
  ['registration', '2/6 — Registration number? For Renewal, use the session required by the website (currently 2025–26).'],
  ['dob', '3/6 — Date of birth? Enter DD/MM/YYYY.'],
  ['board', '4/6 — Class 10 board? For example UP BOARD, CBSE, or ICSE. Use /boards for the full list.'],
  ['year', '5/6 — Class 10 passing year? Use the year recorded in your original scholarship application, not Class 12.'],
  ['roll', '6/6 — Class 10 roll number? Include any leading zeros.'],
];

export function normalizeAnswer(field, input) {
  const value = input.trim();
  if (field === 'applicationType') {
    const type = value.toLowerCase();
    if (!['fresh', 'renewal'].includes(type)) throw new Error('Please type Fresh or Renewal.');
    return type === 'fresh' ? 'Fresh' : 'Renewal';
  }
  if (field === 'registration' || field === 'roll') {
    if (!/^\d{4,25}$/.test(value)) throw new Error('Enter the number using digits only, keeping leading zeros.');
    return value;
  }
  if (field === 'dob') {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    if (!m) throw new Error('Use DD/MM/YYYY, for example 13/03/2006.');
    const [, dd, mm, yyyy] = m;
    const date = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
    if (date.getUTCFullYear() !== +yyyy || date.getUTCMonth() !== +mm - 1 || date.getUTCDate() !== +dd || +yyyy < 1900 || date > new Date()) {
      throw new Error('Enter a valid date of birth in DD/MM/YYYY.');
    }
    return value;
  }
  if (field === 'board') {
    const match = BOARDS.find(board => board.toLowerCase() === value.toLowerCase().replace(/^up$/, 'up board'));
    if (!match) throw new Error('Board not recognized. Use /boards and copy its exact name.');
    return match;
  }
  if (field === 'year') {
    if (!/^\d{4}$/.test(value) || +value < 1980 || +value > new Date().getFullYear()) throw new Error('Enter a valid four-digit Class 10 passing year.');
    return value;
  }
  throw new Error('Unknown field.');
}

export function parsePortalResult(url, text, expectedRegistration) {
  const location = new URL(url);
  if (location.origin !== 'https://scholarship.up.gov.in') return {kind:'unknown'};
  if (location.pathname.toLowerCase() === '/forgetpasswordprint.aspx') {
    const registration = /रजिस्ट्रेशन संख्या\s*:\s*(\d+)/u.exec(text)?.[1];
    const password = /पासवर्ड\s*\(इस नंबर को नोट करें\)\s*:\s*(\S+)/u.exec(text)?.[1];
    if (registration !== expectedRegistration || !password) return {kind:'unknown'};
    return {kind:'success', registration, password};
  }
  const compact = text.replace(/\s+/g, ' ');
  if (/invalid captcha/i.test(compact)) return {kind:'captcha', message:'The website rejected that CAPTCHA. Please type the new image carefully.'};
  if (/high school board year not matched/i.test(compact)) return {kind:'correction', field:'year', message:'The Class 10 passing year does not match. What year was entered in your original scholarship application?'};
  if (/high school (?:board )?roll (?:number|no).*not matched/i.test(compact)) return {kind:'correction', field:'roll', message:'The Class 10 roll number does not match. Send the correct number.'};
  if (/(?:date of birth|birth date|dob).*not matched/i.test(compact)) return {kind:'correction', field:'dob', message:'The date of birth does not match. Send the date recorded in your original application (DD/MM/YYYY).'};
  if (/high school board not matched/i.test(compact)) return {kind:'correction', field:'board', message:'The Class 10 board does not match. Send the board recorded in your original application.'};
  if (/registration (?:number|no).*not (?:matched|found)/i.test(compact)) return {kind:'correction', field:'registration', message:'The registration number does not match. Send the correct number for this application and session.'};
  return {kind:'unknown'};
}

export class RecoveryBot {
  constructor({telegram, portalFactory, allowedUserId = '', clock = () => Date.now(), prepareTimeoutMs = 75_000, onDiagnostic = () => {}}) {
    this.telegram = telegram;
    this.portalFactory = portalFactory;
    this.allowedUserId = String(allowedUserId);
    this.clock = clock;
    this.sessions = new Map();
    this.prepareTimeoutMs = prepareTimeoutMs;
    this.onDiagnostic = onDiagnostic;
  }

  async clear(chatId) {
    const state = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    await state?.portal?.close().catch(() => {});
  }

  async expire() {
    for (const [chatId, state] of this.sessions) {
      if (this.clock() - state.updated > 20 * 60_000) await this.clear(chatId);
    }
  }

  async handle(message) {
    if (!message?.from || message.from.is_bot || message.chat?.type !== 'private' || !message.text) return;
    const chatId = message.chat.id;
    const text = message.text.trim();
    const command = text.split(/\s/)[0].toLowerCase();
    const send = (value) => this.telegram.send(chatId, value);
    if (command === '/id') return send(`Your Telegram user ID: ${message.from.id}\nPut this in TELEGRAM_ALLOWED_USER_ID in .env, then restart the bot.`);
    if (!this.allowedUserId || String(message.from.id) !== this.allowedUserId) {
      return send('Recovery is restricted to the configured owner. Send /id to get your ID for setup.');
    }
    await this.expire();
    if (command === '/cancel') { await this.clear(chatId); return send('Cancelled. Send /start for a new recovery.'); }
    if (command === '/boards') return send(BOARDS.join('\n'));
    if (command === '/help') return send('/start — begin recovery\n/cancel — clear current details\n/retry — retry loading the form with your six answers\n/refresh — get a new CAPTCHA\n/boards — supported Class 10 boards\n/result — resend the completed result\n/id — your Telegram user ID');
    let state = this.sessions.get(chatId);
    if (command === '/start') {
      await this.clear(chatId);
      state = {phase:'questions', index:0, details:{}, updated:this.clock(), lastMessageId:message.message_id};
      this.sessions.set(chatId, state);
      await send('UP Scholarship postmatric recovery. I will ask six details, fill the official website, then show its CAPTCHA. Replying to the CAPTCHA submits recovery and may generate a replacement password. Your details and result travel through this private Telegram chat. /cancel stops.');
      return send(QUESTIONS[0][1]);
    }
    if (!state) return send('Send /start to begin.');
    if (message.message_id <= state.lastMessageId) return;
    state.lastMessageId = message.message_id;
    state.updated = this.clock();
    if (command === '/result' && state.result) return this.deliver(chatId, state);
    if (state.phase === 'done') return send('Recovery already succeeded. Use /result to show it again. /start begins a new recovery and may replace that password.');
    if (state.phase === 'unknown') return send('A submission was attempted but its outcome could not be verified. Check the official portal before starting another recovery.');
    if (command === '/refresh' && state.phase === 'captcha') return this.prepare(chatId, state);
    if (command === '/retry' && state.phase === 'prepare-failed') return this.prepare(chatId, state);
    if (state.phase === 'prepare-failed') return send('Your six answers are saved. Send /retry to load the form again, or /start to change the details.');
    if (text.startsWith('/')) return send('Use /help for commands.');
    if (state.phase === 'questions' || state.phase === 'correction') {
      const field = state.phase === 'correction' ? state.correction : QUESTIONS[state.index][0];
      try { state.details[field] = normalizeAnswer(field, text); }
      catch (error) { return send(error.message); }
      if (state.phase === 'questions') {
        state.index++;
        if (state.index < QUESTIONS.length) return send(QUESTIONS[state.index][1]);
      }
      return this.prepare(chatId, state);
    }
    if (state.phase !== 'captcha') return send('Please wait while the request completes.');
    if (!/^[A-Za-z0-9]{4,8}$/.test(text)) return send('Reply with only the CAPTCHA letters and digits, preserving uppercase and lowercase.');
    if (message.reply_to_message?.message_id && message.reply_to_message.message_id !== state.captchaMessageId) {
      return send('That is an older CAPTCHA. Reply to the latest image or use /refresh.');
    }
    if (message.date && (message.date + 1) * 1000 < state.captchaAt) {
      return send('That reply was sent before the current CAPTCHA. Read the latest image and reply again.');
    }
    if (this.clock() - state.captchaAt > 5 * 60_000) {
      await send('That CAPTCHA is old. I will show a fresh image; reply with its text.');
      return this.prepare(chatId, state);
    }
    // Never automatically repeat a recovery submission after a timeout or ambiguous response.
    state.phase = 'submitting';
    let result;
    try { result = await state.portal.submit(text); }
    catch { result = {kind:'unknown'}; }
    if (result.kind === 'success') {
      state.result = result;
      state.phase = 'done';
      await state.portal.close().catch(() => {});
      state.portal = undefined;
      state.details = {};
      return this.deliver(chatId, state);
    }
    if (result.kind === 'captcha') {
      await send(result.message);
      return this.prepare(chatId, state);
    }
    if (result.kind === 'correction') {
      state.phase = 'correction';
      state.correction = result.field;
      return send(result.message);
    }
    state.phase = 'unknown';
    await state.portal.close().catch(() => {});
    state.portal = undefined;
    return send('The request was submitted, but I could not verify success or a recognized error. Check the official portal before repeating it. I will not submit again automatically.');
  }

  async prepare(chatId, state) {
    state.phase = 'preparing';
    let timer;
    let stage = 'progress-message';
    try {
      await this.telegram.send(chatId, 'All six details received. Loading the official website and CAPTCHA; this may take up to 75 seconds.');
      state.portal ??= this.portalFactory();
      stage = 'form';
      const image = await Promise.race([
        state.portal.open(state.details),
        new Promise((_, reject) => { timer = setTimeout(() => {
          const error = new Error('Preparation deadline'); error.code = 'TIMEOUT'; reject(error);
        }, this.prepareTimeoutMs); }),
      ]);
      clearTimeout(timer);
      stage = 'telegram-image';
      const sent = await this.telegram.photo(chatId, image, 'Type the CAPTCHA exactly as shown. Your reply submits this recovery request. /refresh gives a new image; /cancel stops.');
      state.captchaMessageId = sent.message_id;
      state.captchaAt = this.clock();
      state.phase = 'captcha';
      this.onDiagnostic({event:'captcha-ready'});
    } catch (error) {
      state.phase = 'prepare-failed';
      const portal = state.portal;
      state.portal = undefined;
      // Cleanup must not prevent the user from receiving a failure message.
      void portal?.close().catch(() => {});
      const safeStage = ['browser','website','application-type','details','board','year','verify-fields','captcha'].includes(error.stage) ? error.stage : stage;
      const safeCode = /^(?:ERR_[A-Z_]+|TIMEOUT)$/.test(error.code ?? '') ? error.code : 'FAILED';
      this.onDiagnostic({event:'prepare-failed',stage:safeStage,code:safeCode});
      await this.telegram.send(chatId, `Could not prepare the CAPTCHA (${safeStage}/${safeCode}). No recovery was submitted. Your six answers are saved for 20 minutes. Send /retry to try again, /start to change them, or /cancel to clear them.`);
    } finally {
      clearTimeout(timer);
      state.updated = this.clock();
    }
  }

  async deliver(chatId, state) {
    const {registration, password, slip} = state.result;
    await this.telegram.send(chatId, `Recovery succeeded.\nRegistration: ${registration}\nLatest password: ${password}\nCase-sensitive. Use this latest result instead of an earlier password.`, {protect_content:true});
    if (slip) await this.telegram.document(chatId, slip, 'Recovery-slip.png', 'Your latest recovery slip.', {protect_content:true});
  }
}
