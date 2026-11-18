import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {slipFits,transferPage,portalAction} from '../src/transfer.js';
import {matchOCR} from '../src/match.js';
test('OCR retries only a missing transaction ID without replacing the payment fields',async()=>{
 const real=globalThis.fetch;let calls=0;
 const payment={amount:40,currency:'THB',ref:null,recipient_acct_mask:'xxx-x-x9079-x',sender_name:'OMNI DASH PAY WALLET CO.,LTD.',recipient_bank:'Krung Thai Bank'};
 globalThis.fetch=async(url,options)=>{
  calls++;const request=JSON.parse(options.body);
  assert.match(request.messages[0].content[1].text,/Transaction ID/);
  assert.equal(request.messages[0].content[0].source.data,'/9j/AA==');
  return new Response(JSON.stringify({content:[{text:JSON.stringify(calls%2?payment:{ref:'TRTS261119186612198',amount:999})}]}));
 };
 try{const o=await matchOCR({CLAUDE_KEY:'test'},'/9j/AA==','image/jpeg');assert.deepEqual(o,{...payment,ref:'TRTS261119186612198'});assert.equal(calls,2);}
 finally{globalThis.fetch=real;}
});
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

import {accountFits,bankCode,payerCompany,slipChoices,resumeDrafts,rereadDraft} from '../src/transfer.js';
test('masked account matching preserves every visible position including a hidden last digit',()=>{
 assert.equal(accountFits('xxx-x-x1234-x','111-2-31234-5'),true);
 assert.equal(accountFits('xxx-x-x1234-x','111-2-30123-4'),false);
 assert.equal(accountFits('xxx-x-x0234-x','111-2-30234-5'),true);
 assert.equal(accountFits('xxx-x-x1234-x','11123123456'),false);
 assert.equal(accountFits('xxx-x-x123-x','1112312345'),false);
 assert.equal(accountFits('xxxxxx1234','1112301234'),true);
 assert.equal(accountFits('1112312345','1112312345'),true);
 assert.equal(accountFits('1234','1112312345'),false);
 assert.equal(accountFits('masked 1234','1112301234'),false);
 assert.equal(accountFits('***-*-*1234-*','1112312345'),true);
});
test('both server matchers and browser helper require payer, amount, currency and bank agreement',async()=>{
 const {externalSlipFits}=await import('../src/external-finance.js');
 const o={amount:40,currency:'THB',recipient_acct_mask:'xxx-x-x1234-x',recipient_bank:'Siam Commercial Bank',sender_name:'OMNI DASH PAY WALLET CO.,LTD.'};
 const r={account:'1112312345',amount:40,currency:'THB',bank:'ไทยพาณิชย์ (SCB)',company_id:'ODP',company:{id:'ODP'}};
 assert.equal(slipFits(o,r),true);assert.equal(externalSlipFits(o,r),true);
 const sandbox={};vm.createContext(sandbox);vm.runInContext([accountFits,bankCode,payerCompany,slipFits,slipChoices].map(f=>f.toString()).join('\n'),sandbox);
 assert.equal(sandbox.slipFits(o,r),true);
 for(const change of [{bank:'KBANK'},{company_id:'PWA',company:{id:'PWA'}},{amount:41},{currency:'USD'},{account:'1112301234'}]){
  assert.equal(slipFits(o,{...r,...change}),false);assert.equal(externalSlipFits(o,{...r,...change}),false);assert.equal(sandbox.slipFits(o,{...r,...change}),false);
 }
 assert.equal(bankCode('Krung Thai Bank'),bankCode('ธนาคารกรุงไทย (BT)'));
 assert.equal(slipFits({...o,amount:null},{...r,amount:0}),false);
 assert.equal(slipChoices(o,[{...r,id:'a'},{...r,id:'b'}],'ODP').length,2); // ambiguity remains for the user
 assert.equal(slipChoices(o,[{...r,hasSlip:true}],'ODP').length,0);
});
test('resume only returns own recent unpaid drafts and deduplicates legacy mirrors',async()=>{
 const at=Date.now(),d={id:'a',owner:'not',at,hash:'a',refKey:'ra'};
 const mem=new Map([['draft:a',d],['external:draft:a',d],['draft:other',{...d,id:'other',owner:'someone',hash:'b',refKey:'rb'}],['draft:old',{...d,id:'old',at:at-7200001,refKey:'rc'}],['draft:paid',{...d,id:'paid',hash:'paid',refKey:'rd'}],['paidHash:paid',{id:'r'}]]);
 const owner={ctx:{storage:{get:async k=>mem.get(k),list:async({prefix})=>new Map([...mem].filter(([k])=>k.startsWith(prefix)))}}};
 assert.deepEqual((await resumeDrafts(owner,{recipient:'not'})).map(d=>d.id),['a']);
});
test('reread recovers masked OCR from the saved image without uploading or changing payment state',async()=>{
 const d={id:'d',owner:'not',at:Date.now(),hash:await (await import('../src/finance.js')).digest('/9j/AA=='),refKey:'ref',ref:'TRX123',file:'saved-image',ocr:{recipient_acct:'1234'}};
 const mem=new Map([['draft:d',structuredClone(d)]]),real=globalThis.fetch;let ocrCalls=0;
 const owner={env:{KV:{get:async k=>k.startsWith('transfer-image:')?'/9j/AA==':'fake-token',put:async()=>{}},CLAUDE_KEY:'test'},ctx:{storage:{get:async k=>structuredClone(mem.get(k)),put:async(k,v)=>mem.set(k,structuredClone(v))}}};
 globalThis.fetch=async(url,opt)=>{
  if(url.includes('/medias/saved-image/download'))return new Response(new Uint8Array([255,216,255,0]));
  assert.equal(url,'https://api.anthropic.com/v1/messages');ocrCalls++;
  const body=JSON.parse(opt.body);assert.match(body.messages[0].content[1].text,/ห้ามลบ/);
  return new Response(JSON.stringify({content:[{text:JSON.stringify({amount:40,currency:'THB',recipient_acct:'xxx-x-x1234-x',recipient_acct_mask:'xxx-x-x1234-x',ref:'TRX123',sender_name:'OMNI DASH PAY WALLET CO.,LTD.',recipient_bank:'SCB'})}]}));
 };
 try{
  await assert.rejects(()=>rereadDraft(owner,'d',{recipient:'other'}),/หมดอายุ/);assert.equal(ocrCalls,0);
  const r=await rereadDraft(owner,'d',{recipient:'not'});assert.equal(r.draft.ocrVersion,2);assert.equal(r.draft.ocr.recipient_acct_mask,'xxx-x-x1234-x');assert.match(r.preview,/^data:image\/jpeg;base64,/);
  await rereadDraft(owner,'d',{recipient:'not'});assert.equal(ocrCalls,1);assert.equal([...mem.keys()].some(k=>k.startsWith('paid')),false);
  mem.set('draft:d',{...d,ref:'DIFFERENT'});mem.set('ref',{id:'already-reserved'});await assert.rejects(()=>rereadDraft(owner,'d',{recipient:'not'}),/เลขอ้างอิง/);assert.equal(mem.get('draft:d').ocrVersion,undefined);
  mem.delete('ref');const corrected=await rereadDraft(owner,'d',{recipient:'not'});assert.equal(corrected.draft.ref,'TRX123');assert.equal(corrected.draft.originalOcrRef,'DIFFERENT');
  const cached={...d,ref:'TRX123'};mem.set('draftHash:'+d.hash,cached);
  const reused=await portalAction(owner,{op:'prepare',image:'/9j/AA==',mime:'image/jpeg',filename:'original.jpg'},{stage:'transfer',recipient:'not'});
  assert.equal(reused.draft.id,'d');assert.equal(reused.draft.ocrVersion,2);assert.equal(reused.draft.file,'saved-image');
 }finally{globalThis.fetch=real;}
});
