import {mkdir,open,readdir,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve,join} from 'node:path';
import {telegramUserId} from './access.mjs';

// A closed vocabulary prevents submitted values, portal text and exception
// messages from becoming persistent logs, even if a caller passes extra keys.
export const LOG_COMMANDS=new Set(['/test','/start','/menu','/id','/help','/cancel','/otr','/boards','/retry','/refresh','/resend','/result','/search','/next','/adduser','/removeuser','/users','/admin','/log','/save','/dsave','/psave','/reuse','/edit']);
const vocabulary={
  event:new Set(['message','handled','denied','ignored','access_changed','session_expired','portal_started','portal_result','portal_error','bot_started','bot_ready','bot_stopped','system_error','log_viewed','log_exported','session_saved','session_viewed','session_reused','save_failed']),
  module:new Set(['system','menu','otr-menu','password','otr','registration','poly','none']),
  action:new Set([...LOG_COMMANDS,'answer','confirm','choose-password','choose-otr','choose-recovery','choose-registration','back','unknown-command','unsupported-message','open','submit','refresh','resend','grant','revoke','polling','webhook','login','choose','fill','pdf','home','edit','read','captcha','refreshLogin']),
  phase:new Set(['none','menu','otr-menu','questions','captcha','preparing','prepare-failed','correction','submitting','done','unknown','loading','load-failed','confirm','unsupported','blocked','save-required','poly-menu','login','login-captcha','record','edit']),
  field:new Set(['applicationType','registration','dob','mobile','board','year','roll','captcha','otp','consent','aadhaar','gender','name','choice','otr','prefix','password','password-confirm']),
  result:new Set(['success','response-image','result-image','form','captcha','correction','unknown','unsupported','resend-unavailable','completed','changed','unchanged','failed','field','review','record','pdf','dashboard','complete','expired','login-error','captcha-error']),
  stage:new Set(['academic','personal','bank','fee','income','caste','form','certificates']),
  reason:new Set(['access','admin-only','duplicate','unsupported-message','invalid-arguments','timeout','network','polling-conflict','storage','action','fields','page','dialog','external-verification','changed-form','changed-values','missing-field','refresh','otr-lookup','captcha','otp','already-registered','not-found','rate-limit','registration-mismatch']),
};

export function safeActivity(input,time=input.time) {
  if (!vocabulary.event.has(input.event) || typeof time!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString()!==time) throw new Error('Invalid activity record.');
  const record={version:1,time,event:input.event};
  for(const key of ['userId','targetUserId']) if(input[key]!==undefined) record[key]=telegramUserId(input[key]);
  for(const [key,values] of Object.entries(vocabulary)) if(key!=='event' && values.has(input[key])) record[key]=input[key];
  if(Number.isSafeInteger(input.messageId) && input.messageId>0) record.messageId=input.messageId;
  if(Number.isInteger(input.httpStatus) && input.httpStatus>=100 && input.httpStatus<=599) record.httpStatus=input.httpStatus;
  return record;
}

const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'});
const displayFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
export function activityDay(time) {
  const parts=Object.fromEntries(dayFormat.formatToParts(new Date(time)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validDay(day) {
  return typeof day==='string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day+'T00:00:00Z')) && new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
}

export class ActivityLog {
  constructor({directory=resolve('data','activity'),clock=()=>Date.now(),onError=()=>{},maxExportBytes=20*1024*1024}={}) {
    Object.assign(this,{directory:resolve(directory),clock,onError,maxExportBytes});
    this.queue=Promise.resolve();this.hadWriteFailure=false;this.hadReadFailure=false;this.checked=new Set();
  }
  async init() {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const handle=await this.openDay(activityDay(this.clock()));await handle.close();
  }
  async openDay(day) {
    const path=join(this.directory,`${day}.jsonl`);
    const handle=await open(path,'a+',0o600);
    try {
      if(!this.checked.has(day)) {
        const {size}=await handle.stat();
        if(size) {
          const tail=Buffer.alloc(1);await handle.read(tail,0,1,size-1);
          // Isolate an incomplete record left by a process/OS interruption.
          if(tail[0]!==10) {await handle.write('\n');this.hadReadFailure=true;}
        }
        this.checked.add(day);
      }
      return handle;
    } catch(error) {await handle.close();throw error;}
  }
  record(input) {
    // Project immediately; never retain a caller's raw object in the write queue.
    let record;
    try {record=safeActivity(input,new Date(this.clock()).toISOString());}
    catch {this.failed();return Promise.resolve(false);}
    const operation=this.queue.then(async()=>{
      let handle;
      try {
        handle=await this.openDay(activityDay(record.time));
        await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();return true;
      } catch {this.failed();return false;}
      finally {await handle?.close().catch(()=>{});}
    });
    this.queue=operation;return operation;
  }
  failed() {
    if(!this.hadWriteFailure) {try {this.onError('Activity log write failed; history may be incomplete.');} catch {}}
    this.hadWriteFailure=true;
  }
  async *entries(day) {
    if(!validDay(day)) throw new Error('Use a real date in YYYY-MM-DD format.');
    const path=join(this.directory,`${day}.jsonl`);
    if(!(await lstat(path)).isFile()) throw new Error('Activity file unavailable.');
    const stream=createReadStream(path,{encoding:'utf8'});
    const lines=createInterface({input:stream,crlfDelay:Infinity});
    try {
      for await (const line of lines) {
        if(!line.trim()) continue;
        let record;try {record=safeActivity(JSON.parse(line));} catch {this.hadReadFailure=true;continue;}
        yield record;
      }
    } finally {lines.close();stream.destroy();}
  }
  async recent({userId,limit=20}={}) {
    if(!Number.isInteger(limit) || limit<1 || limit>100) throw new Error('Choose a log count from 1 to 100.');
    if(userId!==undefined) userId=telegramUserId(userId);
    await this.queue;
    const days=(await readdir(this.directory,{withFileTypes:true})).filter(f=>f.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.name) && validDay(f.name.slice(0,10))).map(f=>f.name.slice(0,10)).sort().reverse();
    const result=[];
    for(const day of days) {
      const tail=[];
      for await(const entry of this.entries(day)) {
        if(userId && entry.userId!==userId && entry.targetUserId!==userId) continue;
        tail.push(entry);if(tail.length>limit-result.length) tail.shift();
      }
      result.push(...tail.reverse());if(result.length>=limit) break;
    }
    return result;
  }
  async exportDay(day) {
    if(!validDay(day)) throw new Error('Use a real date in YYYY-MM-DD format.');
    await this.queue;
    const chunks=[];let size=0;
    for await(const entry of this.entries(day)) {
      const line=JSON.stringify(entry)+'\n';size+=Buffer.byteLength(line);
      if(size>this.maxExportBytes) throw new Error('This day is too large to send in one file. Read the daily file on the server.');
      chunks.push(line);
    }
    if(!size) throw new Error('No recorded activity for that date.');
    return {bytes:Buffer.from(chunks.join('')),filename:`activity-${day}.jsonl`};
  }
}

export function formatActivity(entry) {
  return `${displayFormat.format(new Date(entry.time))} IST | ${entry.userId ? `User ${entry.userId}`:'System'} | ${[
    entry.module,entry.event.replaceAll('_',' '),entry.action,entry.field && `field:${entry.field}`,entry.phase && `stage:${entry.phase}`,entry.stage,entry.result,entry.reason && `reason:${entry.reason}`,entry.targetUserId && `target:${entry.targetUserId}`,entry.httpStatus && `HTTP ${entry.httpStatus}`,
  ].filter(Boolean).join(' | ')}`;
}

// Observe only fixed method names and classified results. Arguments, result
// values, screenshots and raw errors never enter the activity store.
export function loggedPortal(portal,activity,{userId,module}) {
  const methods=new Set(['open','submit','refresh','resend']);
  return new Proxy(portal,{get(target,key) {
    const value=Reflect.get(target,key,target);
    if(typeof value!=='function') return value;
    if(!methods.has(key)) return value.bind(target);
    return async (...args)=>{
      await activity.record({event:'portal_started',userId,module,action:key});
      try {
        const result=await value.apply(target,args);
        await activity.record({event:'portal_result',userId,module,action:key,result:Buffer.isBuffer(result)?'captcha':result?.kind || 'completed',reason:result?.reason || result?.error});
        return result;
      } catch(error) {
        await activity.record({event:'portal_error',userId,module,action:key,result:'failed',reason:error?.code==='TIMEOUT'?'timeout':undefined});
        throw error;
      }
    };
  }});
}
