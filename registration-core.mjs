import {OtrBot} from './otr-core.mjs';
import {BOARD_KEYBOARD,boardName} from './board-options.mjs';

export function normalizeRegistrationAnswer(field,text,password) {
  const value = field.id==='ContentPlaceHolder1_ddl_board' ? boardName(text) : text.trim();
  if (field.options) {
    const exact = field.options.filter(o=>o.label.toLowerCase()===value.toLowerCase());
    if (exact.length === 1) return exact[0].value;
    if (/^[1-9]\d*$/.test(value) && field.options[Number(value)-1]) return field.options[Number(value)-1].value;
    throw new Error('Choose a listed option number or its exact name. Use /search words to find an institution.');
  }
  if (field.type === 'otr') {
    if (!/^UP\d{2}-\d{10}$/i.test(value)) throw new Error('Enter the OTR exactly as issued, such as UP26-0000000001, including the hyphen.');
    return value.toUpperCase();
  }
  if (field.type === 'prefix') {
    if (/^none$/i.test(value)) return '';
    if (!/^[a-z]{1,2}$/i.test(value)) throw new Error('Enter only the 1–2 letters before the roll number, or NONE.');
    return value.toUpperCase();
  }
  if (field.type === 'roll' && !/^\d{1,11}$/.test(value)) throw new Error('Enter the numeric roll number (up to 11 digits). Keep leading zeros.');
  if (field.type === 'captcha' && !/^[A-Za-z0-9]{5}$/.test(value)) throw new Error('Enter the five CAPTCHA characters exactly, including letter case.');
  if (field.type === 'password' && (!/^[A-Za-z0-9@#$&]{6,12}$/.test(value) || !/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value) || !/[@#$&]/.test(value))) throw new Error('Use 6–12 characters with uppercase, lowercase, a digit and @, #, $ or &.');
  if (field.type === 'password-confirm' && value !== password) throw new Error('The passwords do not match. Re-enter the same password, or /menu to start again.');
  if (field.maxLength && value.length > field.maxLength) throw new Error(`This field allows at most ${field.maxLength} characters.`);
  return value;
}

export class RegistrationBot extends OtrBot {
  constructor(options) { super(options); this.quietActions = true; }
  async start(id) {
    await this.clear(id);
    const state = {mode:'application',phase:'loading',values:{},updated:this.clock(),lastMessageId:-1};
    this.sessions.set(id,state);
    await this.telegram.send(id,'Fresh scholarship registration using an existing OTR. District is fixed to Jalaun. I will ask for the remaining fields one at a time, then show a review before you type CONFIRM. This does not create a new OTR. /cancel clears the bot session.');
    return this.open(id,state);
  }
  async open(id,state) {
    await this.telegram.send(id,'Loading the official registration page; this can take up to 75 seconds.');
    return this.operation(id,state,()=>{state.portal=this.portalFactory();return state.portal.open();});
  }
  normalizeAnswer(field,text,state) {
    return normalizeRegistrationAnswer(field,text,state.portal.answers.get('ContentPlaceHolder1_txt_pwd')?.value);
  }
  async apply(id,state,step) {
    state.search = ''; state.optionPage = 0;
    if (step?.kind==='form' && step.fields[0]?.id==='ContentPlaceHolder1_ddl_district') {
      const choices=step.fields[0].options.filter(o=>o.label.trim().toLowerCase()==='jalaun');
      if(choices.length!==1 || (state.autoDistrictAttempts || 0)>=2) return this.stop(id,state,'unsupported','The website did not offer or retain Jalaun district. No registration was submitted. Use /menu to restart.');
      state.autoDistrictAttempts=(state.autoDistrictAttempts || 0)+1;
      await this.telegram.send(id,'District: Jalaun. Loading its institutions.');
      return this.operation(id,state,()=>state.portal.submit({[step.fields[0].key]:choices[0].value},step.fingerprint));
    }
    if (step?.reason === 'otr-lookup') return this.stop(id,state,'blocked','The website did not open registration for that OTR. Check whether the OTR is valid or already registered for this session. Use /menu to return. No final registration was submitted.');
    return super.apply(id,state,step);
  }
  async prompt(id,state) {
    const field = state.step.fields[state.index];
    if (!field.options) return super.prompt(id,state);
    if (field.id==='ContentPlaceHolder1_ddl_board') {
      const sent=await this.telegram.send(id,'High-school board — choose UP BOARD or CBSE BOARD:',{reply_markup:BOARD_KEYBOARD});
      state.promptId=sent.message_id;state.promptAt=this.clock();
      return;
    }
    const words = (state.search || '').toLowerCase().split(/\s+/).filter(Boolean);
    const options = field.options.map((o,i)=>({...o,index:i+1})).filter(o=>words.every(w=>o.label.toLowerCase().includes(w)));
    const pageSize = 15;
    const start = (state.optionPage || 0)*pageSize;
    const list = options.slice(start,start+pageSize);
    const lines = list.map(o=>`${o.index}. ${o.label.slice(0,170)}`).join('\n');
    const sent = await this.telegram.send(id,`${field.label}\n${lines || 'No matching options. Try /search with fewer words.'}\n${options.length>pageSize ? `${Math.min(start+1,options.length)}–${Math.min(start+pageSize,options.length)} of ${options.length}. /next shows more.\n` : ''}Reply with the listed number or exact name. /search words filters the list; /search clears it.`);
    state.promptId=sent.message_id; state.promptAt=this.clock();
  }
  async handle(message) {
    const id=message?.chat?.id, state=this.sessions.get(id);
    const text=message?.text?.trim() || '';
    if (state?.phase === 'questions' && state.step.fields[state.index]?.options && /^\/(?:search(?:\s|$)|next$)/i.test(text)) {
      if (!message.from || message.from.is_bot || message.chat.type !== 'private' || !this.authorized(message.from.id) || !Number.isSafeInteger(message.message_id) || message.message_id<=state.lastMessageId) return;
      await this.expire();
      if (this.sessions.get(id)!==state) return this.telegram.send(id,'Session expired. Use /menu.');
      state.lastMessageId=message.message_id; state.updated=this.clock();
      if (/^\/search/i.test(text)) {state.search=text.replace(/^\/search\s*/i,'');state.optionPage=0;}
      else {
        const words=(state.search || '').toLowerCase().split(/\s+/).filter(Boolean);
        const count=state.step.fields[state.index].options.filter(o=>words.every(w=>o.label.toLowerCase().includes(w))).length;
        state.optionPage=((state.optionPage || 0)+1)%Math.max(1,Math.ceil(count/15));
      }
      return this.prompt(id,state);
    }
    return super.handle(message);
  }
  async confirmRegistration(id,state) {
    const summary=(state.step.review || []).join('\n');
    const sent=await this.telegram.send(id,`Review the scholarship registration:\n${summary}\nPassword: entered and matched (hidden).\nType CONFIRM to submit once, or /cancel. Check the course, institution and details carefully.`,{protect_content:false});
    state.promptId=sent.message_id;state.promptAt=this.clock();
  }
  async deliver(id,state) {
    return this.telegram.photo(id,state.resultImage,'Official website response after scholarship registration submission. Read the screenshot to check whether registration completed or the website reported an error. No further form was submitted. /result shows this image again.',{protect_content:false});
  }
}
