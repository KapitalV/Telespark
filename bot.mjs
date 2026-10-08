import {setTimeout as delay} from 'node:timers/promises';
import {RecoveryBot} from './core.mjs';
import {ScholarshipPortal} from './portal.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const owner = process.env.TELEGRAM_ALLOWED_USER_ID?.trim() ?? '';
if (!token || !/^\d+:[\w-]+$/.test(token)) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env using the token from @BotFather.');
  process.exit(1);
}
if (owner && !/^\d+$/.test(owner)) {
  console.error('TELEGRAM_ALLOWED_USER_ID must be your numeric Telegram user ID.');
  process.exit(1);
}

class Telegram {
  async api(method, body, multipart = false) {
    // Never print request URLs: they contain the bot token.
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method:'POST',
        headers: multipart ? undefined : {'Content-Type':'application/json'},
        body: multipart ? body : JSON.stringify(body),
        signal:AbortSignal.timeout(65_000),
      });
    } catch { throw new Error('Telegram connection failed.'); }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Telegram returned an unreadable response.'); }
    if (!data.ok) throw new Error(`Telegram request failed (${data.error_code ?? response.status}).`);
    return data.result;
  }
  send(chatId, text, options = {}) {
    return this.api('sendMessage', {chat_id:chatId,text,reply_markup:{remove_keyboard:true},...options});
  }
  upload(method, field, chatId, bytes, filename, caption, options = {}) {
    const form = new FormData();
    form.set('chat_id',String(chatId));
    form.set(field,new Blob([bytes],{type:'image/png'}),filename);
    form.set('caption',caption);
    for (const [key,value] of Object.entries(options)) form.set(key,String(value));
    return this.api(method,form,true);
  }
  photo(chatId, bytes, caption) { return this.upload('sendPhoto','photo',chatId,bytes,'Captcha.png',caption); }
  document(chatId, bytes, filename, caption, options) { return this.upload('sendDocument','document',chatId,bytes,filename,caption,options); }
}

const telegram = new Telegram();
const bot = new RecoveryBot({telegram, allowedUserId:owner, portalFactory:() => new ScholarshipPortal({
  headless:process.env.HEADLESS !== 'false',
  channel:process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'),
})});
let stopping = false;
async function shutdown() {
  stopping = true;
  for (const chatId of bot.sessions.keys()) await bot.clear(chatId);
  process.exit(0);
}
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);

try {
  const webhook = await telegram.api('getWebhookInfo',{});
  if (webhook.url) throw new Error('A webhook is already configured for this token. Use a new BotFather bot for this polling program.');
  const me = await telegram.api('getMe',{});
  console.log(`Connected to @${me.username}. ${owner ? 'Owner-only recovery enabled.' : 'Setup mode: send /id, set your owner ID, then restart.'}`);
  // Do not replay old CAPTCHA replies after restarting: a previous submission may have succeeded.
  const previous = await telegram.api('getUpdates',{offset:-1,limit:1,timeout:0,allowed_updates:['message']});
  let offset = previous.length ? previous[0].update_id + 1 : 0;
  while (!stopping) {
    try {
      const updates = await telegram.api('getUpdates',{offset,timeout:30,allowed_updates:['message']});
      for (const update of updates) {
        offset = update.update_id + 1;
        try { await bot.handle(update.message); }
        catch {
          // Keep result in memory for /result if Telegram delivery failed; never resubmit.
          console.error('An operation or message delivery failed. No automatic recovery resubmission was made.');
        }
      }
      await bot.expire();
    } catch {
      console.error('Telegram polling interrupted. Reconnecting in five seconds.');
      await delay(5000);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
