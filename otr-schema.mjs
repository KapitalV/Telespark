export const OTR_ORIGIN = 'https://scholarship.up.gov.in';
export const OTR_PATHS = {recover:'/ForgetOTR.aspx', register:'/Popup.aspx'};

// Classify only controls actually rendered by the official page. Labels below
// recognize field types; they do not assert that later registration pages exist.
export function fieldType(field) {
  const text = `${field.id} ${field.label} ${field.placeholder ?? ''}`;
  if (field.inputType && !['text','tel','number','email','checkbox','select-one'].includes(field.inputType)) return null;
  if (field.inputType === 'checkbox') {
    return /consent|agree|घोषणा|सहमत|guidelines|सहमति/i.test(text) ? 'consent' : null;
  }
  if (/captcha|कैप्चा/i.test(text)) return 'captcha';
  if (/otp|one.?time.?password|ओ[०.]?टी[०.]?पी/i.test(text)) return 'otp';
  if (/mobile|मोबाइल/i.test(text)) return 'mobile';
  if (/aadhaar|aadhar|आधार/i.test(text)) return 'aadhaar';
  if (field.tag === 'SELECT' && /caste|category|जाति|वर्ग/i.test(text)) return 'category';
  if (/email|e-mail|ई.?मेल/i.test(text)) return 'email';
  if (/father|mother|applicant.?name|full.?name|student.?name|पिता|माता|विद्यार्थी.*नाम|छात्र.*नाम/i.test(text)) return 'name';
  if (/date.?of.?birth|dob|जन्म.?तिथि/i.test(text)) return 'dob';
  if (field.tag === 'SELECT' && /gender|लिंग/i.test(text)) return 'choice';
  return null;
}

export function normalizeOtrAnswer(field, input) {
  const value = input.trim();
  if (!value && !field.required) return '';
  if (field.type === 'consent') {
    if (!/^agree$/i.test(value)) throw new Error('Type AGREE only if you accept the displayed declaration, or /cancel.');
    return true;
  }
  if (field.options?.length) {
    const index = /^\d+$/.test(value) ? Number(value) - 1 : -1;
    const option = field.options[index] ?? field.options.find(o => value === o.label);
    if (!option) throw new Error('Choose one of the listed options.');
    return option.value;
  }
  if (field.type === 'mobile' && !/^\d{10}$/.test(value)) throw new Error('Enter a 10-digit mobile number without +91 or spaces.');
  if (field.type === 'aadhaar' && !/^\d{12}$/.test(value)) throw new Error('Enter the 12-digit Aadhaar number requested by the official form.');
  if (field.type === 'otp' && !/^\d{4,8}$/.test(value)) throw new Error('Enter the OTP using digits only, keeping any leading zeros.');
  if (field.type === 'captcha' && !/^[a-zA-Z0-9]{4,8}$/.test(value)) throw new Error('Type the CAPTCHA letters and digits exactly as shown.');
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter a valid email address.');
  if (field.type === 'dob') {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    const date = match && new Date(Date.UTC(+match[3], +match[2] - 1, +match[1]));
    if (!match || date.getUTCDate() !== +match[1] || date.getUTCMonth() !== +match[2] - 1 || date.getUTCFullYear() !== +match[3] || +match[3] < 1900 || date > new Date()) throw new Error('Enter a valid date in DD/MM/YYYY.');
  }
  if (!value || value.length > (field.maxLength || 150) || /[\u0000-\u001f]/.test(value)) throw new Error('Enter a valid value within the field length shown by the website.');
  return value;
}

export function classifyOtrPage(snapshot, mode) {
  let url;
  try { url = new URL(snapshot.url); } catch { return {kind:'unsupported'}; }
  if (url.origin !== OTR_ORIGIN || snapshot.externalFrame) return {kind:'unsupported', reason:'external-verification'};
  // Success requires a dedicated labelled result, not an OTR-looking number in
  // instructions, mobile/Aadhaar inputs, an SMS notice, or a generic success toast.
  if (snapshot.result && /^[A-Za-z0-9-]{8,30}$/.test(snapshot.result) && snapshot.fields.length === 0) {
    return {kind:'success', otr:snapshot.result};
  }
  const expected = mode === 'recover' ? '/forgetotr.aspx' : '/regwithotr.aspx';
  if (url.pathname.toLowerCase() !== expected) return {kind:'unsupported', reason:'page'};
  if (!snapshot.fields.length) return {kind:'unsupported', reason:'fields'};
  const fields = snapshot.fields.map(field => ({...field, key:field.id, type:fieldType(field)}));
  if (fields.some(field => !field.id || !field.type || (field.tag === 'SELECT' && !field.options?.length))) return {kind:'unsupported', reason:'fields'};
  const actions = snapshot.buttons.filter(button => !button.disabled && !/resend|re.?send|पुनः.*(?:otp|ओटीपी)|refresh|back|cancel|वापस/i.test(button.label));
  const candidates = actions.map(button => {
    const label = button.label.trim();
    let kind;
    if (/^(?:generate|send)\s+otp$/i.test(label)) kind = 'send-otp';
    if (/^(?:verify|validate|submit)\s+otp$|^otp\s+(?:verify|verification)$|^ओटीपी\s*सत्यापित\s*करें$/i.test(label)) kind = 'verify-otp';
    if (/^(?:verify|authenticate)\s+(?:aadhaar|aadhar|e-?kyc)$/i.test(label)) kind = 'verify-ekyc';
    if (/^(?:generate|register|submit|final submit)\s+otr$/i.test(label)) kind = 'register';
    if (mode === 'recover' && /ओ[०.]?टी[०.]?आर[०.]?\s*(?:\(OTR\))?\s*पुनः प्राप्त करें|^recover\s+otr$/i.test(label)) kind = fields.some(f => f.type === 'otp') ? 'verify-otp' : 'send-otp';
    return kind ? {...button, kind} : null;
  }).filter(Boolean);
  if (candidates.length !== 1 || actions.length !== 1) return {kind:'unsupported', reason:'action'};
  const action = candidates[0];
  let destination;
  try { destination = new URL(action.actionUrl ?? url.href); } catch { return {kind:'unsupported',reason:'action'}; }
  if (destination.origin !== OTR_ORIGIN || destination.pathname !== url.pathname || !['','_self'].includes(action.target ?? '')) return {kind:'unsupported',reason:'external-verification'};
  if ((action.kind === 'register' && mode !== 'register') || (action.kind === 'verify-otp' && !fields.some(f => f.type === 'otp'))) return {kind:'unsupported', reason:'action'};
  if (action.kind === 'send-otp' && !fields.some(f => ['mobile','aadhaar'].includes(f.type))) return {kind:'unsupported',reason:'action'};
  if (action.kind === 'verify-ekyc' && !fields.some(f => ['aadhaar','otp'].includes(f.type))) return {kind:'unsupported',reason:'action'};
  let stage = action.kind === 'register' ? 'final' : fields.some(f => f.type === 'otp') ? 'otp' : fields.some(f => f.type === 'aadhaar') ? 'ekyc' : 'mobile';
  return {kind:'form', stage, fields, action, error:snapshot.error,
    // Store structure only. Never include applicant values in fingerprints.
    fingerprint:JSON.stringify([url.pathname, fields.map(f => [f.id,f.type,f.label,f.inputType,f.required,f.options,f.maxLength]), action.id,action.kind,action.label,destination.href])};
}
