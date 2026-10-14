import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {normalizePoly} from './poly-schema.mjs';

export const MAX_WORKBOOK_BYTES=2*1024*1024;
export const BATCH_HEADERS=['Candidate Name','Application Type','Registration Number','OTR Number'];
// Check declared ZIP expansion before handing uploaded data to the workbook parser.
export function validateWorkbookArchive(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length>MAX_WORKBOOK_BYTES||bytes.length<22)throw Error('Upload an .xlsx workbook no larger than 2 MB.');
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw Error('Invalid Excel workbook.');
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);
  if(!count||count>2000||start+size>end||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))throw Error('Unsupported workbook archive.');
  let offset=start,total=0,hasWorkbook=false;
  for(let n=0;n<count;n++) {
    if(offset+46>end||bytes.readUInt32LE(offset)!==0x02014b50)throw Error('Invalid workbook archive.');
    const nameLength=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32);
    total+=bytes.readUInt32LE(offset+24);
    if(total>16*1024*1024||bytes.readUInt16LE(offset+8)&1||offset+46+nameLength+extra+comment>end)throw Error('Workbook is encrypted or too complex.');
    const name=bytes.toString('utf8',offset+46,offset+46+nameLength);
    if(/vbaProject|externalLinks/i.test(name))throw Error('Use a plain .xlsx workbook without macros or external links.');
    hasWorkbook ||= name==='xl/workbook.xml';offset+=46+nameLength+extra+comment;
  }
  if(!hasWorkbook)throw Error('Invalid Excel workbook.');
}

export function parseCandidateRows(sheet) {
  if(!sheet||BATCH_HEADERS.some((h,i)=>sheet.getRow(1).getCell(i+1).value!==h))throw Error('Use the Candidates sheet and the four original template headers.');
  const rows=[],seen=new Set();
  sheet.eachRow({includeEmpty:false},(row,index)=>{
    if(index===1)return;
    const raw=[1,2,3,4].map(i=>row.getCell(i).value);
    const blank=v=>v===null||v===undefined||v==='';
    if([raw[0],raw[2],raw[3]].every(blank)&&(blank(raw[1])||raw[1]==='Fresh'))return;
    if(rows.length>=100)throw Error('Maximum 100 candidates per workbook.');
    // Keep malformed cell contents out of reports; a huge identifier must not
    // turn one invalid row into an over-limit Telegram message.
    const record={row:index,registration:typeof raw[2]==='string'&&/^\d{10,25}$/.test(raw[2].trim())?raw[2].trim():'',status:'pending'};
    rows.push(record);
    try {
      if(raw.some(v=>!blank(v)&&typeof v!=='string'))throw Error('Use text cells, not numbers or formulas.');
      const [name,type,registration,otr]=raw.map(v=>(v||'').trim());
      if(name.length>100)throw Error('Candidate name is too long.');
      const applicationType=type||'Fresh';if(!['Fresh','Renewal'].includes(applicationType))throw Error('Choose Fresh or Renewal.');
      record.registration=normalizePoly({type:'digits',key:'registration'},registration);
      record.otr=normalizePoly({type:'text',key:'otr'},otr);record.name=name;record.applicationType=applicationType;
      if(seen.has(record.registration)){record.status='duplicate';return;}
      seen.add(record.registration);
    } catch(error) {record.status='invalid';record.note=error.message;delete record.otr;}
  });
  if(!rows.length)throw Error('No candidates found. Fill the registration and OTR columns.');
  return rows;
}

export async function parseBatchWorkbook(bytes) {
  validateWorkbookArchive(bytes);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:bytes,resourceLimits:{maxOldGenerationSizeMb:128}});
    let finished=false;
    const finish=(error,rows)=>{if(finished)return;finished=true;clearTimeout(timer);void worker.terminate();error?reject(Error(error)):resolve(rows);};
    const timer=setTimeout(()=>finish('Workbook parsing timed out. Use the blank template.'),10000);
    worker.once('message',m=>finish(m.error,m.rows));worker.once('error',()=>finish('Could not read this workbook. Use the blank template.'));
    worker.once('exit',()=>{if(!finished)finish('Workbook parser stopped. Use the blank template.');});
  });
}
if(!isMainThread) {
  try {
    const {default:ExcelJS}=await import('exceljs');const workbook=new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(workerData),{ignoreNodes:['dataValidations','drawing','extLst','conditionalFormatting']});
    parentPort.postMessage({rows:parseCandidateRows(workbook.getWorksheet('Candidates'))});
  } catch(error) {parentPort.postMessage({error:/Maximum 100|Candidates sheet|No candidates/.test(error.message)?error.message:'Invalid workbook. Use the supplied template.'});}
}
