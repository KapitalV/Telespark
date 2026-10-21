// Structural diagnostics only. Labels, values and dropdown contents can contain
// applicant details and must never enter this projection or activity logs.
export function unmappedPolyFields(fields,allowed) {
  const unexpected=fields.filter(field=>!field.disabled&&!allowed.has(field.id));
  if(!unexpected.length) return undefined;
  const types=new Set(['text','password','select-one','select-multiple','radio','checkbox','textarea','number','date','email','tel','file']);
  return {
    code:'POLY-FIELDS',count:unexpected.length,
    fields:unexpected.slice(0,15).map(field=>({
      id:typeof field.id==='string'&&/^[A-Za-z_][A-Za-z0-9_$:-]{0,119}$/.test(field.id)?field.id:'(no stable field ID)',
      type:types.has(field.type)?field.type:'unknown',
    })),
  };
}

export function obcFieldDiagnostic(diagnostic) {
  if(diagnostic?.code!=='POLY-FIELDS') return '';
  const fields=diagnostic.fields.map(field=>`${field.id} — ${field.type}`);
  return '\nDiagnostic: OBC-FIELDS\nSection: '+diagnostic.stage+'\nUnmapped controls ('+diagnostic.count+'):\n'+fields.join('\n')+
    (diagnostic.count>fields.length?'\nAdditional controls omitted.':'')+
    '\nThese are field identifiers, not your entered answers. Copy this diagnostic here for mapping.';
}
