// Deliberately use a closed vocabulary: DOM labels and alert messages may
// contain applicant data. Never log their original text, field values or URLs.
const WORDS = new Set('otp otr captcha mobile number no is your has been code verify verification validate submit send sent resend recover registered invalid incorrect wrong expired valid enter please match matched not found successfully success print reset error unavailable service runtime server application आपका आपकी है संख्या पंजीकरण पुनः प्राप्त करें सत्यापित भेजें भेजा गया गलत अमान्य समाप्त दर्ज मोबाइल नंबर कैप्चा ओटीपी ओटीआर'.split(' '));
export function diagnosticWords(text = '') {
  return [...new Set(text.toLowerCase().replace(/ओ[०.\s]*टी[०.\s]*पी[०.]*/gu,'otp').replace(/ओ[०.\s]*टी[०.\s]*आर[०.]*/gu,'otr').split(/[^\p{L}\p{M}]+/u).filter(word => WORDS.has(word)))];
}
function controlId(id = '') {
  // ASP.NET static control names only; unknown or data-derived IDs are omitted.
  return /^(?:ContentPlaceHolder1_)?[A-Za-z_]{1,80}$/.test(id) ? id : 'other';
}
export function otrDiagnostic(snapshot, reason) {
  let path = 'other';
  try { const p = new URL(snapshot.url).pathname; if (/^\/[A-Za-z]+\.aspx$/i.test(p)) path = p; } catch {}
  return {
    event:'otr-unsupported',reason,path,
    fields:(snapshot.fields ?? []).map(f => ({id:controlId(f.id),type:['text','tel','number','password','checkbox','select-one'].includes(f.inputType) ? f.inputType : 'other',words:diagnosticWords(f.label)})),
    buttons:(snapshot.buttons ?? []).map(b => ({id:controlId(b.id),disabled:!!b.disabled,words:diagnosticWords(b.label)})),
    externalFrame:!!snapshot.externalFrame,
    resultCount:new Set([snapshot.result,...(snapshot.recoveryResults ?? [])].filter(Boolean)).size,
    content:(snapshot.resultBlocks ?? []).map(b => ({tag:b.tag,id:controlId(b.id),words:diagnosticWords(b.text),numberLengths:[...b.text.matchAll(/\d+/g)].map(m => m[0].length)})),
    panel:snapshot.recoveryPanel ? {
      labelled:snapshot.recoveryPanel.labelled,
      headingShapes:snapshot.recoveryPanel.headings.map(maskTextShape),
      valueShapes:snapshot.recoveryPanel.values.map(maskTextShape),
    } : undefined,
  };
}

export function maskTextShape(text) {
  return text.slice(0,100).replace(/[\p{L}\p{M}]/gu,'X').replace(/\p{N}/gu,'#');
}
