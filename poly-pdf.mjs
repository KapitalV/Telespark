// Parsing is local only; no PDF contents or identifiers are logged.
export async function validatePolyPdf(bytes,registration) {
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
    if(!text.replaceAll(/\s/g,'').includes(registration)||/Some Error Occurred|Your Request Could Not Be Processed|ERR_CONNECTION/i.test(text)) throw Error('Check-print PDF identity or content failed validation.');
    return {pages:document.numPages};
  } finally {if(document) await document.destroy();else await task.destroy();}
}
