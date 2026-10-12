// Explicit, optional transport smoke test. Does not consume Telegram updates or
// contact the scholarship portal. Only the configured admin receives the fixture.
import {readFile} from 'node:fs/promises';
import {validatePolyPdf} from '../poly-pdf.mjs';

async function main() {
  if(process.argv[2]!=='--send-to-admin'||!process.argv[3]) throw Error('Explicit --send-to-admin and synthetic PDF path are required.');
  const token=process.env.TELEGRAM_BOT_TOKEN?.trim(),id=process.env.TELEGRAM_ALLOWED_USER_ID?.trim();
  if(!/^\d+:[\w-]+$/.test(token||'')||!/^\d+$/.test(id||'')) throw Error('Bot configuration missing.');
  const bytes=await readFile(process.argv[3]);await validatePolyPdf(bytes,'000012345678');
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf=await getDocument({data:new Uint8Array(bytes),isEvalSupported:false,verbosity:0}).promise;
  try {const page=await pdf.getPage(1),text=(await page.getTextContent()).items.map(i=>i.str||'').join(' ');if(!text.includes('TEST FIXTURE - NOT AN APPLICATION')) throw Error('Only the synthetic fixture may be sent by this test.');} finally {await pdf.destroy();}
  const api=async(method,body,multipart=false)=>{
    const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:multipart?undefined:{'content-type':'application/json'},body:multipart?body:JSON.stringify(body),signal:AbortSignal.timeout(65000)});
    const data=await response.json();if(!data.ok) throw Error('Telegram request failed.');return data.result;
  };
  const chat=await api('getChat',{chat_id:id});if(chat.type!=='private'||String(chat.id)!==id) throw Error('Expected the configured admin private chat.');
  const form=new FormData();form.set('chat_id',id);form.set('document',new Blob([bytes],{type:'application/pdf'}),'OTNew-Poly-TEST.pdf');
  form.set('caption','OTNew-Poly PDF delivery TEST — synthetic data only. This is not your application. Your real check-print PDF is still pending the fresh-login portal check.');form.set('protect_content','false');
  const result=await api('sendDocument',form,true);
  if(result.document?.mime_type!=='application/pdf'||result.document?.file_size!==bytes.length) throw Error('Telegram document metadata did not match.');
  console.log(JSON.stringify({delivered:true,recipient:'configured admin private chat',filename:result.document.file_name,mimeType:result.document.mime_type,bytes:result.document.file_size}));
}
main().catch(()=>{console.error('Synthetic PDF delivery test did not complete. No portal request was made. Check bot configuration, private-chat availability and network.');process.exitCode=1;});
