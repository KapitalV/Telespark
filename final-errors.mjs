// Fixed codes only: portal text, applicant details and exception messages are
// deliberately excluded from diagnostics and activity logs.
export const FINAL_ERROR_CODES=new Set(['FINAL-STATUS','FINAL-LINK','FINAL-NAVIGATION','FINAL-PAGE','FINAL-IDENTITY','FINAL-RENDER','FINAL-VALIDATION']);
export function finalError(code) {return Object.assign(Error('Final PDF operation failed.'),{code});}
export const finalErrorCode=error=>FINAL_ERROR_CODES.has(error?.code)?error.code:undefined;
export function finalErrorNotice(code) {
  const message={
    'FINAL-STATUS':'Final print is no longer available in this session.',
    'FINAL-LINK':'The portal final-print link has an unsupported destination.',
    'FINAL-NAVIGATION':'The portal did not finish opening the final-print page.',
    'FINAL-PAGE':'The final-print response was an unexpected page or session expired.',
    'FINAL-IDENTITY':'The final-print page did not contain the expected application.',
    'FINAL-RENDER':'The browser could not generate the final-print PDF.',
    'FINAL-VALIDATION':'The generated PDF failed its readability or application check.'
  }[code];
  return message?`${message} Diagnostic: ${code}.`:'';
}
