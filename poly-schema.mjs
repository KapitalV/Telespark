export const POLY_ORIGIN='https://scholarship.up.gov.in';
export const PREFIX='ContentPlaceHolder1_';
const f=(id,label,type='text',extra={})=>({id:PREFIX+id,key:id,label,type,...extra});
export const POLY_SECTIONS={
  academic:{button:'btn_Tab1',captcha:'Captcha',refresh:'reloadcaptcha',answer:'txtcptcha1',declaration:'chkbx1',fields:[
    f('rb_regular','Study mode','radio',{defaultLabel:'नियमित'}),
    f('ddl_CourseName','Course','choice',{filter:'course'}),
    f('ddl_CurrentCourse_Branch','Branch','choice',{filter:'branch'}),
    f('courseYear','Current course year','choice',{defaultLabel:'1'}),
    f('ddl_InterOrNot','Admission qualification','choice',{defaultLabel:'हाई स्कूल',filter:'highschool'}),
    f('ddl_Admision_On_InterMarks','Admission directly on intermediate marks','choice',{defaultLabel:'NO'}),
    f('ddl_lateral','Lateral entry','choice',{defaultLabel:'NO'}),
    f('ddl_uptu','Admission through counselling','choice',{defaultLabel:'YES'}),
    f('ddl_uptu_type','Counselling examination','choice',{defaultLabel:'JEECUP'}),
    f('txt_uptu_counsellingRegisterNo','Counselling registration number','digits'),
    f('ddl_aktu_councilling_year','Counselling year','choice',{defaultLabel:'2026',sessionDefault:true}),
    f('txt_aktu_councilling_rank','Counselling rank','digits'),
    f('txt_aktu_councilling_cuttoff','Counselling cutoff','number'),
    f('Gridview1_grid_ddl_passyr_0','High-school passing year','choice'),
    f('Gridview1_grid_txt_TotalMarks_0','High-school total marks','number',{defaultValue:'600'}),
    f('Gridview1_grid_txt_Obtain_0','High-school obtained marks','number'),
    f('Gridview1_grid_txt_Percentage_0','Percentage','number',{computed:true}),
    f('Gridview1_grid_txt_affiliating_0','High-school board'),
    f('Gridview1_txt_schoolname_0','High-school name'),
    f('Gridview1_txt_fee_0','High-school fee field','number',{defaultValue:'634'}),
  ]},
  personal:{button:'btn_Tab2',captcha:'Captcha2',refresh:'reloadcaptcha2',answer:'txtcptcha2',declaration:'chkbx2',fields:[
    f('DropDownList2','Parents status','choice'),
    f('DropDownList3','Father occupation','choice',{defaultLabel:'प्राइवेट ऑटोनमस'}),
    f('txtfather_income','Father annual income','number'),
    f('DropDownList1','Mother occupation','choice',{defaultLabel:'गृहणी'}),
    f('txtmother_income','Mother annual income','number',{defaultValue:'0'}),
  ]},
  bank:{button:'btn_Tab4',captcha:'Captcha4',refresh:'reloadcaptcha4',answer:'txtcptcha4',declaration:'chkbx4',fields:[
    f('ddl_bankname','Bank name','choice'),f('ddldistbnk','Bank district','choice'),f('bankBranch','Bank branch','choice'),
    f('txt_std_accno','Bank account number','digits'),f('txt_std_accno_Re','Re-enter bank account number','account-confirm'),
    f('txt_nameonpassbook','Account holder name exactly as printed on passbook'),
  ]},
  fee:{button:'btn_Tab5',captcha:'Captcha5',refresh:'reloadcaptcha5',answer:'txtcptcha5',declaration:'chkbx5',fields:[
    f('txt_refundAmt','Annual compulsory non-refundable fee','number',{defaultValue:'11010'}),
  ]},
  income:{button:'btn_submit',captcha:'Captcha',refresh:'reloadcaptcha',answer:'txtCaptcha',record:'gvRecord',verify:'IncomeVerify',fields:[
    f('txt_std_ninm','Income certificate application number','digits'),f('txt_income_crtificateno','Income certificate number','digits'),
  ]},
  caste:{button:'btn_submit_caste',captcha:'CaptchaCaste',refresh:'reloadcaptchacaste',answer:'TextBox3',record:'gvRecord_caste',verify:'CasteVerify',fields:[
    f('txt_niw_crtificateno','Caste certificate application number','digits'),f('txt_cst_crtificateno','Caste certificate number','digits'),
  ]},
};
export const POLY_FIELDS={registration:'Registration number',otr:'OTR number',operation:'Requested operation',
  ...Object.fromEntries(Object.values(POLY_SECTIONS).flatMap(s=>s.fields.filter(f=>f.type!=='account-confirm').map(f=>[f.key,f.label]))),
  status:'Last verified stage',ifsc:'Portal IFSC',studentName:'Student name',fatherName:'Father name'};
export function percentage(obtained,total) {
  if(!/^\d+(?:\.\d{1,2})?$/.test(obtained)||!/^\d+(?:\.\d{1,2})?$/.test(total)||Number(total)<=0||Number(obtained)>Number(total)) throw Error('Obtained marks must be between zero and total marks; total marks must be greater than zero.');
  return (Number(obtained)/Number(total)*100).toFixed(2);
}
export function normalizePoly(field,answer,values={}) {
  let value=answer.trim();
  if(!value || value.length>(field.maxLength||300)||/[\u0000-\u001f]/.test(value)) throw Error('Enter a valid value within the field length.');
  if(field.options) {
    const option=field.options.find(o=>o.value===value)||field.options.find(o=>o.label.toLowerCase()===value.toLowerCase());
    if(!option) throw Error('Select an option shown by the official portal.');
    return option.value;
  }
  if(['digits','account-confirm'].includes(field.type)&&!/^\d+$/.test(value)) throw Error('Enter digits only, keeping leading zeros.');
  if(field.type==='number'&&!/^\d+(?:\.\d{1,2})?$/.test(value)) throw Error('Enter a non-negative number with at most two decimal places.');
  if(field.type==='account-confirm'&&value!==values.txt_std_accno) throw Error('The account numbers do not match. Re-enter the same account number.');
  if(field.key==='Gridview1_grid_txt_Obtain_0') percentage(value,values.Gridview1_grid_txt_TotalMarks_0||'');
  if(field.key==='Gridview1_grid_txt_TotalMarks_0'&&Number(value)<=0) throw Error('Total marks must be greater than zero.');
  if(field.key==='registration'&&!/^\d{10,25}$/.test(value)) throw Error('Enter the registration number exactly as printed on your slip.');
  if(field.key==='otr'&&!/^UP\d{2}-\d{8,16}$/i.test(value)) throw Error('Enter the OTR in the format shown on your slip, such as UP26-0000000001.');
  return field.key==='otr'?value.toUpperCase():value;
}
export function filterOptions(field,options) {
  const usable=options.filter(o=>o.value&&!/^(-+|select|चुन|--चुन)/i.test(o.label.trim()));
  if(field.filter==='course') return usable.filter(o=>/diploma.*eng/i.test(o.label)&&/group\s*[34]/i.test(o.label));
  if(field.filter==='branch') return usable.filter(o=>/computer science|electronics/i.test(o.label));
  if(field.filter==='highschool') return usable.filter(o=>/^(हाई[ -]?स्कूल|high[ -]?school)$/i.test(o.label.trim()));
  return usable;
}
