// Router retains per-chat ordering. This bounds work across chats without making
// other users wait for a slow browser or a queued browser lease.
export class PollingDispatch {
  constructor({handle,onError=()=>{},maxPending=200,maxPerChat=10}={}) {
    Object.assign(this,{handle,onError,maxPending,maxPerChat});this.pending=new Set();this.counts=new Map();this.stopped=false;
  }
  submit(message){
    if(this.stopped)return false;
    const id=message?.chat?.id;
    if(this.pending.size>=this.maxPending||(this.counts.get(id)||0)>=this.maxPerChat)return false;
    this.counts.set(id,(this.counts.get(id)||0)+1);
    const task=Promise.resolve().then(()=>this.handle(message)).catch(()=>this.onError()).catch(()=>{}).finally(()=>{
      this.pending.delete(task);const left=this.counts.get(id)-1;if(left)this.counts.set(id,left);else this.counts.delete(id);
    });this.pending.add(task);return true;
  }
  stop(){this.stopped=true}
  async drain(){await Promise.allSettled([...this.pending])}
}
