import {PolyPortal} from './poly-portal.mjs';
import {POLY_ORIGIN,PREFIX} from './poly-schema.mjs';
import {validatePolyPdf} from './poly-pdf.mjs';

// Dashboard selectors come from the supplied official page. No row indexes are used.
export function readFinalStatus() {
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const link=e=>visible(e)&&e.matches('a[href]')&&!e.hasAttribute('disabled')&&e.getAttribute('aria-disabled')!=='true'&&!e.classList.contains('aspNetDisabled')?{id:e.id,href:e.href,text:e.innerText.trim(),target:e.target}:undefined;
  const lock=document.getElementById('ContentPlaceHolder1_Href_temp_lock');
  // Read the portal's literal confirmation; never execute or infer arbitrary script.
  const onclick=lock?.getAttribute('onclick')||'';
  const confirmation=onclick.match(/^\s*return\s+confirm\(\s*(['"])([^\\\r\n]*?)\1\s*\)\s*;?\s*$/);
  const declaration=confirmation?.[2];
  const final=document.getElementById('ContentPlaceHolder1_FinalPrint');
  const print=final?.matches('a')?final:final?.querySelector('a[href]');
  const rows=[...document.querySelectorAll('table')].filter(visible).map(e=>e.innerText.trim());
  const identity=rows.find(t=>/रजिस्ट्रेशन संख्या|Registration\s*(?:Number|No)/i.test(t))||'';
  const lockRow=document.getElementById('ContentPlaceHolder1_templock');
  const locked=visible(lockRow)&&!visible(lock)&&(/\uf058|✔|✓/.test(lockRow.innerText)||!!lockRow.querySelector('.fa-check-circle,.fa-check,.glyphicon-ok'));
  return {lock:link(lock),print:link(print),locked,identity,declaration,notice:[lockRow,final].filter(visible).map(e=>e.innerText.trim()).join('\n')};
}

export class FinalPortal extends PolyPortal {
  constructor({applicationType='Fresh',...options}={}) {
    super(options);
    if(!['Fresh','Renewal'].includes(applicationType)) throw Error('Invalid application type.');
    this.applicationType=applicationType;
    this.loginPath=applicationType==='Fresh'?'/LoginStudentPost.aspx':'/LoginStudentPostRenew.aspx';
    this.loginRadioId=applicationType==='Fresh'?'rbtnFR_0':'rbtnFR_1';
    this.paths.add(this.loginPath.toLowerCase());
    // Renewal's login and dashboard need live validation; unknown destinations stay blocked.
    this.paths.add('/postmatricrenewal/default.aspx');
  }
  async open() {
    const image=await super.open();
    this.page.removeAllListeners('dialog');
    this.page.on('dialog',async dialog=>{
      if(this.lockInFlight&&dialog.type()==='confirm'&&this.approvedDialog===dialog.message()) {this.approvedDialog=undefined;await dialog.accept();return;}
      if(this.lockInFlight&&dialog.type()==='confirm') this.pendingDialog=dialog.message();
      else this.dialog=/captcha|कैप्चा/i.test(dialog.message())&&/invalid|incorrect|wrong|गलत|अमान्य/i.test(dialog.message())?'captcha':'unknown';
      await dialog.dismiss().catch(()=>{});
    });
    return image;
  }
  async login(credentials) {
    // Do not toggle an unobserved radio by its numeric position on Renewal.
    const s=await this.snapshot();
    const allowed=new Set(['rbtnFR_0','rbtnFR_1','rbtnLoginType_0','rbtnLoginType_1','txtLogin','txtmob','txt_pwd','txtCaptcha'].map(id=>PREFIX+id));
    if(s.fields.some(f=>!f.disabled&&!allowed.has(f.id))) return {kind:'unsupported',message:'The login page has unrecognized fields. No credentials were submitted.'};
    const checked=s.fields.filter(f=>f.type==='radio'&&f.checked);
    const typeRadio=checked.find(f=>f.id.startsWith(PREFIX+'rbtnFR_'));
    if(this.applicationType==='Renewal') {
      if(!typeRadio||!/renew|नवीनीकरण/i.test(typeRadio.label)) return {kind:'unsupported',message:'Renewal login controls need live mapping. No credentials were submitted.'};
      this.loginRadioId=typeRadio.id.slice(PREFIX.length);
    }
    return super.login(credentials);
  }
  async read() {
    const s=await this.snapshot();
    if(!this.safe(s)||this.dialog==='unknown') return {kind:'unsupported'};
    if(new URL(s.url).pathname.toLowerCase()===this.loginPath.toLowerCase()) return {kind:'expired'};
    if(!/^\/postmatric(?:renewal)?\/default\.aspx$/i.test(new URL(s.url).pathname)) return {kind:'unsupported'};
    const state=await this.page.evaluate(readFinalStatus);
    if(!this.registration||!(state.identity.match(/\d+/g)||[]).includes(this.registration)) return {kind:'unsupported',message:'The dashboard does not match the requested registration.'};
    const token=JSON.stringify([s.url,state]);
    if(state.print) return {kind:'print-ready',identity:state.identity,token};
    if(state.locked) return {kind:'waiting',identity:state.identity,notice:state.notice};
    if(!state.lock) return {kind:'unsupported',message:'The portal has not enabled application locking or institution print. Complete its prerequisites first.'};
    if(!/^javascript:__doPostBack\('ctl00\$ContentPlaceHolder1\$Href_temp_lock',''\);?$/i.test(state.lock.href)||state.lock.target) return {kind:'unsupported'};
    return {kind:'lock-review',identity:state.identity,notice:state.notice,declaration:state.declaration,token};
  }
  async lock(token,approvedDialog) {
    if(this.lockAttempted) return {kind:'unknown'};
    const current=await this.read();
    if(current.kind!=='lock-review'||current.token!==token) return {kind:'unsupported'};
    if(current.declaration&&current.declaration!==approvedDialog) return {...current,kind:'dialog-review'};
    this.lockAttempted=true;this.lockInFlight=true;this.pendingDialog=undefined;this.approvedDialog=approvedDialog;
    let posts=0;
    const count=request=>{if(request.method()==='POST') posts++;};this.page.on('request',count);
    try {
      await this.navigate(()=>this.page.locator('#'+PREFIX+'Href_temp_lock').click());
      const next=await this.read();
      return ['print-ready','waiting'].includes(next.kind)?next:{kind:'unknown'};
    } catch {
      if(posts===0&&this.pendingDialog&&!this.externalBlocked) {
        this.lockAttempted=false;
        return {...current,kind:'dialog-review',declaration:this.pendingDialog};
      }
      return {kind:'unknown'};
    } finally {this.lockInFlight=false;this.approvedDialog=undefined;this.page.off('request',count);}
  }
  async finalPdf() {
    const status=await this.read();if(status.kind!=='print-ready') throw Error('Institution print is not available.');
    const state=await this.page.evaluate(readFinalStatus),url=new URL(state.print.href);
    if(url.origin!==POLY_ORIGIN||!/^\/postmatric(?:renewal)?\/[a-z0-9_]+\.aspx$/i.test(url.pathname)||/tempprint/i.test(url.pathname)||!/संस्था.*प्रिंट|institution.*print|final.*print/i.test(state.print.text)) throw Error('Unsupported final print destination.');
    this.paths.add(url.pathname.toLowerCase());
    // Observed Fresh flow redirects from the dashboard's disclaimer link to this print page.
    // Permit only that mapped transition; other redirects remain blocked.
    const printPath=url.pathname.toLowerCase()==='/postmatric/finaldisclaimer.aspx'?'/postmatric/finalprintinstitute.aspx':url.pathname.toLowerCase();
    this.paths.add(printPath);
    await this.page.goto(url.href,{waitUntil:'domcontentloaded'});
    const s=await this.snapshot();
    if(!this.safe(s)||new URL(s.url).pathname.toLowerCase()!==printPath) throw Error('Final print destination is not verified.');
    if(/System\.(?:ArgumentException|NullReferenceException|Data\.[A-Za-z]+Exception)|Server Error in|Some Error Occurred|Your Request Could Not Be Processed/i.test(s.text)) {
      return {kind:'print-unavailable',reason:'portal-error',message:/Column\s+'AboutMotherFather'\s+does not belong to table/i.test(s.text)
        ? "The official Final Print page has a server error: the AboutMotherFather column is missing. The portal must fix this before a valid final PDF can be generated. Your application remains locked. Try option 5 later; locking will not be repeated."
        : 'The official Final Print page returned a server error. No PDF was created. Your application remains locked. Try option 5 later; locking will not be repeated.'};
    }
    if(!s.text.replaceAll(/\s/g,'').includes(this.registration)||/जाँच हेतु आवेदन|जांच हेतु आवेदन|check.print/i.test(s.text)) throw Error('Final print identity or content is not verified.');
    const native=s.links.find(l=>/\.pdf(?:[?#]|$)/i.test(l.href)&&new URL(l.href).origin===POLY_ORIGIN);
    let bytes;
    if(native) {
      this.nativePdfUrl=native.href;
      const [download]=await Promise.all([this.page.waitForEvent('download'),this.page.getByRole('link',{name:native.text,exact:true}).click()]);
      const stream=await download.createReadStream(),chunks=[];let size=0;
      for await(const chunk of stream) {size+=chunk.length;if(size>16*1024*1024)throw Error('PDF too large');chunks.push(chunk);}
      bytes=Buffer.concat(chunks);await download.delete();
    } else {
      await this.page.evaluate(()=>document.fonts.ready);await this.page.emulateMedia({media:'print'});
      bytes=await this.page.pdf({format:'A4',printBackground:true,preferCSSPageSize:true});
    }
    const result=await validatePolyPdf(bytes,this.registration);return {kind:'pdf',bytes,pages:result.pages};
  }
}
