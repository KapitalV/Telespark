import {mkdir,readFile,readdir,open,rename,rm,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {telegramUserId} from './access.mjs';
import {projectFields,projectResult,SAVE_STATUS} from './saved-schema.mjs';

const idPattern=/^[RP]-[a-f0-9]{32}$/;
const failure=()=>new Error('Saved session unavailable. Check the session ID, owner and encrypted storage.');
export class SavedStore {
  constructor({directory=resolve('data','saved-sessions'),keyFile=resolve('data','private','saved-session.key'),clock=()=>Date.now()}={}) {
    Object.assign(this,{directory:resolve(directory),keyFile:resolve(keyFile),clock});this.queue=Promise.resolve();
  }
  async init() {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    try {this.key=await readFile(this.keyFile);}
    catch(error) {
      if(error.code!=='ENOENT') throw failure();
      if((await readdir(this.directory)).some(name=>name.endsWith('.enc'))) throw new Error('Saved-session key is missing. Restore the original key; existing records must not be overwritten.');
      await mkdir(dirname(this.keyFile),{recursive:true,mode:0o700});
      let handle;
      try {handle=await open(this.keyFile,'wx',0o600);this.key=randomBytes(32);await handle.writeFile(this.key);await handle.sync();}
      catch(error) {if(error.code!=='EEXIST') throw failure();this.key=await readFile(this.keyFile);}
      finally {await handle?.close();}
    }
    if(this.key.length!==32) throw new Error('Saved-session encryption key is invalid. Restore the original key.');
    // Authenticate existing files before allowing the bot to serve saved data.
    for(const name of await readdir(this.directory)) if(name.endsWith('.enc') && idPattern.test(name.slice(0,-4))) await this.read(name.slice(0,-4));
  }
  path(id) {if(!idPattern.test(id)) throw failure();return join(this.directory,id+'.enc');}
  serial(fn) {const next=this.queue.catch(()=>{}).then(fn);this.queue=next;return next;}
  async read(id) {
    try {
      const file=this.path(id);if((await stat(file)).size>36*1024*1024) throw failure();
      const envelope=JSON.parse(await readFile(file,'utf8'));
      if(envelope.version!==1) throw failure();
      const iv=Buffer.from(envelope.iv,'base64'),tag=Buffer.from(envelope.tag,'base64');
      if(iv.length!==12 || tag.length!==16) throw failure();
      const decrypt=createDecipheriv('aes-256-gcm',this.key,iv);
      decrypt.setAAD(Buffer.from('telespark/saved/v1/'+id));decrypt.setAuthTag(tag);
      const bytes=Buffer.concat([decrypt.update(Buffer.from(envelope.ciphertext,'base64')),decrypt.final()]);
      let value;try {value=JSON.parse(bytes.toString('utf8'));} finally {bytes.fill(0);}
      if(value.id!==id || !SAVE_STATUS[value.status] || !['registration','password'].includes(value.module)) throw failure();
      telegramUserId(value.userId);value.fields=projectFields(value.module,value.fields);value.result=projectResult(value.result);
      return value;
    } catch {throw failure();}
  }
  async write(record) {
    const file=this.path(record.id),temp=file+'.'+randomUUID()+'.tmp';let handle;
    try {
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
      cipher.setAAD(Buffer.from('telespark/saved/v1/'+record.id));
      const plain=Buffer.from(JSON.stringify(record));let ciphertext;
      try {ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);} finally {plain.fill(0);}
      handle=await open(temp,'wx',0o600);
      await handle.writeFile(JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
      await handle.sync();await handle.close();handle=undefined;await rename(temp,file);
    } catch {throw new Error('Could not save encrypted session. No new portal submission was authorized.');}
    finally {await handle?.close().catch(()=>{});await rm(temp,{force:true}).catch(()=>{});}
  }
  async get(id,userId) {
    await this.queue.catch(()=>{});const record=await this.read(id);
    if(record.userId!==telegramUserId(userId)) throw failure();return record;
  }
  save({id,userId,module,fields,ready=false}) {
    userId=telegramUserId(userId);fields=projectFields(module,fields);
    return this.serial(async()=>{
      const now=new Date(this.clock()).toISOString();
      let record;
      if(id) {
        record=await this.read(id);
        if(record.userId!==userId || record.module!==module || !['draft','ready'].includes(record.status)) throw failure();
      } else record={version:1,id:(module==='password'?'P-':'R-')+randomUUID().replaceAll('-',''),userId,module,createdAt:now,attempts:0};
      Object.assign(record,{fields,status:ready?'ready':'draft',updatedAt:now});
      await this.write(record);return record;
    });
  }
  begin(id,userId,fields) {
    return this.serial(async()=>{
      const record=await this.read(id);
      if(record.userId!==telegramUserId(userId) || record.status!=='ready' || JSON.stringify(record.fields)!==JSON.stringify(projectFields(record.module,fields))) throw failure();
      record.status='attempted';record.attempts++;record.updatedAt=new Date(this.clock()).toISOString();
      await this.write(record);return record;
    });
  }
  outcome(id,userId,{status,result}) {
    return this.serial(async()=>{
      const record=await this.read(id);
      if(record.userId!==telegramUserId(userId) || record.status!=='attempted' || !['ready','draft','confirmed','uncertain'].includes(status)) throw failure();
      record.status=status;record.result=projectResult(result);record.updatedAt=new Date(this.clock()).toISOString();
      await this.write(record);return record;
    });
  }
  async list({userId,module,page=1}={}) {
    await this.queue.catch(()=>{});if(userId!==undefined) userId=telegramUserId(userId);
    if(!Number.isSafeInteger(page) || page<1) throw failure();
    const records=[];
    for(const name of await readdir(this.directory)) {
      if(!name.endsWith('.enc') || !idPattern.test(name.slice(0,-4))) continue;
      const record=await this.read(name.slice(0,-4));
      if((userId && record.userId!==userId) || (module && record.module!==module)) continue;
      // Only status metadata crosses this boundary, including for admin lists.
      const {id,userId:owner,module:service,status,createdAt,updatedAt,attempts}=record;
      records.push({id,userId:owner,module:service,status,createdAt,updatedAt,attempts});
    }
    records.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
    return {total:records.length,page,records:records.slice((page-1)*10,page*10)};
  }
}
