import {timingSafeEqual} from 'node:crypto';

export function createWebhookHandler({secret, onUpdate, isReady = () => true, onError = () => {}, onReceipt = () => {}, onMalformed = () => {}}) {
  const expected = Buffer.from(secret);
  const seen = new Set();
  let queue = Promise.resolve();
  const notify = (callback, value) => { Promise.resolve().then(() => callback(value)).catch(() => {}); };
  return async (request, response) => {
    const json = (status, body) => {response.writeHead(status, {'Content-Type':'application/json'});response.end(JSON.stringify(body));};
    const reject = (status, code) => {
      notify(onMalformed, {code, httpStatus:status});
      return json(status, {ok:false,error:{code,message:'Request rejected. No portal action was performed.'}});
    };
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && ['/', '/healthz'].includes(pathname)) {
      response.writeHead(isReady() ? 200 : 503, {'Content-Type':'application/json'});
      return response.end(JSON.stringify({service:'telespark', ready:isReady()}));
    }
    if (pathname !== '/telegram' || request.method !== 'POST') {
      response.writeHead(404); return response.end();
    }
    const suppliedHeader = request.headers['x-telegram-bot-api-secret-token'];
    const supplied = Buffer.from(typeof suppliedHeader === 'string' ? suppliedHeader : '');
    if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401); return response.end();
    }
    if (!isReady()) { response.writeHead(503); return response.end(); }
    try {
      let size = 0;
      const parts = [];
      for await (const part of request) {
        size += part.length;
        if (size > 128 * 1024) { reject(413,'PAYLOAD_TOO_LARGE'); request.resume(); return; }
        parts.push(part);
      }
      let update;
      try { update = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { return reject(400,'INVALID_JSON'); }
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
        return reject(400,'INVALID_UPDATE');
      }
      if (update.message !== undefined && (!Number.isSafeInteger(update.message?.message_id) || update.message.message_id < 1 || !Number.isSafeInteger(update.message?.chat?.id) || !Number.isSafeInteger(update.message?.from?.id))) return reject(400,'INVALID_MESSAGE');
      const duplicate = seen.has(update.update_id);
      if (!duplicate) {
        seen.add(update.update_id);
        if (seen.size > 2000) seen.delete(seen.values().next().value);
        // Queue in delivery order and acknowledge promptly. Never retry a recovery submission.
        queue = queue.then(() => onUpdate(update)).catch(() => onError());
      }
      notify(onReceipt, {httpStatus:200,duplicate});
      return json(200,{ok:true,status:'200 OK',duplicate,processed:false,message:duplicate?'Duplicate ignored.':'Received for processing; portal success is not yet confirmed.'});
    } catch {
      if (!response.headersSent) return reject(400,'INVALID_REQUEST');
      response.end();
    }
  };
}
