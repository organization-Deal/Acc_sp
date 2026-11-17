import test from 'node:test';
import assert from 'node:assert/strict';
import {financeStage,financeProblem,fingerprint,verifiedCallback,checkedStage} from '../src/finance.js';
const fixture=()=>{const j={key:'k',summaryId:'r',state:'DONE',company:{id:'PSH',name:'Company'},employee:{name:'Employee',accountName:'Employee',accountNo:'123-456789-0',bankName:'SCB'},currency:'THB',docId:'doc',docNo:'D1',pdfUrl:'https://example.com/pdf',items:[{amount:10,detail:'Expense'}]};const r={record_id:'r',fields:{'รหัสงานระบบ':'k','บริษัท':'Company','รหัสบริษัท':'PSH','ชื่อพนักงาน':'Employee','ชื่อบัญชี':'Employee','เลขบัญชี':'123-456789-0','ธนาคาร':'SCB','Doc ID':'doc','เลขใบขอเบิก':'D1','ใบขอเบิก PDF':{link:j.pdfUrl},'ยอดรวม':10,'จำนวนรายการ':1,'สถานะ':'สร้างแล้ว'}};return{r,j};};
test('new request requires accounting before Not and May; signed approvals stay payable',async()=>{const {r,j}=fixture();assert.equal(financeStage(r,j),'accounting');Object.assign(r.fields,{'บัญชีตรวจผ่าน':true,'ผู้ตรวจบัญชี':'ACCOUNTANT','เวลาบัญชีตรวจผ่าน':123,'ข้อมูลที่บัญชีตรวจผ่าน':await fingerprint(r,j)});assert.equal(await checkedStage(r,j),'not');Object.assign(r.fields,{'นอตตรวจผ่าน':true,'ผู้ตรวจสอบก่อนอนุมัติ':'NOT','เวลานอตตรวจผ่าน':123});assert.equal(financeStage(r,j),'may');r.fields.Approve=true;assert.equal(financeStage(r,j),'waiting');r.fields['สถานะ']='อนุมัติแล้ว';assert.equal(financeStage(r,j),'waiting');j.state='APPROVED';j.approvedPdf='https://example.com/signed';r.fields['PDF อนุมัติแล้ว']={link:j.approvedPdf};assert.equal(financeStage(r,j),'transfer');});
test('changed amount/account/company/doc is blocked',()=>{for(const key of ['ยอดรวม','จำนวนรายการ','บริษัท','เลขบัญชี','Doc ID']){const {r,j}=fixture();r.fields[key]='changed';assert.equal(financeStage(r,j),'blocked');assert.ok(financeProblem(r.fields,j,r.record_id));}});
test('TEST returns to Not separately; never real transfer',()=>{const {r,j}=fixture();Object.assign(r.fields,{'นอตตรวจผ่าน':true,'ผู้ตรวจสอบก่อนอนุมัติ':'NOT','เวลานอตตรวจผ่าน':123,Approve:true,'สถานะ':'อนุมัติแล้ว','PDF อนุมัติแล้ว':{link:'signed'}});Object.assign(j,{state:'APPROVED',approvedPdf:'signed'});j.items[0].detail='TEST NOT-PROFILE';assert.equal(financeStage(r,j),'test');r.fields['รายการสำเร็จ']=true;assert.equal(financeStage(r,j),'closed');});
test('returned and legacy records do not get approval cards',()=>{const {r,j}=fixture();r.fields['ส่งกลับแก้ไขก่อนอนุมัติ']=true;assert.equal(financeStage(r,j),'returned');delete r.fields['รหัสงานระบบ'];assert.equal(financeStage(r,j),'legacy');});
test('fingerprint survives stage change but rejects financial changes',async()=>{const {r,j}=fixture();const before=await fingerprint(r,j);r.fields['นอตตรวจผ่าน']=true;r.fields.Approve=true;assert.equal(await fingerprint(r,j),before);r.fields['เลขบัญชี']='9999999999';assert.notEqual(await fingerprint(r,j),before);});
test('callback requires correct app, event and verification token',()=>{const env={LARK_VERIFICATION_TOKEN:'secret'},b={header:{token:'secret',app_id:'cli_aaa42a0be838de17',event_type:'card.action.trigger'}};assert.ok(verifiedCallback(env,b));assert.equal(verifiedCallback({},b),false);assert.equal(verifiedCallback(env,{header:{...b.header,token:'wrong'}}),false);assert.equal(verifiedCallback(env,{header:{...b.header,app_id:'other'}}),false);});
test('wrong actor and retired cards cannot mutate approvals',async()=>{
 const {financeCallback}=await import('../src/finance.js');
 const env={FINANCE_ENABLED:'true',LARK_VERIFICATION_TOKEN:'secret'};
 let saved={stage:'may',recipient:'may-only',created:Date.now(),signatures:[['r','hash']]};
 const owner={env,ctx:{storage:{get:async k=>k.startsWith('nonce:')?'key':saved}}};
 const b={header:{token:'secret',app_id:'cli_aaa42a0be838de17',event_type:'card.action.trigger'},event:{operator:{open_id:'not-may'},action:{value:{finance:true,nonce:'n',action:'accept',id:'r'}}}};
 assert.deepEqual(await financeCallback(owner,b),{ignored:true});
 saved={...saved,retired:true};b.event.operator.open_id='may-only';assert.deepEqual(await financeCallback(owner,b),{ignored:true});
 b.header.token='wrong';await assert.rejects(()=>financeCallback(owner,b),/Unauthorized/);
});

test('changed reviewed data must go back to accounting, even when Not checkbox remains',async()=>{
 const {r,j}=fixture();const hash=await fingerprint(r,j);
 Object.assign(r.fields,{'บัญชีตรวจผ่าน':true,'ผู้ตรวจบัญชี':'A','เวลาบัญชีตรวจผ่าน':123,'ข้อมูลที่บัญชีตรวจผ่าน':hash,'นอตตรวจผ่าน':true,'ผู้ตรวจสอบก่อนอนุมัติ':'N','เวลานอตตรวจผ่าน':123,'ข้อมูลที่นอตตรวจผ่าน':hash});
 assert.equal(await checkedStage(r,j),'may');
 r.fields['สรุปค่าใช้จ่าย']='Updated';assert.equal(await checkedStage(r,j),'accounting');
 r.fields['ข้อมูลที่บัญชีตรวจผ่าน']=await fingerprint(r,j);assert.equal(await checkedStage(r,j),'not');
});
test('a checkbox alone cannot bypass accounting review',async()=>{const {r,j}=fixture();r.fields['บัญชีตรวจผ่าน']=true;r.fields['นอตตรวจผ่าน']=true;assert.equal(await checkedStage(r,j),'accounting');});
