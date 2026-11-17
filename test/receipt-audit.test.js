import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOCR,validateBills,validDate} from '../src/validation.js';
import {newState,mergeItem,updateBill,materializeBills,codeOf} from '../src/domain.js';
import {saveBills} from '../src/lark.js';
const valid=()=>({company_id:'PSH',amount:14,ai_detail:'ซื้อน้ำดื่ม',purpose_confirmed:true,category:'ค่าอาหาร (บริหาร)',expense_date:'2026-11-16',pay_type:'เงินโอน',anchor:{},members:[{role:'PAYSLIP',file_token:'test'}]});
test('SCB payment confirmation overrides wrong receipt role and cash',()=>{const o=normalizeOCR({role:'RECEIPT',pay_type:'เงินสด',is_bank_slip:true,ai_detail:'ซ่อมตู้',tax_id:'123',date:'2026-11-16'});assert.equal(o.role,'PAYSLIP');assert.equal(o.pay_type,'เงินโอน');assert.equal(o.ai_detail,'');assert.equal(o.tax_id,null);});
test('literal transfer heading and reference also classify as slip',()=>assert.equal(normalizeOCR({role:'RECEIPT',document_text:'โอนเงินสำเร็จ รหัสอ้างอิง: 123'}).role,'PAYSLIP'));
test('genuine receipt remains receipt',()=>assert.equal(normalizeOCR({role:'RECEIPT',is_bank_slip:false,date:'2026-11-16'}).role,'RECEIPT'));
test('requires real purpose, category, date, method and positive amount',()=>{assert.equal(validateBills([valid()]),'');for(const patch of [{purpose_confirmed:false},{category:''},{expense_date:'2026-02-30'},{pay_type:''},{amount:0},{pay_type:'เงินสด'}])assert.notEqual(validateBills([{...valid(),...patch}]),'');assert.equal(validDate('2026-02-30'),false);});
test('date and selected category survive company changes; edit resets purpose review',()=>{const s=newState();mergeItem(s,{message_id:'a',image_key:'x',role:'PAYSLIP',amount:14,date:'2026-11-16'});const b=s.bills[0];updateBill(s,b.id,{category:'ค่าอาหาร (บริหาร)',ai_detail:'น้ำดื่ม',company_id:'PSH'});updateBill(s,b.id,{purpose_confirmed:true});updateBill(s,b.id,{company_id:'PWA'});const out=materializeBills(s)[0];assert.equal(out.expense_date,'2026-11-16');assert.equal(out.cat_code,codeOf(out.category));assert.equal(out.pay_type,'เงินโอน');updateBill(s,b.id,{ai_detail:'แก้คำอธิบาย'});assert.equal(b.purpose_confirmed,false);});
test('write slip field, dedicated expense date and derive category code afresh',async()=>{const original=globalThis.fetch;let fields;globalThis.fetch=async(url,opts)=>{fields=JSON.parse(opts.body).fields;return{ok:true,status:200,json:async()=>({code:0,data:{record:{record_id:'rec_test',fields:{}}}})}};try{await saveBills({KV:{get:async()=> 'token'}},{record_id:'e'},[{...valid(),cat_code:'WRONG'}]);assert.equal(fields['รหัสหมวดค่าใช้จ่าย'],'530108');assert.equal(fields['วันที่ใช้จ่าย'],Date.parse('2026-11-16T00:00:00+07:00'));assert.equal(fields['วันที่ส่งคำขอ'],undefined);assert.equal(fields['แนบใบเสร็จ'],undefined);assert.equal(fields['แนบ Pay Slip'].length,1);assert.equal(fields['หากต้องการทำเอกสารแทนใบเสร็จ กรุณาคลิก'],true);}finally{globalThis.fetch=original;}});
test('failed Lark writes never return success; partial records are checkpointed',async()=>{
 const original=globalThis.fetch;const env={KV:{get:async()=> 'token'}};
 try {
  for(const response of [{ok:true,status:200,body:{code:1254002,msg:'Field validation failed'}},{ok:false,status:503,body:{code:0}},{ok:true,status:200,body:{code:0,data:{record:{fields:{}}}}}]) {
   let calls=0;globalThis.fetch=async()=>{calls++;return {...response,json:async()=>response.body}};
   await assert.rejects(saveBills(env,{record_id:'e'},[valid()]));assert.equal(calls,1);
  }
  let calls=0;const saved=[];globalThis.fetch=async()=>({ok:true,status:200,json:async()=>++calls===1?{code:0,data:{record:{record_id:'rec_confirmed',fields:{}}}}:{code:1254002,msg:'bad field'}});
  await assert.rejects(saveBills(env,{record_id:'e'},[valid(),valid()],async r=>saved.push(r)));
  assert.deepEqual(saved,[{index:0,record_id:'rec_confirmed',ref:'rec_confirmed'}]);assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});
