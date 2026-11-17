import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {slipFits,transferPage,portalAction} from '../src/transfer.js';
test('slip requires exact amount, currency and recipient account',()=>{
 const r={account:'821-421423-7',amount:231,currency:'THB'};
 assert.equal(slipFits({amount:231,currency:'THB',recipient_acct:'4237'},r),true);
 for(const o of [{amount:232,currency:'THB',recipient_acct:'4237'},{amount:231,currency:'USD',recipient_acct:'4237'},{amount:231,currency:'THB',recipient_acct:'9999'},{amount:231,currency:'THB',recipient_acct:''},{amount:231,currency:'',recipient_acct:'4237'}])assert.equal(slipFits(o,r),false);
});
test('portal scripts compile and show copy/multi-upload/confirmation controls',()=>{
 const html=transferPage('test-token');new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
 for(const t of ['คัดลอกบัญชี','คัดลอกยอด','multiple','ยืนยันแนบทั้งหมด','เลือกบริษัทผู้จ่าย'])assert.ok(html.includes(t));
});
test('invalid or expired portal tokens reject before any external operation',async()=>{
 await assert.rejects(()=>portalAction({ctx:{storage:{get:async()=>null}},env:{}},{token:'bad',op:'commit'}),/หมดอายุ/);
 await assert.rejects(()=>portalAction({ctx:{storage:{get:async k=>k.startsWith('nonce:')?'key':{stage:'transfer',created:0}}},env:{}},{token:'old',op:'rows'}),/หมดอายุ/);
});
test('commit attaches evidence before completion, rejects wrong company and retries without duplicate',async()=>{
 const {CFG}=await import('../src/config.js');const realFetch=globalThis.fetch, writes=[];
 const j={key:'job',summaryId:'r1',state:'APPROVED',company:{id:'PSH',name:'Company'},employee:{name:'Employee',accountName:'Employee',accountNo:'8214214237',bankName:'SCB'},currency:'THB',docId:'doc',docNo:'D1',pdfUrl:'https://example.com/pdf',approvedPdf:'https://example.com/signed',items:[{amount:231}]};
 const r={record_id:'r1',fields:{'รหัสงานระบบ':'job','บริษัท':'Company','รหัสบริษัท':'PSH','ชื่อพนักงาน':'Employee','ชื่อบัญชี':'Employee','เลขบัญชี':'8214214237','ธนาคาร':'SCB','Doc ID':'doc','เลขใบขอเบิก':'D1','ใบขอเบิก PDF':{link:j.pdfUrl},'ยอดรวม':231,'จำนวนรายการ':1,'สถานะ':'อนุมัติแล้ว',Approve:true,'นอตตรวจผ่าน':true,'ผู้ตรวจสอบก่อนอนุมัติ':'NOT','เวลานอตตรวจผ่าน':123,'PDF อนุมัติแล้ว':{link:j.approvedPdf}}};
 const people=[{fields:{'Name (TH)':'นายธีร์ชนาภัทร รุ่งโรจน์สุทธิธนา','Lark open_id':'ou_not'}},{fields:{'Name (TH)':'นางสาวภัทร์ปรียา อภิรติวงศ์โชติ','Lark open_id':'ou_may'}}];
 const mem=new Map([['nonce:n','card'],['card',{stage:'transfer',recipient:'ou_not',created:Date.now()}],['draft:d',{owner:'ou_not',at:Date.now(),hash:'h',refKey:'ref1',file:'file1',ocr:{amount:231,currency:'THB',recipient_acct:'4237'}}]]);
 const owner={env:{KV:{get:async()=> 'fake-token'}},ctx:{storage:{get:async k=>mem.get(k),put:async(k,v)=>mem.set(k,v)}}};
 globalThis.fetch=async(url,opt={})=>{let data;if(opt.method==='PUT'){const f=JSON.parse(opt.body).fields;writes.push(f);Object.assign(r.fields,f);data={record:r};}else if(url.includes(CFG.T_EMPLOYEE))data={items:people};else if(url.includes('tbljMfJTB5VIis8Y'))data={items:[{fields:{'ข้อมูลงาน JSON':JSON.stringify(j)}}]};else data=url.includes('/records/r1')?{record:structuredClone(r)}:{items:[structuredClone(r)]};return new Response(JSON.stringify({code:0,data}));};
 try{
 const call=company=>portalAction(owner,{token:'n',op:'commit',pairs:[{draft:'d',id:'r1',company}]});
 assert.equal((await call('ODP')).results[0].ok,false);assert.equal(writes.length,0);
 assert.equal((await call('PSH')).results[0].ok,true);assert.equal(writes.length,2);assert.ok(writes[0]['หลักฐานการโอน']);assert.equal(writes[1]['รายการสำเร็จ'],true);
 assert.equal((await call('PSH')).results[0].already,true);assert.equal(writes.length,2);
 }finally{globalThis.fetch=realFetch;}
});
