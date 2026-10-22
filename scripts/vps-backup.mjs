// Run as root with the bot stopped. Archives are authenticated with AES-256-GCM.
// The independent recovery key MUST be copied separately to protected off-host storage.
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import assert from 'node:assert/strict';

try {
  assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);
  const active=spawnSync('systemctl',['is-active','telespark'],{encoding:'utf8'});
  assert.notEqual(active.status,0,'Stop the bot before making a consistent backup');
  await mkdir('/root/telespark-backups',{mode:0o700});
}catch(error){if(error.code!=='EEXIST'){console.error('Backup precondition failed. Run as root with telespark stopped.');process.exit(1)}}
const keyPath='/root/telespark-backup.key';let key;
try {
  try {key=await readFile(keyPath)}catch(error){if(error.code!=='ENOENT')throw error;key=randomBytes(32);await writeFile(keyPath,key,{mode:0o600,flag:'wx'})}
  assert.equal(key.length,32);assert.equal((await stat(keyPath)).mode&0o077,0);
  const tar=spawnSync('tar',['-czf','-','-C','/','etc/telespark/bot.env','var/lib/telespark/data'],{maxBuffer:256*1024*1024});
  assert.equal(tar.status,0);
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(tar.stdout),cipher.final()]);
  const envelope=Buffer.concat([Buffer.from('TSPBK001'),iv,cipher.getAuthTag(),encrypted]);
  const path='/root/telespark-backups/'+new Date().toISOString().replaceAll(':','-')+'.aesgcm';
  await writeFile(path,envelope,{mode:0o600,flag:'wx'});
  const saved=await readFile(path),decrypt=createDecipheriv('aes-256-gcm',key,saved.subarray(8,20));decrypt.setAuthTag(saved.subarray(20,36));
  const restored=Buffer.concat([decrypt.update(saved.subarray(36)),decrypt.final()]);
  assert.equal(createHash('sha256').update(restored).digest('hex'),createHash('sha256').update(tar.stdout).digest('hex'));
  const check=spawnSync('tar',['-tzf','-'],{input:restored,maxBuffer:4*1024*1024});assert.equal(check.status,0);
  tar.stdout.fill(0);restored.fill(0);key.fill(0);
  console.log('Encrypted backup created and authenticated restore verified: '+path);
}catch{key?.fill(0);console.error('Encrypted backup failed; existing data and backups were not removed.');process.exitCode=1}
