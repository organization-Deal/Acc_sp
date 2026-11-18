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

test('table button rejects incomplete, altered, already approved and paid summaries',async()=>{
 const {tableReviewProblem}=await import('../src/finance.js');
 const {r,j}=fixture();assert.equal(tableReviewProblem(r,j),'');
 r.fields['ยอดรวม']=99;assert.ok(tableReviewProblem(r,j));r.fields['ยอดรวม']=10;
 r.fields.Approve=true;assert.ok(tableReviewProblem(r,j));r.fields.Approve=false;
 r.fields['รายการสำเร็จ']=true;assert.ok(tableReviewProblem(r,j));
});
test('table review consumes one request, routes to Not and preserves review on repeat click',async()=>{
 const {tableReview,TABLE_REQUEST}=await import('../src/finance.js');
 const {r,j}=fixture();const env={KV:{get:async()=> 'test-token'}},writes=[],realFetch=globalThis.fetch;
 r.fields[TABLE_REQUEST]=true;
 globalThis.fetch=async(url,opt={})=>{if(opt.method==='PUT'){const fields=JSON.parse(opt.body).fields;writes.push(fields);Object.assign(r.fields,fields);}return new Response(JSON.stringify({code:0,data:{record:structuredClone(r)}}));};
 try {
  await tableReview(env,{r,j});assert.equal(r.fields[TABLE_REQUEST],false);assert.equal(await checkedStage(r,j),'not');assert.equal(r.fields.Approve,undefined);
  const oldReview=r.fields['เวลาบัญชีตรวจผ่าน'];
  const saved={stage:'not',created:Date.now(),nonce:'old',signatures:[[r.record_id,await fingerprint(r,j),'',[],oldReview,0,0]]};
  r.fields[TABLE_REQUEST]=true;await tableReview(env,{r,j});
  assert.equal(r.fields['เวลาบัญชีตรวจผ่าน'],oldReview);assert.ok(r.fields['เวลาขอส่งให้นอตซ้ำ']>0);assert.equal(r.fields['สถานะส่งให้นอต'],'รอส่งอีกครั้ง');
  const {reviewRows}=await import('../src/finance.js');assert.match((await reviewRows(saved,[{r,j}],{get:async()=>null}))[0].reviewStatus,/ใช้การ์ดล่าสุด/);
  const at=r.fields['เวลาบัญชีตรวจผ่าน'];r.fields['นอตตรวจผ่าน']=true;r.fields['ผู้ตรวจสอบก่อนอนุมัติ']='N';r.fields['เวลานอตตรวจผ่าน']=123;r.fields['ข้อมูลที่นอตตรวจผ่าน']=await fingerprint(r,j);
  r.fields[TABLE_REQUEST]=true;await tableReview(env,{r,j});assert.equal(r.fields['เวลาบัญชีตรวจผ่าน'],at);assert.equal(await checkedStage(r,j),'may');
  r.fields[TABLE_REQUEST]=true;r.fields.Approve=true;await tableReview(env,{r,j});assert.equal(r.fields.Approve,true);assert.match(r.fields['ผลตรวจบัญชี (ระบบ)'],/ไม่ส่งซ้ำ/);
 }finally{globalThis.fetch=realFetch;}
});


import {financeTick,financeCallback,SUMMARY,LEDGER,recordNotDelivery,DELIVERY_AT,DELIVERY_STATUS,DELIVERY_ID} from '../src/finance.js';
import {CFG} from '../src/config.js';
test('five sequential approvals survive polls and only remaining buttons stay; duplicate and changed data are safe',async()=>{
 const rows=[];for(let i=0;i<5;i++){
  const j={key:'k'+i,summaryId:'r'+i,state:'DONE',company:{id:'PSH',name:'Company'},employee:{name:'Employee',accountName:'Employee',accountNo:'1234567890',bankName:'SCB'},currency:'THB',docId:'doc'+i,docNo:'D'+i,pdfUrl:'https://example.com/'+i,items:[{amount:10}]};
  const r={record_id:'r'+i,fields:{'รหัสงานระบบ':j.key,'บริษัท':'Company','รหัสบริษัท':'PSH','ชื่อพนักงาน':'Employee','ชื่อบัญชี':'Employee','เลขบัญชี':'1234567890','ธนาคาร':'SCB','Doc ID':j.docId,'เลขใบขอเบิก':j.docNo,'ใบขอเบิก PDF':{link:j.pdfUrl},'ยอดรวม':10,'จำนวนรายการ':1,'สถานะ':'สร้างแล้ว','บัญชีตรวจผ่าน':true,'ผู้ตรวจบัญชี':'A','เวลาบัญชีตรวจผ่าน':123}};
  r.fields['ข้อมูลที่บัญชีตรวจผ่าน']=await fingerprint(r,j);rows.push({r,j});
 }
 const db=new Map(),cards=new Map(),writes=[];
 const owner={env:{FINANCE_ENABLED:'true',LARK_VERIFICATION_TOKEN:'secret',KV:{get:async()=> 'token'}},ctx:{storage:{get:async k=>structuredClone(db.get(k)),put:async(k,v)=>db.set(k,structuredClone(v))}}};
 const real=globalThis.fetch;let n=0;
 globalThis.fetch=async(url,opt)=>{const path=new URL(url).pathname,body=opt.body?JSON.parse(opt.body):{};let data={};
  if(path.includes('/im/v1/messages')){if(opt.method==='POST'){const id='m'+(++n);cards.set(id,JSON.parse(body.content));data.message_id=id;}else cards.set(path.split('/').pop(),JSON.parse(body.content));}
  else if(path.includes(CFG.T_EMPLOYEE))data.items=[{fields:{'Name (TH)':'นายธีร์ชนาภัทร รุ่งโรจน์สุทธิธนา','Lark open_id':'ou_not'}},{fields:{'Name (TH)':'นางสาวภัทร์ปรียา อภิรติวงศ์โชติ','Lark open_id':'ou_may'}}];
  else if(path.includes(LEDGER))data.items=rows.map(x=>({fields:{'ข้อมูลงาน JSON':JSON.stringify(x.j)}}));
  else if(path.includes(SUMMARY)){if(path.endsWith('/batch_update')){for(const u of body.records)Object.assign(rows.find(x=>x.r.record_id===u.record_id).r.fields,u.fields);data.records=body.records;}else{const row=rows.find(x=>path.endsWith('/'+x.r.record_id));if(row){if(opt.method==='PUT'){writes.push(row.r.record_id);Object.assign(row.r.fields,body.fields);}data.record=structuredClone(row.r);}else data.items=rows.map(x=>structuredClone(x.r));}}
  else throw Error('Unexpected URL '+path);
  return new Response(JSON.stringify({code:0,data}));
 };
 try{
  await financeTick(owner);const key=db.get('active:not')[0],saved=db.get(key),msg=saved.message;
  const callback=id=>({header:{token:'secret',app_id:CFG.LARK_APP_ID,event_type:'card.action.trigger'},event:{operator:{open_id:'ou_not'},action:{value:{nonce:saved.nonce,action:'accept',id}}}});
  for(let i=0;i<5;i++){
   await financeCallback(owner,callback('r'+i));
   const buttons=cards.get(msg).elements.filter(e=>e.tag==='action').flatMap(e=>e.actions).filter(b=>b.value?.action==='accept');
   assert.equal(buttons.length,4-i);assert.ok(!buttons.some(b=>b.value.id==='r'+i));
   await financeTick(owner);assert.ok(!db.get(key).retired);
   if(i<4)assert.deepEqual(db.get('active:not'),[key]);
  }
  assert.equal(writes.length,5);await financeCallback(owner,callback('r0'));assert.equal(writes.length,5);
  assert.match(JSON.stringify(cards.get(msg)),/เหลือให้กด 0/);
  // May's card cannot approve changed financial data.
  const may=db.get(db.get('active:may')[0]);rows[0].r.fields['ยอดรวม']=99;
  const bad=callback('r0');bad.event.operator.open_id='ou_may';bad.event.action.value.nonce=may.nonce;
  await financeCallback(owner,bad);assert.equal(writes.length,5);assert.equal(rows[0].r.fields.Approve,undefined);
 }finally{globalThis.fetch=real;}
});
test('delivery receipt needs message acknowledgement and retries audit without resending; old timestamp comes from message',async()=>{
 const x={r:{record_id:'r',fields:{'เวลาบัญชีตรวจผ่าน':10}},j:{key:'k'}};const hash=await fingerprint(x.r,x.j),writes=[];let fail=false,reads=0;
 const owner={env:{KV:{get:async()=> 'token'}},ctx:{storage:{put:async()=>{}}}},saved={stage:'not',signatures:[['r',hash,'',[],10]]};
 const real=globalThis.fetch;globalThis.fetch=async(url,opt)=>{if(opt.method==='GET'){reads++;return new Response(JSON.stringify({code:0,data:{items:[{message_id:'om_test',create_time:'1795011000000'}]}}));}if(fail)throw Error('temporary audit failure');const b=JSON.parse(opt.body);writes.push(b);return new Response(JSON.stringify({code:0,data:{records:b.records}}));};
 try{
  await recordNotDelivery(owner,'k',saved,[x]);assert.equal(writes.length,0);
  Object.assign(saved,{sent:true,message:'om_test'});fail=true;await assert.rejects(()=>recordNotDelivery(owner,'k',saved,[x]));assert.equal(x.r.fields[DELIVERY_STATUS],undefined);
  fail=false;await recordNotDelivery(owner,'k',saved,[x]);assert.equal(reads,1);assert.equal(x.r.fields[DELIVERY_STATUS],'ส่งแล้ว');assert.equal(x.r.fields[DELIVERY_AT],1795011000000);assert.equal(x.r.fields[DELIVERY_ID],'om_test');
  await recordNotDelivery(owner,'k',saved,[x]);assert.equal(writes.length,1);
  x.r.fields['เวลาบัญชีตรวจผ่าน']=20;saved.sentAt+=1000;await recordNotDelivery(owner,'k',saved,[x]);assert.equal(writes.length,1);
 }finally{globalThis.fetch=real;}
});
