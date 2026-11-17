import {CFG,CAT_TABLE} from './config.js';
import {companyError} from './companies.js';
export function validDate(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))return false;const d=new Date(s+'T00:00:00Z');return !isNaN(d)&&d.toISOString().slice(0,10)===s;}
export function validateBills(bills){
 const c=companyError(bills);if(c)return c;
 for(let i=0;i<bills.length;i++){const b=bills[i],prefix='บิล '+(i+1)+': ';
  if(!Number.isFinite(b.amount)||b.amount<=0)return prefix+'กรอกยอดมากกว่า 0';
  if(!b.ai_detail?.trim()||b.purpose_confirmed!==true)return prefix+'กรอกและยืนยันวัตถุประสงค์จริง';
  if(!CAT_TABLE.some(c=>c.n===b.category))return prefix+'เลือกหมวดค่าใช้จ่าย';
  if(!validDate(b.expense_date))return prefix+'ระบุวันที่ใช้จ่ายจริง';
  if(!CFG.PAY_TYPES.includes(b.pay_type))return prefix+'เลือกวิธีจ่าย';
  if(b.members?.some(m=>['PAYSLIP','PROOF'].includes(m.role))&&b.pay_type!=='เงินโอน')return prefix+'มีสลิปโอน กรุณาตรวจวิธีจ่าย';
 }return '';
}
export function normalizeOCR(o){
 const bank=o.is_bank_slip===true || /(?:โอนเงินสำเร็จ|จ่ายเงินสำเร็จ)/.test(o.document_text||'')&&/(?:รหัสอ้างอิง|เลขที่รายการ|reference)/i.test(o.document_text||'');
 if(bank){o.role='PAYSLIP';o.pay_type='เงินโอน';o.tax_id=null;o.invoice_no=null;}
 if(['PAYSLIP','PROOF'].includes(o.role)){o.pay_type='เงินโอน';o.ai_detail='';}
 if(!validDate(o.date))o.date=null;
 return o;
}
