import {createServer} from 'node:net';
import {createHash} from 'node:crypto';

// OS-owned listener is released even on process crash. Token itself is never stored.
export async function acquireInstanceLock(token) {
  const digest=createHash('sha256').update(token).digest('hex');
  const address=process.platform==='win32'
    ? '\\\\.\\pipe\\telespark-'+digest.slice(0,32)
    : {host:'127.0.0.1',port:49152+parseInt(digest.slice(0,4),16)%16384};
  const server=createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{
    server.once('error',()=>reject(Error('Another local bot instance is already running, or its instance lock is unavailable. Stop the existing bot before starting another.')));
    server.listen(address,resolve);
  });
  server.unref();
  return ()=>new Promise(resolve=>server.close(()=>resolve()));
}
