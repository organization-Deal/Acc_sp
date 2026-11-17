// Stable IDs shared with Apps Script company registry. Never infer a company from vendor tax ID.
export const COMPANIES = [
 {id:'PSH', label:'PROSERVICE', name:'บริษัท โปรเซอร์วิส โฮม โซลูชั่น จำกัด'},
 {id:'PWA', label:'PROSPER', name:'บริษัท พรอสเพอร์ เวลธี่ เอสเซท จำกัด'},
 {id:'ODP', label:'OMNI', expenseName:'บจก. ออมนิ แดช เพย์ วอลเลต', name:'บริษัท ออมนิ แดช เพย์ วอลเล็ต จำกัด'},
];
export const companyOf = id => COMPANIES.find(c => c.id === id);
export function companyError(bills) {
 const missing=bills.map((b,i)=>companyOf(b.company_id)?null:i+1).filter(Boolean);
 return missing.length ? 'กรุณาเลือกบริษัทสำหรับบิล '+missing.join(', ')+' ในหน้าจัดบิล หรือพิมพ์ บริษัท PSH / PWA / ODP (ทุกบิล) หรือ บิล 2 บริษัท ODP' : '';
}
export function needsReceipt(bill) {
 return bill.receipt_requested === true || !(bill.members||[]).some(m=>m.role==='RECEIPT' && (m.image_key || m.file_token));
}

export const companyFromName = name => COMPANIES.find(c=>[c.id,c.name,c.expenseName].filter(Boolean).includes(String(name||'').trim()));
