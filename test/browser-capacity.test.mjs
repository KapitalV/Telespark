import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {BrowserCapacity,limitPortal} from '../browser-capacity.mjs';
import {PollingDispatch} from '../polling-dispatch.mjs';
import {BotRouter} from '../router.mjs';

const fake=()=>{const portal={launch:async()=>{const b=new EventEmitter();b.close=async()=>b.emit('disconnected');return b},async open(){this.browser=await this.launch({});return this.browser},async close(){await this.browser?.close()}};return portal};
test('Shared capacity caps concurrent browsers, FIFO queue advances after closure and leases release once',async()=>{
  const pool=new BrowserCapacity({limit:2});const a=limitPortal(fake(),pool),b=limitPortal(fake(),pool),c=limitPortal(fake(),pool),d=limitPortal(fake(),pool);
  await a.open();await b.open();const order=[];const pc=c.open().then(()=>order.push('c')),pd=d.open().then(()=>order.push('d'));
  assert.equal(pool.active,2);assert.equal(pool.queue.length,2);
  await a.close();await pc;assert.deepEqual(order,['c']);assert.equal(pool.active,2);
  await a.close();assert.equal(pool.active,2);await b.close();await pd;assert.deepEqual(order,['c','d']);
  await c.close();await d.close();assert.equal(pool.active,0);
});
test('Queue bounds, timeouts, cancellation and shutdown never launch abandoned browsers',async()=>{
  const pool=new BrowserCapacity({limit:1,maxQueue:1,waitMs:30});const first=await pool.acquire();
  const waiting=pool.acquire({owner:42});const rejection=assert.rejects(waiting);
  await assert.rejects(pool.acquire(),/full/);pool.cancelQueued(42);await rejection;
  await assert.rejects(pool.acquire(),/timed out/);assert.equal(pool.queue.length,0);
  const last=pool.acquire();const lastRejected=assert.rejects(last);pool.stop();await lastRejected;
  first();assert.equal(pool.active,0);await assert.rejects(pool.acquire());
});
test('Launch failures, close during launch and browser crashes release capacity',async()=>{
  const pool=new BrowserCapacity({limit:1});const broken=limitPortal({...fake(),launch:async()=>{throw Error('synthetic failure')}},pool);
  await assert.rejects(broken.open());assert.equal(pool.active,0);
  let resolve;const original=fake();original.launch=()=>new Promise(r=>{resolve=r});const slow=limitPortal(original,pool);
  const opening=slow.open();const rejected=assert.rejects(opening);await delay(0);await slow.close();
  const browser=new EventEmitter();let closed=false;browser.close=async()=>{closed=true;browser.emit('disconnected')};resolve(browser);await rejected;
  assert.equal(closed,true);assert.equal(pool.active,0);
  const active=limitPortal(fake(),pool);const running=await active.open();running.emit('disconnected');assert.equal(pool.active,0);await active.close();assert.equal(pool.active,0);
});
test('A cancelled queued portal cannot launch after a slot becomes free',async()=>{
  const pool=new BrowserCapacity({limit:1}),first=await pool.acquire();let launches=0;
  const queued=limitPortal({...fake(),launch:async()=>{launches++;throw Error('Should not launch')}},pool);
  const opening=queued.open();const rejected=assert.rejects(opening);await queued.close();await rejected;first();assert.equal(launches,0);
});
test('Polling dispatch allows another chat to release a browser while first chat queues; router preserves each chat order',async()=>{
  const pool=new BrowserCapacity({limit:1}),release=await pool.acquire();const router=new BotRouter({});const order=[];
  router.route=async m=>{order.push('start'+m.message_id);if(m.message_id===1){const lease=await pool.acquire();lease()}if(m.message_id===3)release();order.push('end'+m.message_id)};
  const dispatcher=new PollingDispatch({handle:m=>router.handle(m)});
  const message=(id,n)=>({chat:{id,type:'private'},from:{id},message_id:n});
  dispatcher.submit(message(42,1));dispatcher.submit(message(42,2));dispatcher.submit(message(43,3));await dispatcher.drain();
  assert.ok(order.indexOf('end3')<order.indexOf('end1'));assert.ok(order.indexOf('end1')<order.indexOf('start2'));assert.equal(pool.active,0);
});
test('Polling dispatch bounds memory, handles failures and stops accepting new messages',async()=>{
  let release;const wait=new Promise(r=>{release=r});let errors=0;
  const dispatcher=new PollingDispatch({maxPending:2,maxPerChat:1,handle:async m=>{await wait;if(m.chat.id===2)throw Error('fail')},onError:()=>{errors++}});
  assert.equal(dispatcher.submit({chat:{id:1}}),true);assert.equal(dispatcher.submit({chat:{id:1}}),false);
  assert.equal(dispatcher.submit({chat:{id:2}}),true);assert.equal(dispatcher.submit({chat:{id:3}}),false);
  dispatcher.stop();release();await dispatcher.drain();assert.equal(errors,1);assert.equal(dispatcher.pending.size,0);assert.equal(dispatcher.counts.size,0);assert.equal(dispatcher.submit({chat:{id:3}}),false);
});
