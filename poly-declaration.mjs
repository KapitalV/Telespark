// Executed in the page. Only inspect the mapped declaration checkboxes and
// their directly associated/adjacent visible text; never use whole-page text.
export function readPolyDeclarations(ids) {
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).opacity!=='0'&&!e.closest('[hidden],[aria-hidden="true"]');
  const text=e=>visible(e)?e.innerText?.trim()||'':'';
  const hasOtherControl=(node,checkbox)=>[...node.querySelectorAll('input,select,textarea,button,a[href]')].some(control=>control!==checkbox&&visible(control)&&control.type!=='hidden');
  const isDeclaration=value=>value.length>=20&&value.length<=4000&&/घोषणा|प्रमाणित|declar(?:e|ation)|certify/i.test(value.slice(0,160));
  return ids.map(id=>{
    const matches=document.querySelectorAll('#'+CSS.escape(id));
    const checkbox=matches.length===1?matches[0]:undefined;
    if(!checkbox||checkbox.type!=='checkbox'||checkbox.disabled||!visible(checkbox)) return {id,label:''};
    const labels=[...(checkbox.labels||[])].map(text).filter(Boolean);
    if(labels.length) return {id,label:labels.join('\n')};
    const referenced=(checkbox.getAttribute('aria-labelledby')||'').trim().split(/\s+/).filter(Boolean);
    if(referenced.length) {
      const nodes=referenced.map(ref=>document.querySelectorAll('#'+CSS.escape(ref)));
      if(nodes.every(list=>list.length===1&&!!text(list[0]))) return {id,label:nodes.map(list=>text(list[0])).join('\n')};
      return {id,label:''};
    }
    // ASP.NET can render a checkbox in a span and declaration text beside it,
    // without a label[for]. A small container with this sole control is safe.
    let node=checkbox;
    for(let depth=0;depth<3;depth++,node=node.parentElement) {
      if(!node||/^(FORM|BODY|HTML|FIELDSET|TABLE)$/.test(node.tagName)) break;
      let adjacent='';
      for(let sibling=node.nextSibling,count=0;sibling&&count<6;sibling=sibling.nextSibling,count++) {
        if(sibling.nodeType===Node.TEXT_NODE) adjacent+=sibling.textContent;
        else if(sibling.nodeType===Node.ELEMENT_NODE) {
          if(!visible(sibling)) continue;
          if(sibling.matches('input,select,textarea,button,a[href]')||hasOtherControl(sibling,checkbox)) break;
          adjacent+=' '+text(sibling);
        }
        // Stop at the first complete adjacent text block; don't concatenate
        // unrelated warnings or a second consent paragraph farther away.
        if(adjacent.trim()) {
          if(isDeclaration(adjacent.trim())) return {id,label:adjacent.trim()};
          break;
        }
      }
      const parent=node.parentElement;
      if(!parent||/^(FORM|BODY|HTML|FIELDSET|TABLE)$/.test(parent.tagName)||hasOtherControl(parent,checkbox)) break;
      const value=text(parent);
      if(isDeclaration(value)) return {id,label:value};
    }
    return {id,label:''};
  });
}
