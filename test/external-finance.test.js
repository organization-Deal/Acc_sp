import {groupedInternalTransfers} from '../src/transfer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {externalTableReview,EF,EXTERNAL_TABLES,externalRow,externalFingerprint,externalProblem,externalStage,externalTick as poll,externalCallback,externalPortalAction,externalSlipFits,externalTransferPage} from '../src/external-finance.js';
import {ED,documentMeta,documentReady,documentSignature} from '../src/external-documents.js';
import {PDFDocument} from 'pdf-lib';
import {digest,SUMMARY,LEDGER} from '../src/finance.js';
import {externalDocumentAccess,externalTransferCard,externalPortalAuth,unifiedPortalAction,unifiedPortalAuth} from '../src/external-finance.js';
import {CFG} from '../src/config.js';
import {signMatchToken,matchApi} from '../src/match.js';
import {createHash} from 'node:crypto';
import {SIGNING_ASSET_KEY,prepareSigningProfile} from '../src/external-signing.js';
import {EXTERNAL_PDF_TEMPLATE_VERSION,renderExternalPdf} from '../src/external-pdf.js';
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const fakeAsset={mime:'image/png',base64:pixel,sha256:createHash('sha256').update(Buffer.from(pixel,'base64')).digest('hex')};
const company='บริษัท ออมนิ แดช เพย์ วอลเล็ต จำกัด';
async function externalTick(owner){let r;for(let i=0;i<4;i++)r=await poll(owner);return r;}
function record(kind,i=0){return {record_id:'rec'+kind+i,fields:kind==='partner'?{'การเงินที่ทำเรื่องเบิก':[{id:'ou_requester',name:'Employee requester'}],'รายการเบิก':i+'PAY_','ชื่อบริษัท':company,'ชื่อบริษัทคู่ค้าผู้รับเงิน':'Vendor '+i,'ยอดโอนเงิน':188+i,'เลขบัญชีผู้รับเงิน':'12345678'+String(i).padStart(2,'0'),'ธนาคาร':'KBANK','สกุลเงิน':'Thai Baht (THB)','ชื่อรายการ':'ค่าเดินทาง','ลงบันทึกค่าใช้จ่ายใน PEAK':{link:'https://doc.peakaccount.com/expenses?emi=NDk1MTUw&eti=reference'},'เอกสารแนบ':[{file_token:'f'+i,url:'https://temporary/one'}]}:{'การเงินที่ทำเรื่องเบิก':[{id:'ou_requester',name:'Employee requester'}],'เหตุผลขอคืนเงิน':'ชำระเงินแล้วใช้ตู้ไม่ได้','Case Number':[{text:'DEAL'+i+'TH'}],'บริษัท':company,'ชื่อบัญชีผู้รับเงิน':'Customer '+i,'จำนวนเงิน':20,'เลขที่บัญชีธนาคาร':'87654321'+String(i).padStart(2,'0'),'ธนาคาร':'SCB','ประเภทตู้':'ตู้ชกมวย','ชื่อสถานที่ตั้งตู้':'Location '+i,'สลิปโอนเงินที่ใช้บริการกับตู้':[{file_token:'f'+i,url:'https://temporary/one'}]}};}
function harness(){
 const internal=[],jobs=[],rows={partner:[],dealpay:[]},db=new Map(),cards=new Map(),writes=[],files=new Map();let serial=0,failId='',failPaidId='',failUpload=false,failDownload=false,loseSendResponse=false;const sentUuids=new Map(),sendAttempts=[];
 const owner={env:{FINANCE_ENABLED:'true',LARK_VERIFICATION_TOKEN:'verify',WORKER_URL:'https://example.test',KV:{get:async key=>key===SIGNING_ASSET_KEY?{version:1,assets:{signature:fakeAsset,stamp:fakeAsset}}:'token'}},ctx:{storage:{get:async k=>structuredClone(db.get(k)),put:async(k,v)=>db.set(k,structuredClone(v))}}};
 owner.documentContext={expires:Date.now()+600000,companies:new Map([['ODP',{name:company,taxId:'0000000000000',address:'Example address'}]]),names:new Map([['ou_not','Not'],['ou_may','May']]),signing:new Map([['ODP',{approver:'May',signatureId:'signature',stampId:'stamp'}]])};
 const real=globalThis.fetch;
 globalThis.fetch=async(url,opt={})=>{
  const path=new URL(url).pathname,body=typeof opt.body==='string'?JSON.parse(opt.body):{};let data={};
  if(path.endsWith('/medias/upload_all')){if(failUpload){failUpload=false;return new Response(JSON.stringify({code:999,msg:'failed'}),{status:503});}assert.equal(opt.body.get('parent_type'),'bitable_file');assert.equal(opt.body.get('file').type,'application/pdf');const file='pdf_'+(files.size+1);files.set(file,await opt.body.get('file').arrayBuffer());data.file_token=file;}
  else if(path.endsWith('/download')){if(failDownload){failDownload=false;return new Response('failed',{status:503});}const extra=JSON.parse(new URL(url).searchParams.get('extra'));assert.ok(extra.bitablePerm.tableId);assert.ok(Object.keys(extra.bitablePerm.attachments).length);const token=path.split('/').at(-2);return new Response(files.has(token)?files.get(token):Buffer.from(pixel,'base64'));}
  else if(path.endsWith('/fields'))data.items=[...Object.values(ED),...new Set(Object.values(EXTERNAL_TABLES).flatMap(t=>t.attachments)),'หลักฐานการโอน'].map((name,i)=>({field_name:name,field_id:'fld'+i,type:17})).concat(['not','may'].map(role=>({field_name:EF[role],field_id:role,type:7})));
  else if(path.includes('/im/v1/messages')){if(opt.method==='POST'){sendAttempts.push(body.uuid);data.message_id=sentUuids.get(body.uuid);if(!data.message_id){data.message_id='om_'+(++serial);sentUuids.set(body.uuid,data.message_id);cards.set(data.message_id,{to:body.receive_id,card:JSON.parse(body.content)});}if(loseSendResponse){loseSendResponse=false;throw Error('lost response after acceptance');}}else cards.get(path.split('/').pop()).card=JSON.parse(body.content);}
  else if(path.includes(CFG.T_EMPLOYEE))data.items=[{fields:{'Name (TH)':'นายธีร์ชนาภัทร รุ่งโรจน์สุทธิธนา','Lark open_id':'ou_not'}},{fields:{'Name (TH)':'นางสาวภัทร์ปรียา อภิรติวงศ์โชติ','Lark open_id':'ou_may'}}];
  else if(path.includes(LEDGER))data.items=jobs.map(j=>({fields:{'ข้อมูลงาน JSON':JSON.stringify(j)}}));
  else if(path.includes(SUMMARY)){const r=internal.find(r=>path.endsWith('/'+r.record_id));if(r){if(opt.method==='PUT'){if(failPaidId===r.record_id&&body.fields['รายการสำเร็จ']){failPaidId='';return new Response(JSON.stringify({code:999,msg:'write failed'}),{status:503});}writes.push({kind:'internal',id:r.record_id,fields:body.fields});Object.assign(r.fields,body.fields);}data.record=structuredClone(r);}else data.items=structuredClone(internal);}
  else {const kind=Object.keys(EXTERNAL_TABLES).find(k=>path.includes(EXTERNAL_TABLES[k].table));assert.ok(kind,'unknown '+path);const r=rows[kind].find(r=>path.endsWith('/'+r.record_id));if(r){if(opt.method==='PUT'){if(failId===r.record_id){failId='';return new Response(JSON.stringify({code:1254290,msg:'rate limit'}));}writes.push({kind,id:r.record_id,fields:body.fields});Object.assign(r.fields,body.fields);}data.record=structuredClone(r);}else data.items=structuredClone(rows[kind]);}
  return new Response(JSON.stringify({code:0,data}));
 };
 return {owner,rows,internal,jobs,db,cards,writes,files,sendAttempts,failDownload:()=>failDownload=true,loseSendResponse:()=>loseSendResponse=true,failPaid:id=>failPaidId=id,failUpload:()=>failUpload=true,restore:()=>globalThis.fetch=real,failNext:id=>failId=id,callback:(saved,action='accept-all',id,actor=saved.recipient)=>({header:{token:'verify',app_id:CFG.LARK_APP_ID,event_type:'card.action.trigger'},event:{operator:{open_id:actor},action:{value:{externalFinance:true,nonce:saved.nonce,action,id}}}})};
}
test('independent End User accounts are valid; PEAK company and customer evidence are required',()=>{
 for(let i=0;i<5;i++)assert.equal(externalProblem(externalRow('dealpay',record('dealpay',i))),'');
 const p=record('partner');assert.equal(externalProblem(externalRow('partner',p)),'');p.fields['ลงบันทึกค่าใช้จ่ายใน PEAK'].link='https://doc.peakaccount.com/expenses?emi=MjUxNTQ2';assert.match(externalProblem(externalRow('partner',p)),/ไม่ตรงบริษัท/);
 const r=record('dealpay');r.fields['สลิปโอนเงินที่ใช้บริการกับตู้']=[];assert.match(externalProblem(externalRow('dealpay',r)),/หลักฐาน/);
});
test('attachment URL rotation and display case number do not invalidate the same record; financial edits do',async()=>{
 const r=record('dealpay'),hash=await externalFingerprint(externalRow('dealpay',r));r.fields['สลิปโอนเงินที่ใช้บริการกับตู้'][0].url='https://temporary/new';r.fields['Case Number']=[{text:'rerandomized'}];assert.equal(await externalFingerprint(externalRow('dealpay',r)),hash);
 r.fields['เลขที่บัญชีธนาคาร']='0000000000';assert.notEqual(await externalFingerprint(externalRow('dealpay',r)),hash);
 r.fields['เลขที่บัญชีธนาคาร']='8765432100';r.fields['สลิปโอนเงินที่ใช้บริการกับตู้'][0].file_token='replacement';assert.notEqual(await externalFingerprint(externalRow('dealpay',r)),hash);
});
test('full 11-record flow starts only at accounting and sends Not → May → Not without fake payment or PEAK writes',async()=>{
 const h=harness();try{
  for(let i=0;i<6;i++)h.rows.partner.push(record('partner',i));for(let i=0;i<5;i++)h.rows.dealpay.push(record('dealpay',i));
  await externalTick(h.owner);assert.equal(h.cards.size,0);
  for(const r of Object.values(h.rows).flat())r.fields[EF.request]=true;
  await externalTick(h.owner);assert.equal(h.cards.size,3);assert.ok([...h.cards.values()].every(c=>c.to==='ou_not'));
  const notKeys=[...h.db.get('external:active:not')];for(const k of notKeys){const saved=h.db.get(k);assert.ok((await externalCallback(h.owner,h.callback(saved))).ok);}
  await externalTick(h.owner);assert.equal(h.db.get('external:active:not').length,0);const mayKeys=[...h.db.get('external:active:may')];assert.equal(mayKeys.length,3);for(const r of Object.values(h.rows).flat())assert.ok(JSON.parse(r.fields[EF.audit]).delivery.may.message);
  for(const k of mayKeys){const saved=h.db.get(k);assert.equal(saved.recipient,'ou_may');assert.ok((await externalCallback(h.owner,h.callback(saved))).ok);}
  await externalTick(h.owner);assert.equal(h.db.get('external:active:transfer').length,1);
  for(const kind of Object.keys(h.rows))for(const r of h.rows[kind]){assert.equal(await externalStage(externalRow(kind,r)),'transfer');assert.notEqual(r.fields['รายการสำเร็จ'],true);assert.notEqual(r.fields['จ่ายแล้ว (PEAK)'],true);assert.match(r.fields[EF.delivery],/^ส่งแล้ว/);}
  assert.ok(h.writes.every(w=>!('ลงบันทึกค่าใช้จ่ายใน PEAK' in w.fields)&&!('เลขที่บัญชีธนาคาร' in w.fields)&&!('เลขบัญชีผู้รับเงิน' in w.fields)));
  const n=h.cards.size;await externalTick(h.owner);assert.equal(h.cards.size,n);
 }finally{h.restore();}
});

// Seed completed approvals/documents without rendering many PDFs in queue tests.
async function readyTransfer(kind,i){
 const r=record(kind,i),x=externalRow(kind,r),hash=await externalFingerprint(x);
 x.audit={version:1,fingerprintVersion:2,stage:'transfer',fingerprint:hash,epoch:'epoch-'+kind+i,accounting:{at:100},not:{actor:'ou_not',at:200},may:{actor:'ou_may',at:300}};
 r.fields[EF.audit]=JSON.stringify(x.audit);r.fields[ED.number]='DOC-'+kind+i;
 const meta={};for(const stage of ['request','approved']){const file=stage+'-'+kind+i;r.fields[ED[stage]]=[{file_token:file}];meta[stage]={file,fingerprint:hash,signature:await documentSignature(x,hash,stage),templateVersion:EXTERNAL_PDF_TEMPLATE_VERSION,signingVersion:1};}
 r.fields[ED.meta]=JSON.stringify(meta);return r;
}
test('new approvals notify Not with a fresh message while preserving one queue and stable portal link',async()=>{
 const h=harness();try{
  h.rows.partner.push(await readyTransfer('partner',0));await poll(h.owner);
  const key=h.db.get('external:active:transfer')[0],first=h.db.get(key);assert.equal(h.cards.size,1);
  h.rows.dealpay.push(await readyTransfer('dealpay',0));await poll(h.owner);
  assert.deepEqual(h.db.get('external:active:transfer'),[key]);assert.notEqual(h.db.get(key).message,first.message);assert.equal(h.cards.size,2);
  let text=JSON.stringify(h.cards.get(h.db.get(key).message).card);assert.match(text,/รอโอน 2 รายการ • รวม 208.00 THB/);assert.match(text,/คู่ค้า 1 รายการ • DEALPAY 1 รายการ/);
  assert.equal((await externalPortalAction(h.owner,{token:first.nonce,op:'rows'})).rows.length,2);
  h.rows.partner[0].fields['รายการสำเร็จ']=true;h.rows.dealpay[0].fields['จำนวนเงิน']=30;await poll(h.owner);
  text=JSON.stringify(h.cards.get(h.db.get(key).message).card);assert.match(text,/รอโอน 0 รายการ/);assert.doesNotMatch(text,/Customer 0|Vendor 0/);
  h.rows.dealpay.push(await readyTransfer('dealpay',1));await poll(h.owner);assert.equal(h.cards.size,3);assert.equal(h.db.get(key).signatures.length,1);await poll(h.owner);assert.equal(h.cards.size,3);
 }finally{h.restore();}
});
test('legacy transfer cards merge into the newest card and old links retire without financial writes',async()=>{
 const h=harness();try{
  h.rows.partner.push(await readyTransfer('partner',0));h.rows.dealpay.push(await readyTransfer('dealpay',0));
  for(let i=0;i<2;i++){const key='old'+i,saved={version:1,stage:'transfer',recipient:'ou_not',nonce:'nonce'+i,created:Date.now()-10000+i,message:'old-message'+i,signatures:[]};h.db.set(key,saved);h.db.set('external:nonce:'+saved.nonce,key);h.cards.set(saved.message,{to:'ou_not',card:{}});}
  h.db.set('external:active:transfer',['old0','old1']);const audits=Object.values(h.rows).flat().map(r=>r.fields[EF.audit]);
  await poll(h.owner);assert.deepEqual(h.db.get('external:active:transfer'),['old1']);assert.equal(h.cards.size,3);assert.equal(h.db.get('old1').signatures.length,2);assert.equal(h.db.get('old0').retired,true);
  assert.match(JSON.stringify(h.cards.get('old-message0').card),/รวมรายการรอโอนแล้ว/);assert.deepEqual(Object.values(h.rows).flat().map(r=>r.fields[EF.audit]),audits);
  await assert.rejects(()=>externalPortalAuth(h.owner,'nonce0'),/หมดอายุ/);await externalPortalAuth(h.owner,'nonce1');
  const current=h.db.get('old1');current.created=Date.now()-8*86400000;h.db.set('old1',current);await poll(h.owner);
  assert.equal(h.cards.size,4);assert.equal(h.db.get('external:active:transfer').length,1);assert.equal(h.db.get('old1').retired,true);
 }finally{h.restore();}
});
test('large queues remain one bounded card with exact totals and every row in the transfer portal',async()=>{
 const h=harness();try{
  for(let i=0;i<65;i++)h.rows.dealpay.push(await readyTransfer('dealpay',i));await poll(h.owner);
  assert.equal(h.cards.size,1);const saved=h.db.get(h.db.get('external:active:transfer')[0]),card=h.cards.get(saved.message).card,text=JSON.stringify(card);
  assert.match(text,/รอโอน 65 รายการ • รวม 1,300.00 THB/);assert.match(text,/แสดง \d+ จาก 65 รายการ/);assert.ok(new TextEncoder().encode(text).length<28000);
  assert.equal((await externalPortalAction(h.owner,{token:saved.nonce,op:'rows'})).rows.length,65);
  const demoRows=[externalRow('dealpay',h.rows.dealpay[0]),externalRow('dealpay',h.rows.dealpay[1])];demoRows[0].amount=0.1;demoRows[1].amount=0.2;demoRows[1].company={id:'PSH',name:'Example company'};
  assert.match(JSON.stringify(externalTransferCard(saved,demoRows,h.owner.env)),/รวม 0.30 THB/);
 }finally{h.restore();}
});
test('wrong actor/token cannot approve; duplicate and partial failed clicks preserve successful rows',async()=>{
 const h=harness();try{
  for(let i=0;i<2;i++){const r=record('dealpay',i);r.fields[EF.request]=true;h.rows.dealpay.push(r);}await externalTick(h.owner);const saved=h.db.get(h.db.get('external:active:not')[0]);
  assert.deepEqual(await externalCallback(h.owner,h.callback(saved,'accept-all',undefined,'ou_may')),{ignored:true});
  const bad=h.callback(saved);bad.header.token='bad';await assert.rejects(()=>externalCallback(h.owner,bad),/Unauthorized/);
  h.failNext(h.rows.dealpay[1].record_id);const result=await externalCallback(h.owner,h.callback(saved));assert.equal(result.ok,false);assert.equal(await externalStage(externalRow('dealpay',h.rows.dealpay[0])),'may');assert.equal(await externalStage(externalRow('dealpay',h.rows.dealpay[1])),'not');
  const audit0=h.rows.dealpay[0].fields[EF.audit];await externalCallback(h.owner,h.callback(saved));assert.equal(h.rows.dealpay[0].fields[EF.audit],audit0);assert.equal(await externalStage(externalRow('dealpay',h.rows.dealpay[1])),'may');
 }finally{h.restore();}
});
test('changed data blocks May, requires accounting again, and retires old approval cards',async()=>{
 const h=harness();try{const r=record('partner');r.fields[EF.request]=true;h.rows.partner.push(r);await externalTick(h.owner);let saved=h.db.get(h.db.get('external:active:not')[0]);await externalCallback(h.owner,h.callback(saved));await externalTick(h.owner);saved=h.db.get(h.db.get('external:active:may')[0]);
  r.fields['ยอดโอนเงิน']=999;assert.equal(await externalStage(externalRow('partner',r)),'changed');assert.equal((await externalCallback(h.owner,h.callback(saved))).ok,false);assert.notEqual(r.fields[EF.may],true);
  r.fields[EF.request]=true;await externalTick(h.owner);assert.equal(await externalStage(externalRow('partner',r)),'not');assert.deepEqual(await externalCallback(h.owner,h.callback(saved)),{ignored:true});
 }finally{h.restore();}
});
test('a table resubmission takes priority over PDF refreshes and reports why it is waiting',async()=>{
 const h=harness();try{
  const r=record('partner',7);r.fields[EF.request]=true;h.rows.partner.push(r);
  await poll(h.owner);
  for(let i=0;i<4;i++){const other=record('partner',i);other.fields[EF.status]='รอบัญชีเช็ก';h.rows.partner.unshift(other);}
  r.fields['ยอดโอนเงิน']=510;r.fields[EF.request]=true;h.failUpload();
  await poll(h.owner);assert.match(r.fields[EF.status],/รับคำสั่งบัญชีแล้ว.*สร้าง PDF ไม่สำเร็จ/);
  assert.equal(r.fields[EF.request],true);
  await poll(h.owner);assert.equal(r.fields[EF.request],false);assert.equal(await externalStage(externalRow('partner',r)),'not');
  assert.match(r.fields[EF.delivery],/ส่งแล้ว/);
 }finally{h.restore();}
});
test('returned rows wait for accounting; raw result checkboxes do not create approval',async()=>{
 const h=harness();try{const r=record('dealpay');r.fields[EF.not]=true;r.fields[EF.may]=true;h.rows.dealpay.push(r);assert.equal(await externalStage(externalRow('dealpay',r)),'accounting');r.fields[EF.request]=true;await externalTick(h.owner);const saved=h.db.get(h.db.get('external:active:not')[0]);await externalCallback(h.owner,h.callback(saved,'return','dealpay:'+r.record_id));await externalTick(h.owner);assert.equal(await externalStage(externalRow('dealpay',r)),'returned');assert.equal(h.db.get('external:active:may').length,0);
 }finally{h.restore();}
});
test('transfer requires approved unchanged row, matching company/amount/account and unique slip; paid status is only set after attachment',async()=>{
 const h=harness();try{const r=record('dealpay');r.fields[EF.request]=true;h.rows.dealpay.push(r);await externalTick(h.owner);await externalCallback(h.owner,h.callback(h.db.get(h.db.get('external:active:not')[0])));await externalTick(h.owner);await externalCallback(h.owner,h.callback(h.db.get(h.db.get('external:active:may')[0])));await externalTick(h.owner);const saved=h.db.get(h.db.get('external:active:transfer')[0]),id='dealpay:'+r.record_id;
  const draft={id:'draft',owner:'ou_not',at:Date.now(),hash:'hash',refKey:'paidRef:ref',ref:'ref',file:'uploaded-file',ocr:{amount:20,currency:'THB',recipient_acct:'2100'}};h.db.set('external:draft:draft',draft);
  const run=company=>externalPortalAction(h.owner,{token:saved.nonce,op:'commit',pairs:[{draft:'draft',id,company}]});
  assert.equal((await run('PSH')).results[0].ok,false);assert.notEqual(r.fields['รายการสำเร็จ'],true);
  assert.equal((await run('ODP')).results[0].ok,true);assert.equal(r.fields['รายการสำเร็จ'],true);assert.equal(r.fields['หลักฐานการโอน'][0].file_token,'uploaded-file');
  const writes=h.writes.filter(w=>w.id===r.record_id);const attach=writes.findIndex(w=>'หลักฐานการโอน' in w.fields),paid=writes.findIndex(w=>w.fields['รายการสำเร็จ']===true);assert.ok(attach>=0&&paid>attach);
  assert.equal((await run('ODP')).results[0].already,true);await poll(h.owner);assert.ok(r.fields[ED.paid]?.length);assert.equal(documentMeta(externalRow('dealpay',r)).paid.fingerprint,await externalFingerprint(externalRow('dealpay',r)));const paidJob=[...h.db.values()].find(x=>x?.model?.stage==='paid');assert.equal(paidJob.model.paid.ref,'ref');assert.equal(paidJob.model.may.name,'May');
 }finally{h.restore();}
});
test('slip identity does not fall back to same amount, and external page uses its own authenticated API',()=>{const x=externalRow('dealpay',record('dealpay'));assert.equal(externalSlipFits({amount:20,currency:'THB',recipient_acct:'9999'},x),false);assert.equal(externalSlipFits({amount:20,currency:'THB',recipient_acct:'2100'},x),true);assert.match(externalTransferPage('abc'),/external-transfer-api/);});
test('legacy matcher cannot bypass external review or mark an external payment completed',async()=>{
 const env={SIGNING_SECRET:'test-key',ACCOUNTING_OPENIDS:'ou_accounting'},token=await signMatchToken(env,'ou_accounting');
 for(const kind of ['partner','dealpay']){const r=await matchApi('match-commit',new Request('https://example.test',{method:'POST',body:JSON.stringify({token,pairs:[{table:kind,record_id:'rec1',company_id:'ODP',image:''}]})}),env);const j=await r.json();assert.equal(j.results[0].ok,false);assert.match(j.results[0].error,/การ์ดรอนอตโอน/);}
});

test('draft PDFs separate requester from payee, retain stable identity, and do not trigger approval',async()=>{
 const h=harness();try{const r=record('dealpay');r.fields[EF.status]='รอบัญชีเช็ก';h.rows.dealpay.push(r);await poll(h.owner);
 assert.equal(h.files.size,1);assert.equal(h.cards.size,0);assert.equal(await externalStage(externalRow('dealpay',r)),'accounting');
 const original=documentMeta(externalRow('dealpay',r)),number=r.fields[ED.number],pdf=await PDFDocument.load([...h.files.values()][0]);assert.match(pdf.getTitle(),/ใบขออนุมัติคืนเงินลูกค้า/);assert.equal(pdf.getPageCount(),2);
 const job=[...h.db.values()].find(x=>x?.model);assert.equal(job.model.requester,'Employee requester');assert.equal(job.model.payee,'Customer 0');assert.equal(job.model.may,null);
 r.fields['Case Number']=[{text:'NEW-RANDOM-NUMBER'}];await poll(h.owner);assert.equal(h.files.size,1);assert.equal(r.fields[ED.number],number);
 r.fields['จำนวนเงิน']=30;await poll(h.owner);assert.equal(h.files.size,2);assert.equal(r.fields[ED.number],number);assert.equal(r.fields[ED.history][0].file_token,original.request.file);
 }finally{h.restore();}
});
test('PDF failures keep request pending; publishing retry reuses uploaded bytes and cannot bypass approval',async()=>{
 const h=harness();try{const r=record('partner');r.fields[EF.request]=true;h.rows.partner.push(r);h.failUpload();await poll(h.owner);assert.equal(h.cards.size,0);assert.equal(r.fields[EF.request],true);assert.equal(r.fields[EF.audit],undefined);
 h.failNext(r.record_id);await poll(h.owner);assert.equal(h.files.size,1);assert.equal(h.cards.size,0);await poll(h.owner);assert.equal(h.files.size,1);assert.equal(h.cards.size,1);
 const saved=h.db.get(h.db.get('external:active:not')[0]);const d=await externalDocumentAccess(h.owner,{k:saved.nonce,id:'partner:'+r.record_id,stage:'request'});assert.ok(d.bytes.byteLength>1000);
 await assert.rejects(()=>externalDocumentAccess(h.owner,{k:'bad',id:'partner:'+r.record_id,stage:'request'}));await assert.rejects(()=>externalDocumentAccess(h.owner,{k:saved.nonce,id:'partner:'+r.record_id,stage:'approved'}));
 r.fields['เลขบัญชีผู้รับเงิน']='9999999999';await assert.rejects(()=>externalDocumentAccess(h.owner,{k:saved.nonce,id:'partner:'+r.record_id,stage:'request'}));
 }finally{h.restore();}
});

test('legacy approvals migrate only if original financial data matches, preserving actors and times',async()=>{
 const h=harness();try{const r=record('partner');h.rows.partner.push(r);let x=externalRow('partner',r);
 const old=await digest([x.kind,x.table,x.r.record_id,x.company.id,x.name,x.account,x.bank,x.amount,x.currency,x.detail,'',x.machine,x.peak,x.evidence]);
 const audit={version:1,stage:'may',epoch:'old',fingerprint:old,accounting:{at:100},not:{actor:'ou_not',at:200}};r.fields[EF.audit]=JSON.stringify(audit);r.fields[EF.status]='นอตตรวจผ่าน • รอเมย์อนุมัติ';await poll(h.owner);
 const migrated=JSON.parse(r.fields[EF.audit]);assert.equal(migrated.fingerprintVersion,2);assert.equal(migrated.legacyFingerprint,old);assert.deepEqual(migrated.not,audit.not);assert.deepEqual(migrated.accounting,audit.accounting);assert.equal(migrated.may,undefined);assert.notEqual(migrated.epoch,'old');assert.equal(await externalStage(externalRow('partner',r)),'may');assert.equal(h.cards.size,1);
 r.fields[EF.audit]=JSON.stringify(audit);r.fields['ยอดโอนเงิน']=999;await poll(h.owner);assert.equal(JSON.parse(r.fields[EF.audit]).fingerprintVersion,undefined);assert.equal(await externalStage(externalRow('partner',r)),'changed');
 }finally{h.restore();}
});

test('PDF layout refresh preserves approvals, financial identity, and active review cards',async()=>{
 const h=harness();try{
  const r=record('dealpay');r.fields[EF.request]=true;h.rows.dealpay.push(r);await externalTick(h.owner);
  await externalCallback(h.owner,h.callback(h.db.get(h.db.get('external:active:not')[0])));await externalTick(h.owner);
  const beforeAudit=r.fields[EF.audit],beforeHash=await externalFingerprint(externalRow('dealpay',r)),beforeCards=h.cards.size,number=r.fields[ED.number];
  const meta=documentMeta(externalRow('dealpay',r)),oldFile=meta.request.file;delete meta.request.templateVersion;r.fields[ED.meta]=JSON.stringify(meta);
  const key=[...h.db.keys()].find(k=>k.startsWith('external:document:')&&k.endsWith(':pdf:'+EXTERNAL_PDF_TEMPLATE_VERSION));
  const oldJob=h.db.get(key);h.db.delete(key);h.db.set(key.replace(/:pdf:\d+$/,''),oldJob);
  assert.equal(await externalStage(externalRow('dealpay',r)),'may');await poll(h.owner);
  assert.equal(r.fields[EF.audit],beforeAudit);assert.equal(await externalFingerprint(externalRow('dealpay',r)),beforeHash);
  assert.equal(h.cards.size,beforeCards);assert.equal(r.fields[ED.number],number);assert.equal(await externalStage(externalRow('dealpay',r)),'may');
  const refreshed=documentMeta(externalRow('dealpay',r));assert.equal(refreshed.request.templateVersion,EXTERNAL_PDF_TEMPLATE_VERSION);assert.notEqual(refreshed.request.file,oldFile);assert.equal(refreshed.request.revision,meta.request.revision+1);
  assert.ok(r.fields[ED.history].some(a=>a.file_token===oldFile));await poll(h.owner);assert.equal(h.files.size,2);
 }finally{h.restore();}
});

test('formal signatures require actual approval, matching company profile, and original private assets',async()=>{
 const h=harness();try{
  const r=record('dealpay');r.fields[EF.request]=true;h.rows.dealpay.push(r);await externalTick(h.owner);
  assert.equal([...h.db.values()].find(v=>v?.model)?.model.signing,null);
  let x=externalRow('dealpay',r);await assert.rejects(()=>prepareSigningProfile(h.owner,x,h.owner.documentContext),/อนุมัติจริง/);
  await externalCallback(h.owner,h.callback(h.db.get(h.db.get('external:active:not')[0])));await externalTick(h.owner);
  await externalCallback(h.owner,h.callback(h.db.get(h.db.get('external:active:may')[0])));x=externalRow('dealpay',r);
  h.owner.documentContext.signing.get('ODP').approver='Someone else';await assert.rejects(()=>prepareSigningProfile(h.owner,x,h.owner.documentContext),/ทะเบียนบริษัท/);
  h.owner.documentContext.signing.get('ODP').approver='May';const profile=await prepareSigningProfile(h.owner,x,h.owner.documentContext);assert.equal(profile.actor,'ou_may');assert.equal(profile.at,x.audit.may.at);assert.equal(profile.stampId,'stamp');
  h.owner.signingAssetCache.value.assets.stamp={...fakeAsset,sha256:'bad'};await assert.rejects(()=>prepareSigningProfile(h.owner,x,h.owner.documentContext),/ไฟล์ลงนามเปลี่ยน/);h.owner.signingAssetCache.value.assets.stamp=fakeAsset;
  await externalTick(h.owner);const job=[...h.db.values()].find(v=>v?.model?.stage==='approved');assert.equal(job.model.signing.name,'May');assert.equal(job.model.signing.signatureHash,fakeAsset.sha256);assert.equal(job.model.signing.signature,undefined);
  const meta=documentMeta(externalRow('dealpay',r));assert.equal(meta.approved.signingVersion,1);assert.equal(meta.approved.approvedAt,x.audit.may.at);
  await assert.rejects(()=>renderExternalPdf({...job.model,signing:null}),/ข้อมูลลงนาม/);
 }finally{h.restore();}
});

function readyInternal(){
 const j={key:'job-internal',summaryId:'recinternal',state:'APPROVED',company:{id:'ODP',name:company},employee:{name:'Employee',accountName:'Employee',accountNo:'1234567890',bankName:'SCB'},currency:'THB',docId:'doc-internal',docNo:'INT-001',pdfUrl:'https://example.test/request',approvedPdf:'https://example.test/approved',items:[{amount:231}]};
 const r={record_id:j.summaryId,fields:{'รหัสงานระบบ':j.key,'บริษัท':company,'รหัสบริษัท':'ODP','ชื่อพนักงาน':'Employee','ชื่อบัญชี':'Employee','เลขบัญชี':'1234567890','ธนาคาร':'SCB','Doc ID':j.docId,'เลขใบขอเบิก':j.docNo,'ใบขอเบิก PDF':{link:j.pdfUrl},'PDF อนุมัติแล้ว':{link:j.approvedPdf},'ยอดรวม':231,'จำนวนรายการ':1,'สถานะ':'อนุมัติแล้ว',Approve:true,'นอตตรวจผ่าน':true,'ผู้ตรวจสอบก่อนอนุมัติ':'NOT','เวลานอตตรวจผ่าน':123}};
 return {r,j};
}
test('unified card and both old links include internal, partner and refund queues; TEST stays isolated',async()=>{
 const h=harness();try{
  const {r,j}=readyInternal();h.internal.push(r);h.jobs.push(j);h.rows.partner.push(await readyTransfer('partner',0));h.rows.dealpay.push(await readyTransfer('dealpay',0));
  const old={stage:'transfer',recipient:'ou_not',created:Date.now(),nonce:'internal-link',message:'internal-card',signatures:[]};h.db.set('old-internal',old);h.db.set('nonce:internal-link','old-internal');h.db.set('active:transfer',['old-internal']);h.cards.set('internal-card',{to:'ou_not',card:{}});
  await poll(h.owner,{unified:true});const saved=h.db.get(h.db.get('external:transfer-summary'));
  assert.equal(saved.unified,true);assert.equal(h.db.get('external:active:transfer').length,1);assert.deepEqual(h.db.get('active:transfer'),[]);
  assert.match(JSON.stringify(h.cards.get(saved.message).card),/รอโอน 3 รายการ • รวม 439.00 THB/);
  for(const token of [saved.nonce,'internal-link']){const response=await unifiedPortalAction(h.owner,{token,op:'rows'});assert.equal(response.rows.length,3);assert.deepEqual(new Set(response.rows.map(x=>x.kind)),new Set(['internal','partner','dealpay']));}
  h.db.set('test-card',{stage:'test',recipient:'ou_not',created:Date.now(),nonce:'test-link'});h.db.set('nonce:test-link','test-card');assert.equal((await unifiedPortalAction(h.owner,{token:'test-link',op:'rows'})).rows.length,0);
  await assert.rejects(()=>unifiedPortalAction(h.owner,{token:'test-link',op:'commit',pairs:[]}),/TEST/);await assert.rejects(()=>unifiedPortalAuth(h.owner,'missing'),/หมดอายุ/);
  h.db.set('wrong',{...old,recipient:'ou_other',nonce:'wrong'});h.db.set('nonce:wrong','wrong');await assert.rejects(()=>unifiedPortalAuth(h.owner,'wrong'),/สิทธิ์/);
 }finally{h.restore();}
});
test('mixed slips attach to each source before automatic completion, with shared duplicate protection and safe retry',async()=>{
 const h=harness();try{
  const {r,j}=readyInternal();h.internal.push(r);h.jobs.push(j);h.rows.partner.push(await readyTransfer('partner',0));h.rows.dealpay.push(await readyTransfer('dealpay',0));await poll(h.owner,{unified:true});const saved=h.db.get(h.db.get('external:transfer-summary'));
  const targets=[{id:r.record_id,kind:'internal',r,amount:231,acct:'7890'},{id:'partner:recpartner0',kind:'partner',r:h.rows.partner[0],amount:188,acct:'7800'},{id:'dealpay:recdealpay0',kind:'dealpay',r:h.rows.dealpay[0],amount:20,acct:'2100'}];
  for(let i=0;i<targets.length;i++){const t=targets[i];t.draft='mixed'+i;h.db.set((i===2?'external:draft:':'draft:')+t.draft,{id:t.draft,owner:'ou_not',at:Date.now(),hash:'mixedhash'+i,refKey:'paidRef:mixed'+i,ref:'reference'+i,file:'slip'+i,ocr:{amount:t.amount,currency:'THB',recipient_acct:t.acct}});}
  const run=(items,company='ODP')=>unifiedPortalAction(h.owner,{token:saved.nonce,op:'commit',pairs:items.map(t=>({id:t.id,draft:t.draft,company}))});
  assert.equal((await run([targets[0]],'PSH')).results[0].ok,false);assert.notEqual(r.fields['รายการสำเร็จ'],true);
  h.failPaid(r.record_id);h.failNext('recpartner0');const first=await run(targets);assert.deepEqual(first.results.map(x=>x.ok),[false,false,true]);
  assert.ok(r.fields['หลักฐานการโอน']?.length);assert.notEqual(r.fields['รายการสำเร็จ'],true);assert.notEqual(h.rows.partner[0].fields['รายการสำเร็จ'],true);
  const second=await run(targets);assert.ok(second.results.every(x=>x.ok));assert.equal(second.results[2].already,true);
  for(const t of targets){assert.equal(t.r.fields['รายการสำเร็จ'],true);assert.ok(t.r.fields['หลักฐานการโอน']?.length);const writes=h.writes.filter(w=>w.id===t.r.record_id);assert.ok(writes.findIndex(w=>w.fields['รายการสำเร็จ']===true)>writes.findIndex(w=>w.fields['หลักฐานการโอน']));}
  assert.equal((await run([{...targets[0],draft:targets[2].draft}])).results[0].ok,false);
  await poll(h.owner,{unified:true});assert.match(JSON.stringify(h.cards.get(saved.message).card),/รอโอน 0 รายการ/);
 }finally{h.restore();}
});


test('notification retries recover an accepted POST with the same UUID and never alert on unchanged polls',async()=>{
 const h=harness();try{
  h.rows.partner.push(await readyTransfer('partner',0));h.loseSendResponse();
  await assert.rejects(()=>poll(h.owner),/lost response/);assert.equal(h.cards.size,1);
  const key=h.db.get('external:transfer-summary'),pending=h.db.get(key);assert.ok(pending.notification);assert.equal(pending.message,undefined);
  h.rows.dealpay.push(await readyTransfer('dealpay',0));await poll(h.owner);
  assert.equal(h.cards.size,1);assert.equal(h.sendAttempts[0],h.sendAttempts[1]);assert.ok(h.db.get(key).message);assert.equal(h.db.get(key).notification,undefined);
  assert.match(JSON.stringify(h.cards.get(h.db.get(key).message).card),/รอโอน 2 รายการ/);
  await poll(h.owner);assert.equal(h.cards.size,1);assert.equal(h.sendAttempts.length,2);
 }finally{h.restore();}
});

test('an unreadable original attachment prevents publishing an incomplete PDF and retries safely',async()=>{
 const h=harness();try{
  const r=record('partner');r.fields[EF.request]=true;h.rows.partner.push(r);h.failDownload();
  await poll(h.owner);assert.equal(h.files.size,0);assert.equal(h.cards.size,0);assert.equal(r.fields[EF.audit],undefined);assert.match(r.fields[ED.status],/ไฟล์แนบ/);
  await poll(h.owner);assert.equal(h.files.size,1);assert.equal(h.cards.size,1);
  const pdf=await PDFDocument.load([...h.files.values()][0]);assert.equal(pdf.getPageCount(),2);
 }finally{h.restore();}
});

test('portal and transfer card expose actual submitted purposes, bounded to 100 characters',async()=>{
 const h=harness();try{
  const {r,j}=readyInternal();j.items[0].detail='ค่าน้ำมัน ไปดูตู้ชกมวย';h.internal.push(r);h.jobs.push(j);
  h.rows.partner.push(await readyTransfer('partner',0));await poll(h.owner,{unified:true});const saved=h.db.get(h.db.get('external:transfer-summary'));
  const result=await unifiedPortalAction(h.owner,{token:saved.nonce,op:'rows'});
  assert.equal(result.rows.find(x=>x.kind==='internal').summary,'ค่าน้ำมัน ไปดูตู้ชกมวย');assert.equal(result.rows.find(x=>x.kind==='partner').summary,'ค่าเดินทาง');
  assert.ok(result.rows.every(x=>x.summary.length<=100));assert.match(JSON.stringify(h.cards.get(saved.message).card),/ค่าน้ำมัน ไปดูตู้ชกมวย/);
 }finally{h.restore();}
});
test('partner Pay-In PDF supports QR text or an empty account without inventing bank digits',async()=>{
 const r=record('partner');r.fields['เอกสารแนบ']=[{file_token:'payin',name:'pay-in.pdf'}];
 for(const instructions of ['สแกนคิวอาร์โค้ด','สแกน QR 123456','']){
  r.fields['เลขบัญชีผู้รับเงิน']=instructions;const x=externalRow('partner',r);
  assert.equal(externalProblem(x),'');assert.equal(x.account,'');assert.ok(x.paymentInstructions);
  assert.equal(externalSlipFits({amount:x.amount,currency:'THB',recipient_acct:'123456'},x),false);
 }
 r.fields['เอกสารแนบ']=[];assert.match(externalProblem(externalRow('partner',r)),/เลขบัญชี/);
});

test('table review requires an authenticated field edit by the assigned reviewer for the current stage',async()=>{
 const h=harness();try{
  const r=record('partner');h.rows.partner.push(r);r.fields[EF.request]=true;await poll(h.owner);
  const submit=(actor,field,at,token='verify')=>externalTableReview(h.owner,{
   header:{token,event_id:'event-'+field,app_id:CFG.LARK_APP_ID,event_type:'drive.file.bitable_record_changed_v1'},
   event:{file_type:'bitable',file_token:CFG.BASE_TOKEN,table_id:EXTERNAL_TABLES.partner.table,
    operator_id:{open_id:actor},update_time:at,
    action_list:[{action:'record_edited',record_id:r.record_id,before_value:[{field_id:field,field_value:'false'}],after_value:[{field_id:field,field_value:'true'}]}]}
  });
  let at=Math.ceil(Date.now()/1000);r.fields[EF.not]=true;
  await submit('ou_not','not',at,'wrong');await submit('ou_may','not',at);await submit('ou_not','not',at-60);
  assert.equal(externalRow('partner',r).audit.stage,'not');
  await submit('ou_not','not',at);await submit('ou_not','not',at);await poll(h.owner);
  assert.equal(externalRow('partner',r).audit.stage,'may');
  r.fields[EF.may]=true;at=Math.ceil(Date.now()/1000);await submit('ou_may','may',at);await poll(h.owner);
  assert.equal(await externalStage(externalRow('partner',r)),'transfer');
 }finally{h.restore();}
});

test('urgent vouchers become one payable per company only once its full set is approved',async()=>{
 const h=harness();try{
  const ids=['13253992','0214ABC3','87B1F0C2','5F1C09E0','B48D04D6','D0D18E89','38F60B2E','9C0BB2BF','3681A606','2D1FD472','238D73B5','5D078123','1F2378C5','BD3AE734','C10D33F0','A6FF7CF4','4F91B02B'];
  const amounts=[20,20,32,37,37,33,25,20,30,30,27,33,42,20,300,42,52];
  const all=ids.map((suffix,i)=>{
   const {r,j}=readyInternal(),cid=i===15?'PSH':'PWA';
   j.summaryId=r.record_id='rec'+suffix;j.company={id:cid,name:cid};j.docNo=cid+'-20261124-'+suffix;
   j.key='k'+suffix;j.items[0].amount=amounts[i];
   Object.assign(r.fields,{'รหัสงานระบบ':j.key,'บริษัท':cid,'รหัสบริษัท':cid,'เลขใบขอเบิก':j.docNo,'ยอดรวม':amounts[i]});
   return {r,j};
  });
  const rows=await groupedInternalTransfers(h.owner,all);
  assert.deepEqual(rows.map(r=>[r.company_id,r.bills,r.amount]),[['PWA',16,758],['PSH',1,42]]);
  all[0].r.fields.Approve=false;
  assert.deepEqual((await groupedInternalTransfers(h.owner,all)).map(r=>r.amount),[42]);
 }finally{h.restore();}
});
