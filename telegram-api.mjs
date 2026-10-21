import {setTimeout as delay} from 'node:timers/promises';

const transientCodes = new Set([
  'ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNRESET','ECONNREFUSED',
  'EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT',
]);
const tlsCodes = new Set([
  'CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID',
]);

// Never retain raw fetch errors, URLs, response bodies or Telegram descriptions:
// they may include the bot token or a user's message.
class TelegramRequestError extends Error {
  constructor(message, {code, retryable=false, telegramCode, retryAfterMs}={}) {
    super(message);
    Object.assign(this, {code, retryable, telegramCode, retryAfterMs});
  }
}

function connectionError(error) {
  const errors = [error, error?.cause, ...(error?.cause?.errors || [])];
  if (errors.some(e => tlsCodes.has(e?.code))) {
    return new TelegramRequestError('Telegram TLS verification failed. Check the system clock and trusted certificates.', {code:'TLS_ERROR'});
  }
  const code = errors.map(e => e?.code).find(code => transientCodes.has(code))
    || (error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR');
  return new TelegramRequestError(`Telegram connection failed (${code}).`, {code, retryable:true});
}

function apiError(response, data) {
  const status = response.status;
  const suppliedCode = data?.error_code;
  const telegramCode = Number.isInteger(suppliedCode) && suppliedCode >= 400 && suppliedCode <= 599
    ? suppliedCode : status;
  const seconds = data?.parameters?.retry_after;
  const retryAfterMs = Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  const hint = telegramCode === 401 ? ' Check TELEGRAM_BOT_TOKEN in .env.'
    : telegramCode === 409 ? ' Another consumer or webhook is using this bot token.' : '';
  return new TelegramRequestError(`Telegram request failed (${telegramCode}).${hint}`, {
    code:`HTTP_${telegramCode}`, telegramCode, retryAfterMs,
    retryable:telegramCode === 429 || telegramCode >= 500,
  });
}

// Exactly one HTTP attempt. Sending messages/files and changing a webhook are
// deliberately not retried after an uncertain network response.
export async function telegramRequest({token, method, body, multipart=false, fetcher=fetch, timeoutMs=65_000}) {
  let response;
  let data;
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method:'POST',
      headers:multipart ? undefined : {'Content-Type':'application/json'},
      body:multipart ? body : JSON.stringify(body),
      signal:AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw connectionError(error);
  }
  try { data = await response.json(); }
  catch {
    if (!response.ok) throw apiError(response);
    throw new TelegramRequestError('Telegram returned an unreadable response.', {code:'UNREADABLE_RESPONSE', retryable:true});
  }
  if (!response.ok || data?.ok === false) throw apiError(response, data);
  if (data?.ok !== true || !Object.hasOwn(data, 'result')) {
    throw new TelegramRequestError('Telegram returned an unreadable response.', {code:'UNREADABLE_RESPONSE', retryable:true});
  }
  return data.result;
}

// Retry only startup reads. The fixed getUpdates snapshot discards old replies,
// just as the original startup did; no update is dispatched until it succeeds.
export async function startupTelegramRequest(api, method, body={}, {wait=delay, onRetry=()=>{}}={}) {
  const startupSnapshot = method === 'getUpdates' && body.offset === -1 &&
    body.limit === 1 && body.timeout === 0 &&
    Array.isArray(body.allowed_updates) && body.allowed_updates.length === 1 && body.allowed_updates[0] === 'message' &&
    Object.keys(body).length === 4;
  if (!['getMe','getWebhookInfo'].includes(method) && !startupSnapshot) {
    throw new Error('Only Telegram startup checks can be retried.');
  }
  const backoff = [1000, 2000, 5000, 10000];
  for (let attempt=1; attempt<=5; attempt++) {
    try { return await api(method, body, false, {timeoutMs:15_000}); }
    catch (error) {
      if (!(error instanceof TelegramRequestError) || !error.retryable) throw error;
      if (error.retryAfterMs > 30_000) {
        throw new Error(`Telegram startup rate limited. Wait at least ${Math.ceil(error.retryAfterMs/1000)} seconds before restarting.`);
      }
      if (attempt === 5) {
        throw new Error(`Telegram startup failed after 5 attempts (${error.code}). Check internet/DNS access to api.telegram.org, then run npm start again.`);
      }
      const delayMs = Math.max(backoff[attempt-1], error.retryAfterMs || 0);
      await onRetry({method, attempt, nextAttempt:attempt+1, maxAttempts:5, delayMs, code:error.code, telegramCode:error.telegramCode});
      await wait(delayMs);
    }
  }
}
