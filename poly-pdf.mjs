// Parsing is local only; no PDF contents or identifiers are logged.
export const PORTAL_PRINT_ERROR=/System\.(?:ArgumentException|NullReferenceException|Data\.[A-Za-z]+Exception)|Server Error in|Some Error Occurred|Your Request Could Not Be Processed/i;
async function readPdf(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>16*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-') throw Error('Invalid check-print PDF.');
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true,verbosity:0});
  let document;
  try {
    document=await task.promise;
    if(document.numPages<1||document.numPages>30) throw Error('Unexpected PDF page count.');
    const pages=[];
    for(let i=1;i<=document.numPages;i++) {
      const page=await document.getPage(i),content=await page.getTextContent();
      const text=content.items.map(x=>x.str||'').join(' ');pages.push(text);
      if(text.trim().length<10) throw Error('Unreadable PDF page.');
    }
    const text=pages.join('\n');
    return {pages:document.numPages,text};
  } finally {if(document) await document.destroy();else await task.destroy();}
}
export async function validatePolyPdf(bytes,registration) {
  const result=await readPdf(bytes);
  if(!result.text.replaceAll(/\s/g,'').includes(registration)||PORTAL_PRINT_ERROR.test(result.text)||/ERR_CONNECTION/i.test(result.text)) throw Error('Check-print PDF identity or content failed validation.');
  return {pages:result.pages};
}
export async function validatePortalErrorPdf(bytes) {
  const result=await readPdf(bytes);
  if(!PORTAL_PRINT_ERROR.test(result.text)) throw Error('Expected an incomplete portal-error printout.');
  return {pages:result.pages};
}
