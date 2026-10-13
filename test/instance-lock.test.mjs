import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {acquireInstanceLock} from '../instance-lock.mjs';

test('Same-token local consumers cannot coexist; lock releases on shutdown',async()=>{
  const token='synthetic-'+randomUUID();
  const release=await acquireInstanceLock(token);
  try {await assert.rejects(acquireInstanceLock(token),/Another local bot instance/);}
  finally {await release();}
  const restart=await acquireInstanceLock(token);await restart();
});
