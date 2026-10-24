// Shared browser leases across all modules. Queues contain no persisted data.
export class BrowserCapacity {
  constructor({limit=2,maxQueue=50,waitMs=20000}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>20||!Number.isInteger(maxQueue)||maxQueue<0||maxQueue>200||!Number.isInteger(waitMs)||waitMs<1||waitMs>120000)throw Error('Invalid browser capacity settings');
    Object.assign(this,{limit,maxQueue,waitMs});this.active=0;this.queue=[];this.stopped=false;
  }
  acquire({signal,onQueue=()=>{},owner}={}) {
    if(this.stopped||signal?.aborted)return Promise.reject(Error('Browser request cancelled'));
    if(this.active<this.limit){this.active++;return Promise.resolve(this.lease())}
    if(this.queue.length>=this.maxQueue)return Promise.reject(Error('Browser queue full'));
    return new Promise((resolve,reject)=>{
      const entry={owner,resolve,reject};
      const cancel=()=>{const index=this.queue.indexOf(entry);if(index<0)return;this.queue.splice(index,1);entry.clean();reject(Error('Browser request cancelled or timed out'))};
      const timer=setTimeout(cancel,this.waitMs);
      entry.clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel)};entry.cancel=cancel;
      signal?.addEventListener('abort',cancel,{once:true});this.queue.push(entry);
      Promise.resolve().then(()=>onQueue()).catch(()=>{});
    });
  }
  lease(){let released=false;return()=>{if(released)return;released=true;this.active--;this.drain()}}
  drain(){while(!this.stopped&&this.queue.length&&this.active<this.limit){const entry=this.queue.shift();entry.clean();this.active++;entry.resolve(this.lease())}}
  cancelQueued(owner){for(const entry of [...this.queue])if(entry.owner===owner)entry.cancel()}
  stop(){this.stopped=true;for(const entry of [...this.queue])entry.cancel()}
}

export function limitPortal(portal,capacity,{owner,onQueue}={}) {
  const launch=portal.launch,close=portal.close.bind(portal),controller=new AbortController();
  portal.launch=async options=>{
    const release=await capacity.acquire({signal:controller.signal,owner,onQueue});let browser;
    try {
      if(controller.signal.aborted)throw Error('Browser request cancelled');
      browser=await launch.call(portal,options);
      browser.once?.('disconnected',release);
      const browserClose=browser.close.bind(browser);
      browser.close=async(...args)=>{try{return await browserClose(...args)}finally{release()}};
      if(controller.signal.aborted){await browser.close();throw Error('Browser request cancelled')}
      return browser;
    }catch(error){if(!browser)release();throw error}
  };
  portal.close=async()=>{controller.abort();return close()};return portal;
}
