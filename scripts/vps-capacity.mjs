// OFFLINE synthetic workload. No applicant data, Telegram calls or portal requests.
import {chromium} from 'playwright';
import {cpus,freemem,totalmem} from 'node:os';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {validatePolyPdf} from '../poly-pdf.mjs';
import assert from 'node:assert/strict';

const levels=(process.env.CAPACITY_LEVELS||'1,2,3,5,8,10').split(',').map(Number);
const rounds=Number(process.env.CAPACITY_ROUNDS||3),holdMs=Number(process.env.CAPACITY_HOLD_MS||2000);
if(!levels.every(n=>Number.isInteger(n)&&n>=1&&n<=10)||!Number.isInteger(rounds)||rounds<1||rounds>60||!Number.isInteger(holdMs)||holdMs<0||holdMs>10000)throw Error('Invalid synthetic test configuration');
const pageHtml=`<!doctype html><meta charset="utf-8"><style>body{font-family:sans-serif}section{break-before:page}</style>
<h1>Synthetic application</h1><p>Registration number: 000012345678</p>
<label>Course<select id="course"><option value="">Choose</option><option value="diploma">Diploma</option></select></label>
<label>Branch<select id="branch" disabled><option>Choose course</option></select></label>
<label>Name<input id="name"></label><label>Marks<input id="marks"></label>
<label>CAPTCHA<input id="captcha"></label><div id="image">TEST1</div>
<script>course.onchange=()=>{branch.disabled=true;setTimeout(()=>{branch.innerHTML='<option value="electrical">Electrical Engineering</option>';branch.disabled=false},150)};</script>
<section><h2>Synthetic print second page</h2><p>This document contains no applicant information.</p></section>`;
const cpu=()=>cpus().reduce((a,c)=>{for(const [k,v]of Object.entries(c.times)){a.total+=v;if(k==='idle')a.idle+=v}return a},{total:0,idle:0});
async function available(){try{return Number((await readFile('/proc/meminfo','utf8')).match(/^MemAvailable:\s+(\d+)/m)[1])*1024}catch{return freemem()}}
const quantile=(values,p)=>Math.round([...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]||0);
async function workflow(measure){
  const started=performance.now();let browser;
  try {
    browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined,timeout:30000});
    const context=await browser.newContext();await context.setOffline(true);await context.route('**/*',route=>route.abort());
    const page=await context.newPage();page.setDefaultTimeout(15000);
    await page.setContent(pageHtml);await page.locator('#course').selectOption('diploma');
    await page.locator('#branch:not([disabled])').waitFor();await page.locator('#branch').selectOption('electrical');
    await page.locator('#name').fill('SYNTHETIC TEST');await page.locator('#marks').fill('447');
    assert.ok((await page.locator('#image').screenshot()).length>50);
    await delay(holdMs);await page.locator('#captcha').fill('TEST1');
    const actionStart=performance.now();
    const pdf=await page.pdf({format:'A4',printBackground:true});await validatePolyPdf(pdf,'000012345678');
    measure.pdf.push(performance.now()-actionStart);measure.total.push(performance.now()-started);
  }finally{await browser?.close();}
}
console.log(JSON.stringify({test:'offline-capacity',architecture:process.arch,cpuCount:cpus().length,ramMiB:Math.round(totalmem()/1048576),rounds,holdMs}));
for(const concurrent of levels){
  const measure={pdf:[],total:[]};let errors=0,minAvailable=await available(),peakCpu=0,previous=cpu(),sampling=false;
  const sample=async()=>{if(sampling)return;sampling=true;try{minAvailable=Math.min(minAvailable,await available());const now=cpu(),total=now.total-previous.total;if(total>0)peakCpu=Math.max(peakCpu,100*(1-(now.idle-previous.idle)/total));previous=now;}finally{sampling=false}};
  const interval=setInterval(()=>void sample(),500),started=performance.now(),cpuStart=cpu();
  try{for(let wave=0;wave<rounds;wave++){
    const results=await Promise.allSettled(Array.from({length:concurrent},()=>workflow(measure)));
    errors+=results.filter(x=>x.status==='rejected').length;await sample();
    if(errors||minAvailable<2*1024**3)break;
  }}finally{clearInterval(interval)}
  const elapsed=performance.now()-started,cpuEnd=cpu();await delay(1500);
  console.log(JSON.stringify({concurrent,completed:measure.total.length,errors,wallSeconds:+(elapsed/1000).toFixed(1),workflowsPerMinute:+(measure.total.length*60000/elapsed).toFixed(1),workflowP50Ms:quantile(measure.total,.5),workflowP95Ms:quantile(measure.total,.95),pdfP95Ms:quantile(measure.pdf,.95),cpuAveragePercent:+(100*(1-(cpuEnd.idle-cpuStart.idle)/(cpuEnd.total-cpuStart.total))).toFixed(1),cpuPeakPercent:+peakCpu.toFixed(1),minAvailableMiB:Math.round(minAvailable/1048576),availableAfterCleanupMiB:Math.round((await available())/1048576)}));
  if(errors||minAvailable<2*1024**3){console.log('STOPPED_AT_RESOURCE_OR_ERROR_THRESHOLD');process.exitCode=1;break}
}
