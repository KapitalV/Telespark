import {timingSafeEqual} from 'node:crypto';

export function createWebhookHandler({secret, onUpdate, isReady = () => true, onError = () => {}}) {
  const expected = Buffer.from(secret);
  const seen = new Set();
  let queue = Promise.resolve();
  return async (request, response) => {
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
        if (size > 128 * 1024) { response.writeHead(413); response.end(); request.resume(); return; }
        parts.push(part);
      }
      let update;
      try { update = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { response.writeHead(400); return response.end(); }
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
        response.writeHead(400); return response.end();
      }
      if (!seen.has(update.update_id)) {
        seen.add(update.update_id);
        if (seen.size > 2000) seen.delete(seen.values().next().value);
        // Queue in delivery order and acknowledge promptly. Never retry a recovery submission.
        queue = queue.then(() => onUpdate(update)).catch(() => onError());
      }
      response.writeHead(200); response.end('OK');
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  };
}
