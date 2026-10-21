import {test} from 'node:test';
import assert from 'node:assert/strict';
import {telegramRequest,startupTelegramRequest} from '../telegram-api.mjs';

const token = '123:synthetic-secret';
const json = (data,status=200) => Response.json(data,{status});
const network = code => Object.assign(new Error(`https://api.telegram.org/bot${token}/getMe private-content`),{
  cause:Object.assign(new Error('private-content'),{code}),
});
function fixture(responses) {
  const calls=[], retries=[], waits=[];
  const api = (method,body,multipart,options) => telegramRequest({
    token,method,body,multipart,...options,
    fetcher:async (url,request) => {
      calls.push({url,request});
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return {api,calls,retries,waits,options:{
    wait:async ms=>waits.push(ms),
    onRetry:event=>retries.push(event),
  }};
}

test('Startup recovers from connection timeout and DNS failure with bounded backoff',async()=>{
  const f=fixture([network('UND_ERR_CONNECT_TIMEOUT'),network('ENOTFOUND'),json({ok:true,result:{id:123}})]);
  assert.deepEqual(await startupTelegramRequest(f.api,'getMe',{},f.options),{id:123});
  assert.equal(f.calls.length,3);
  assert.deepEqual(f.waits,[1000,2000]);
  assert.deepEqual(f.retries.map(e=>e.code),['UND_ERR_CONNECT_TIMEOUT','ENOTFOUND']);
  assert.equal(f.calls[0].request.method,'POST');
  assert.equal(f.calls[0].request.body,'{}');
  assert.ok(f.calls[0].request.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(f.retries),/synthetic-secret|private-content|https:/);
});

test('Startup stops after five failures and only prints a safe diagnostic',async()=>{
  const f=fixture(Array.from({length:5},()=>network('ENOTFOUND')));
  await assert.rejects(startupTelegramRequest(f.api,'getWebhookInfo',{},f.options),error=>{
    assert.match(error.message,/after 5 attempts \(ENOTFOUND\)/);
    assert.doesNotMatch(error.stack+JSON.stringify(error),/synthetic-secret|private-content|bot123:/);
    return true;
  });
  assert.equal(f.calls.length,5);
  assert.deepEqual(f.waits,[1000,2000,5000,10000]);
});

test('Invalid token, access denial, webhook conflict and TLS failures are not retried',async()=>{
  for(const code of [400,401,403,404,409]){
    const f=fixture([json({ok:false,error_code:code,description:`private-content ${token}`},code)]);
    await assert.rejects(startupTelegramRequest(f.api,'getMe',{},f.options),error=>{
      assert.equal(error.telegramCode,code);
      assert.doesNotMatch(error.stack+JSON.stringify(error),/private-content|synthetic-secret/);
      if(code===401)assert.match(error.message,/TELEGRAM_BOT_TOKEN/);
      return true;
    });
    assert.equal(f.calls.length,1);
    assert.equal(f.waits.length,0);
  }
  const f=fixture([network('UNABLE_TO_VERIFY_LEAF_SIGNATURE')]);
  await assert.rejects(startupTelegramRequest(f.api,'getMe',{},f.options),/TLS verification failed/);
  assert.equal(f.waits.length,0);
});

test('Server errors and unreadable responses can recover on startup reads',async()=>{
  const f=fixture([
    new Response('private-content',{status:502}),
    new Response('private-content'),
    json({ok:true,result:{url:''}}),
  ]);
  assert.deepEqual(await startupTelegramRequest(f.api,'getWebhookInfo',{},f.options),{url:''});
  assert.deepEqual(f.retries.map(e=>e.code),['HTTP_502','UNREADABLE_RESPONSE']);
});

test('Rate limits respect retry_after; long cooldowns stop rather than retry early',async()=>{
  const f=fixture([json({ok:false,error_code:429,parameters:{retry_after:12}},429),json({ok:true,result:{id:123}})]);
  await startupTelegramRequest(f.api,'getMe',{},f.options);
  assert.deepEqual(f.waits,[12000]);
  const g=fixture([json({ok:false,error_code:429,parameters:{retry_after:120}},429)]);
  await assert.rejects(startupTelegramRequest(g.api,'getMe',{},g.options),/at least 120 seconds/);
  assert.equal(g.calls.length,1);
  assert.equal(g.waits.length,0);
});

test('Sending messages, uploads and webhook changes get one attempt only',async()=>{
  for(const method of ['sendMessage','sendPhoto','sendDocument','setWebhook','deleteWebhook']){
    const f=fixture([network('ECONNRESET')]);
    await assert.rejects(f.api(method,{},false),/ECONNRESET/);
    assert.equal(f.calls.length,1);
    await assert.rejects(startupTelegramRequest(f.api,method,{},f.options),/Only Telegram startup checks/);
    assert.equal(f.calls.length,1);
  }
});

test('Initial update snapshot retries identical parameters without dispatching updates',async()=>{
  const body={offset:-1,limit:1,timeout:0,allowed_updates:['message']};
  const updates=[{update_id:10,message:{text:'synthetic old reply'}}];
  const f=fixture([network('ECONNRESET'),json({ok:true,result:updates})]);
  assert.deepEqual(await startupTelegramRequest(f.api,'getUpdates',body,f.options),updates);
  assert.equal(f.calls[0].request.body,JSON.stringify(body));
  assert.equal(f.calls[1].request.body,f.calls[0].request.body);
  await assert.rejects(startupTelegramRequest(f.api,'getUpdates',{offset:11,timeout:30},f.options),/Only Telegram startup checks/);
  assert.equal(f.calls.length,2);
});

test('Unexpected network codes, nested aggregate failures and timeouts are sanitized',async()=>{
  for(const [error,expected] of [
    [network(`private-content ${token}`),'NETWORK_ERROR'],
    [Object.assign(new Error('private-content'),{name:'TimeoutError'}),'TIMEOUT'],
    [new TypeError('private-content',{cause:new AggregateError([Object.assign(new Error('private'),{code:'ENETUNREACH'})])}),'ENETUNREACH'],
  ]){
    const f=fixture([error]);
    await assert.rejects(f.api('getMe',{}),e=>{
      assert.equal(e.code,expected);
      assert.equal(e.cause,undefined);
      assert.doesNotMatch(e.stack+JSON.stringify(e),/private-content|synthetic-secret/);
      return true;
    });
  }
});

test('Successful multipart delivery preserves its body and is not JSON encoded',async()=>{
  const f=fixture([json({ok:true,result:{message_id:8}})]);
  const form=new FormData();
  form.set('chat_id','123');
  form.set('document',new Blob(['synthetic file']),'synthetic.txt');
  assert.deepEqual(await f.api('sendDocument',form,true),{message_id:8});
  assert.equal(f.calls[0].request.body,form);
  assert.equal(f.calls[0].request.headers,undefined);
});
