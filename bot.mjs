import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {RecoveryBot} from './core.mjs';
import {ScholarshipPortal} from './portal.mjs';
import {createWebhookHandler} from './webhook.mjs';
import {probePortal, probeConnection} from './probe.mjs';
import {BotRouter} from './router.mjs';
import {OtrBot} from './otr-core.mjs';
import {OtrPortal} from './otr-portal.mjs';
import {OtrRecoveryPortal} from './otr-recovery.mjs';
import {RegistrationBot} from './registration-core.mjs';
import {RegistrationPortal} from './registration-portal.mjs';
import {AccessStore} from './access.mjs';
import {ActivityLog,loggedPortal} from './activity.mjs';
import {SavedStore} from './saved-store.mjs';
import {SavedSessions} from './saved-sessions.mjs';
import {PolyBot} from './poly-core.mjs';
import {PolyPortal} from './poly-portal.mjs';

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
    if (!data.ok) throw Object.assign(new Error(`Telegram request failed (${data.error_code ?? response.status}).`),{telegramCode:data.error_code ?? response.status});
    return data.result;
  }
  send(chatId, text, options = {}) {
    return this.api('sendMessage', {chat_id:chatId,text,reply_markup:{remove_keyboard:true},...options,protect_content:false});
  }
  upload(method, field, chatId, bytes, filename, caption, options = {}) {
    const form = new FormData();
    form.set('chat_id',String(chatId));
    form.set(field,new Blob([bytes],{type:filename.endsWith('.pdf')?'application/pdf':filename.endsWith('.jsonl')?'application/x-ndjson':'image/png'}),filename);
    form.set('caption',caption);
    for (const [key,value] of Object.entries(options)) form.set(key,String(value));
    form.set('protect_content','false');
    return this.api(method,form,true);
  }
  photo(chatId, bytes, caption, options) { return this.upload('sendPhoto','photo',chatId,bytes,'Image.png',caption,options); }
  document(chatId, bytes, filename, caption, options) { return this.upload('sendDocument','document',chatId,bytes,filename,caption,options); }
}

const telegram = new Telegram();
let access;
try {access=new AccessStore({adminId:owner,path:process.env.ACCESS_STORE_PATH || undefined});await access.load();}
catch(error) {console.error(error.message);process.exit(1);}
const canUse=id=>access.canUse(id);
const activity=new ActivityLog({directory:process.env.ACTIVITY_LOG_DIR || undefined,onError:message=>console.error(message)});
try {
  await activity.init();
  if(!await activity.record({event:'bot_started',module:'system'})) throw new Error();
} catch {console.error('Cannot initialize activity logs. Check ACTIVITY_LOG_DIR and its write permissions.');process.exit(1);}
const savedStore=new SavedStore({directory:process.env.SAVED_SESSIONS_DIR || undefined,keyFile:process.env.SAVED_SESSION_KEY_FILE || undefined});
try {await savedStore.init();}
catch {console.error('Cannot initialize encrypted saved sessions. Check storage permissions and restore the original key if records already exist.');process.exit(1);}
const saves=new SavedSessions({store:savedStore,telegram,access,activity});
const recovery = new RecoveryBot({telegram, allowedUserId:owner,canUse,saves,
  onDiagnostic:event => console.log(JSON.stringify(event)),
  portalFactory:userId => loggedPortal(new ScholarshipPortal({
  onDiagnostic:event => console.log(JSON.stringify(event)),
  headless:process.env.HEADLESS !== 'false',
  channel:process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'),
}),activity,{userId,module:'password'})});
const otr = new OtrBot({telegram, allowedUserId:owner,canUse, portalFactory:(mode,userId) => loggedPortal(new (mode === 'recover' ? OtrRecoveryPortal : OtrPortal)({
  mode,
  onDiagnostic:event => console.log(JSON.stringify(event)),
  headless:process.env.HEADLESS !== 'false',
  channel:process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'),
}),activity,{userId,module:'otr'})});
const registration = new RegistrationBot({telegram,allowedUserId:owner,canUse,saves,portalFactory:userId=>loggedPortal(new RegistrationPortal({
  headless:process.env.HEADLESS !== 'false',
  channel:process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'),
}),activity,{userId,module:'registration'})});
const poly=new PolyBot({telegram,store:savedStore,canUse,activity,portalFactory:()=>new PolyPortal({headless:process.env.HEADLESS!=='false',channel:process.env.BROWSER_CHANNEL || (process.platform==='win32'?'msedge':'chromium')})});
const bot = new BotRouter({telegram, recovery, otr, registration, poly, access, activity, saves, allowedUserId:owner, enableOtr:process.env.ENABLE_OTR === 'true',enablePoly:process.env.ENABLE_OTNEW_POLY==='true'});
let lastMalformedAlert = -Infinity;
async function reportMalformed({httpStatus=400}={}) {
  await activity.record({event:'system_error',module:'system',action:'webhook',reason:'invalid-arguments',httpStatus});
  // Report metadata only, and avoid flooding the admin during repeated bad requests.
  if (owner && Date.now()-lastMalformedAlert >= 60_000) {
    lastMalformedAlert=Date.now();
    await telegram.send(owner,'Request rejected: malformed bot payload. No portal action was performed. Check /log for details.').catch(()=>{});
  }
}
// Expire sensitive in-memory sessions even when no webhook messages arrive.
const cleanupTimer = setInterval(() => { void bot.expire().catch(() => {}); }, 60_000);
cleanupTimer.unref();
let stopping = false;
let webhookServer;
async function shutdown() {
  stopping = true;
  clearInterval(cleanupTimer);
  webhookServer?.close();
  for (const chatId of bot.sessions.keys()) await bot.clear(chatId);
  await activity.record({event:'bot_stopped',module:'system'});
  process.exit(0);
}
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);

try {
  const mode = process.env.BOT_MODE || (process.env.RENDER_EXTERNAL_URL ? 'webhook' : 'polling');
  if (!['polling','webhook'].includes(mode)) throw new Error('BOT_MODE must be polling or webhook.');
  if (mode === 'webhook') {
    const base = new URL(process.env.WEBHOOK_BASE_URL || process.env.RENDER_EXTERNAL_URL || '');
    if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Webhook base URL must use HTTPS without embedded credentials.');
    const webhookURL = new URL('/telegram', base).href;
    const secret = createHmac('sha256',token).update('telespark-telegram-webhook-v1').digest('hex');
    let ready = false;
    const port = Number(process.env.PORT || '10000');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
    webhookServer = createServer(createWebhookHandler({
      secret,
      isReady:() => ready,
      onUpdate:async update => { await bot.handle(update.message); },
      onReceipt:({httpStatus,duplicate}) => activity.record({event:duplicate?'ignored':'message',module:'system',action:'webhook',httpStatus,...(duplicate?{reason:'duplicate'}:{})}),
      onMalformed:reportMalformed,
      onError:() => {console.error('Message delivery or processing failed. No automatic recovery resubmission was made.');void activity.record({event:'system_error',module:'system',action:'webhook',result:'failed'});},
    }));
    await new Promise((resolve,reject) => {
      webhookServer.once('error',reject);
      webhookServer.listen(port,'0.0.0.0',resolve);
    });
    const webhook = await telegram.api('getWebhookInfo',{});
    if (webhook.url && webhook.url !== webhookURL) throw new Error('This bot already has a webhook on another service. Confirm migration before replacing that connection.');
    const me = await telegram.api('getMe',{});
    await telegram.api('setWebhook',{
      url:webhookURL, secret_token:secret, max_connections:1, allowed_updates:['message'],
      // Keep pending updates: the message that wakes a sleeping service must not be discarded.
    });
    ready = true;
    await activity.record({event:'bot_ready',module:'system',action:'webhook'});
    console.log(`Connected to @${me.username}. ${owner ? 'Admin-managed user access enabled.' : 'Setup mode: send /id and configure your owner ID.'} Webhook mode ready.`);
    if (process.env.PORTAL_STARTUP_CHECK === 'true') {
      console.log(JSON.stringify(await probeConnection()));
      for (const applicationType of ['Renewal','Fresh']) {
        console.log(JSON.stringify({...await probePortal({headless:true,channel:process.env.BROWSER_CHANNEL || 'chromium',applicationType}),applicationType}));
      }
    }
  } else {
    const webhook = await telegram.api('getWebhookInfo',{});
    if (webhook.url) throw new Error('A webhook is configured for this token. Stop the cloud service and remove its webhook before switching to polling.');
    const me = await telegram.api('getMe',{});
    await activity.record({event:'bot_ready',module:'system',action:'polling'});
    console.log(`Connected to @${me.username}. ${owner ? 'Admin-managed user access enabled.' : 'Setup mode: send /id, set your owner ID, then restart.'}`);
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
    } catch (error) {
      const code = Number.isInteger(error?.telegramCode) ? error.telegramCode : undefined;
      await activity.record({event:'system_error',module:'system',action:'polling',reason:code===409?'polling-conflict':'network',httpStatus:code});
      console.error(code === 409
        ? 'Telegram polling conflict (409): another instance is using this bot token. Run only one bot instance.'
        : `Telegram polling interrupted${code ? ` (${code})` : ''}. Reconnecting in five seconds.`);
      await delay(5000);
    }
  }
  }
} catch (error) {
  await activity.record({event:'system_error',module:'system',result:'failed'});
  clearInterval(cleanupTimer);
  console.error(error.message);
  webhookServer?.close();
  process.exitCode = 1;
}
