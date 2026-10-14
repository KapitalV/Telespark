export const documentMime=filename=>filename.endsWith('.pdf')?'application/pdf':filename.endsWith('.xlsx')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':filename.endsWith('.csv')?'text/csv':filename.endsWith('.jsonl')?'application/x-ndjson':'image/png';
export async function downloadTelegramFile({api,token,document,maxBytes,fetcher=fetch}) {
  if(!document?.file_id||!Number.isSafeInteger(document.file_size)||document.file_size<1||document.file_size>maxBytes)throw Error('Upload a workbook no larger than 2 MB.');
  const file=await api('getFile',{file_id:document.file_id});
  if(!file.file_path||!/^[a-zA-Z0-9_./-]+$/.test(file.file_path)||file.file_path.split('/').includes('..')||(file.file_size||0)>maxBytes)throw Error('Telegram file is unavailable.');
  let response;
  try {response=await fetcher(`https://api.telegram.org/file/bot${token}/${file.file_path}`,{signal:AbortSignal.timeout(20000),redirect:'error'});}catch {throw Error('Could not download the workbook. Try again.');}
  if(!response.ok||Number(response.headers.get('content-length'))>maxBytes)throw Error('Workbook download failed or exceeded 2 MB.');
  const chunks=[];let length=0;
  try {for await(const chunk of response.body){length+=chunk.length;if(length>maxBytes)throw Error('size');chunks.push(chunk);}}catch {throw Error('Workbook download failed or exceeded 2 MB.');}
  return Buffer.concat(chunks);
}
