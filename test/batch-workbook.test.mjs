import {test} from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {readFile} from 'node:fs/promises';
import {parseBatchWorkbook,parseCandidateRows,validateWorkbookArchive,BATCH_HEADERS,MAX_WORKBOOK_BYTES} from '../batch-workbook.mjs';
import {documentMime,downloadTelegramFile} from '../telegram-files.mjs';

function sheet(rows=[]) {const w=new ExcelJS.Workbook(),s=w.addWorksheet('Candidates');s.addRow(BATCH_HEADERS);for(const row of rows)s.addRow(row);return {w,s};}
const row=(id='000000000001',type='Fresh')=>['',type,id,'UP26-0000000001'];
test('Workbook parsing preserves text identifiers, order, duplicates and row-level errors',async()=>{
  const {w}=sheet([row(),row(),row('000000000002','Renewal'),['','Fresh'],['','Fresh',12345678901,'UP26-0000000001'],['','Fresh',{formula:'1+1'},'UP26-0000000001'],row('000000000003','Invalid'),['','Fresh','000000000004','bad']]);
  const rows=await parseBatchWorkbook(Buffer.from(await w.xlsx.writeBuffer()));
  assert.deepEqual(rows.map(r=>r.status),['pending','duplicate','pending','invalid','invalid','invalid','invalid']);
  assert.equal(rows[0].registration,'000000000001');assert.equal(rows[2].applicationType,'Renewal');assert.equal(rows[3].row,6);
});
test('Workbook requires headers, valid archive and no more than 100 candidate rows',async()=>{
  const {s}=sheet(Array.from({length:100},(_,i)=>row(String(i).padStart(12,'0'))));
  assert.equal(parseCandidateRows(s).length,100);s.addRow(row());assert.throws(()=>parseCandidateRows(s),/100/);
  assert.throws(()=>parseCandidateRows(sheet([['','Fresh']]).s),/No candidates/);
  assert.throws(()=>parseCandidateRows(undefined),/Candidates/);
  const wrong=sheet([row()]);wrong.s.getCell('C1').value='Wrong';assert.throws(()=>parseCandidateRows(wrong.s),/headers/);
  await assert.rejects(parseBatchWorkbook(Buffer.from('invalid')));
  assert.throws(()=>validateWorkbookArchive(Buffer.alloc(MAX_WORKBOOK_BYTES+1)));
  const bytes=Buffer.from(await sheet([row()]).w.xlsx.writeBuffer());
  const directory=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(17*1024*1024,directory+24);
  assert.throws(()=>validateWorkbookArchive(bytes),/complex/);
});
test('Delivered template has one sheet, 100 Fresh rows, text identifiers and dropdown/frozen header',async()=>{
  const w=new ExcelJS.Workbook();await w.xlsx.load(await readFile(new URL('../assets/Final_Print_Batch_Template.xlsx',import.meta.url)));
  assert.equal(w.worksheets.length,1);const s=w.getWorksheet('Candidates');
  assert.deepEqual(s.getRow(1).values.slice(1,5),BATCH_HEADERS);
  for(let i=2;i<=101;i++) {assert.equal(s.getCell(`B${i}`).value,'Fresh');assert.equal(s.getCell(`C${i}`).numFmt,'@');assert.equal(s.getCell(`D${i}`).numFmt,'@');assert.equal(s.getCell(`B${i}`).dataValidation.type,'list');assert.match(s.getCell(`B${i}`).dataValidation.formulae.join(),/Fresh,Renewal/);}
  assert.equal(s.views[0].state,'frozen');assert.equal(s.views[0].ySplit,1);
  s.getCell('C2').value='000000000001';s.getCell('D2').value='UP26-0000000001';
  assert.equal((await parseBatchWorkbook(Buffer.from(await w.xlsx.writeBuffer())))[0].registration,'000000000001');
});
test('Telegram download bounds, file path checks and document MIME types',async()=>{
  const document={file_id:'file',file_size:3},maxBytes=5;let fetches=0;
  const args={token:'synthetic',document,maxBytes,api:async()=>({file_path:'documents/file.xlsx',file_size:3}),fetcher:async()=>{fetches++;return new Response(Buffer.from('abc'));}};
  assert.equal((await downloadTelegramFile(args)).toString(),'abc');
  await assert.rejects(downloadTelegramFile({...args,document:{...document,file_size:6}}));assert.equal(fetches,1);
  await assert.rejects(downloadTelegramFile({...args,api:async()=>({file_path:'../secret'})}));assert.equal(fetches,1);
  await assert.rejects(downloadTelegramFile({...args,fetcher:async()=>new Response(Buffer.alloc(6))}),/exceeded/);
  await assert.rejects(downloadTelegramFile({...args,fetcher:async()=>{throw Error('secret-url');}}),e=>!e.message.includes('secret-url'));
  assert.equal(documentMime('a.xlsx'),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');assert.equal(documentMime('a.csv'),'text/csv');assert.equal(documentMime('a.pdf'),'application/pdf');
});
