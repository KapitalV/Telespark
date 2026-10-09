import {RecoveryBot} from '../core.mjs';
import {ScholarshipPortal} from '../portal.mjs';

// Live website check, with synthetic data and a local Telegram test adapter.
// Never submit a recovery or contact an actual Telegram chat.
for (const applicationType of ['Renewal','Fresh']) {
  let imageBytes = 0;
  let outgoingId = 0;
  const bot = new RecoveryBot({
    allowedUserId:'42',
    telegram:{
      send:async () => ({message_id:++outgoingId}),
      photo:async (_chat, bytes) => {imageBytes = bytes.length; return {message_id:++outgoingId};},
    },
    onDiagnostic:event => console.log(JSON.stringify({...event,applicationType})),
    portalFactory:() => {
      const portal = new ScholarshipPortal();
      portal.submit = async () => {throw new Error('This test must never submit recovery.');};
      return portal;
    },
  });
  try {
    let incomingId = 0;
    for (const text of ['/start',applicationType,'000000000000000',applicationType === 'Fresh' ? '0000000000' : '01/01/2000','UP BOARD','2021','000000000']) {
      await bot.handle({from:{id:42},chat:{id:42,type:'private'},message_id:++incomingId,text});
    }
    const phase = bot.sessions.get(42)?.phase;
    const ok = phase === 'captcha' && imageBytes > 0;
    console.log(JSON.stringify({applicationType,ok,phase,imageBytes,recoverySubmitted:false}));
    if (!ok) process.exitCode = 1;
  } finally {
    await bot.clear(42);
  }
}
