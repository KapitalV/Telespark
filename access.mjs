import {readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

export function telegramUserId(value) {
  const id=String(value ?? '').trim();
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Use a positive numeric Telegram user ID. The user can get it with /id.');
  return id;
}

export class AccessStore {
  constructor({adminId='',path=resolve('data','authorized-users.json')}={}) {
    this.adminId=adminId ? telegramUserId(adminId) : '';
    this.path=path;
    this.users=new Set();
    this.queue=Promise.resolve();
  }
  async load() {
    let data;
    try {data=JSON.parse(await readFile(this.path,'utf8'));}
    catch(error) {if(error.code==='ENOENT') return; throw new Error('Cannot read the authorized-user file. Restore valid access data before starting.');}
    if(data?.version!==1 || !Array.isArray(data.users)) throw new Error('Invalid authorized-user file.');
    this.users=new Set(data.users.map(telegramUserId).filter(id=>id!==this.adminId));
  }
  isAdmin(id) {return !!this.adminId && String(id)===this.adminId;}
  canUse(id) {return !!this.adminId && (this.isAdmin(id) || this.users.has(String(id)));}
  list() {return [...this.users].sort((a,b)=>Number(a)-Number(b));}
  change(actor,id,add) {
    const operation=this.queue.catch(()=>{}).then(async()=>{
      if(!this.isAdmin(actor)) throw new Error('Only the admin can manage users.');
      id=telegramUserId(id);
      if(id===this.adminId) throw new Error('The configured admin already has access and cannot be removed.');
      const next=new Set(this.users);
      const changed=add ? !next.has(id) : next.has(id);
      if(!changed) return false;
      if(add) next.add(id);else next.delete(id);
      const temp=`${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path),{recursive:true,mode:0o700});
        await writeFile(temp,JSON.stringify({version:1,users:[...next]},null,2)+'\n',{mode:0o600,flag:'wx'});
        await rename(temp,this.path);
      } catch {
        await rm(temp,{force:true}).catch(()=>{});
        throw new Error('Could not save access changes. User permissions were not changed. Check the access-file directory.');
      }
      this.users=next;
      return true;
    });
    this.queue=operation;
    return operation;
  }
}
