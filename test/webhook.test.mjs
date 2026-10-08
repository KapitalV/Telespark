import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createWebhookHandler} from '../webhook.mjs';

async function fixture(t, options = {}) {
  const events = [];
  const server = createServer(createWebhookHandler({secret:'test-secret',onUpdate:async update => {events.push(update.update_id);},...options}));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, secret = 'test-secret') => fetch(`${base}/telegram`,{
    method:'POST',headers:{'Content-Type':'application/json','x-telegram-bot-api-secret-token':secret},body:typeof body === 'string' ? body : JSON.stringify(body),
  });
  return {events,post,base};
}

test('Public health endpoint exposes readiness without account data', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/healthz`);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{service:'telespark',ready:true});
});

test('Webhook rejects unauthenticated and malformed requests before processing', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({update_id:1},'wrong-secret')).status,401);
  assert.equal((await f.post('{broken json')).status,400);
  assert.equal((await f.post({message:{text:'/start'}})).status,400);
  assert.deepEqual(f.events,[]);
});

test('Repeated delivery of the same update is acknowledged but processed only once', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({update_id:1})).status,200);
  assert.equal((await f.post({update_id:1})).status,200);
  await delay(10);
  assert.deepEqual(f.events,[1]);
});

test('Updates are acknowledged promptly and processed in order even during slow browser actions', async t => {
  const order = [];
  let release;
  const waiting = new Promise(resolve => {release = resolve;});
  const f = await fixture(t,{onUpdate:async update => {
    order.push(`start-${update.update_id}`);
    if (update.update_id === 1) await waiting;
    order.push(`end-${update.update_id}`);
  }});
  assert.equal((await f.post({update_id:1})).status,200);
  assert.equal((await f.post({update_id:2})).status,200);
  assert.deepEqual(order,['start-1']);
  release(); await delay(10);
  assert.deepEqual(order,['start-1','end-1','start-2','end-2']);
});

test('Not-ready webhook returns retryable failure instead of accepting updates', async t => {
  const f = await fixture(t,{isReady:() => false});
  assert.equal((await fetch(`${f.base}/healthz`)).status,503);
  assert.equal((await f.post({update_id:1})).status,503);
  assert.deepEqual(f.events,[]);
});

test('Oversized requests cannot fill the update queue', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(JSON.stringify({update_id:1,text:'x'.repeat(140 * 1024)}))).status,413);
  assert.deepEqual(f.events,[]);
});
