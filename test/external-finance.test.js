import test from 'node:test';
import assert from 'node:assert/strict';
import {EF,EXTERNAL_TABLES,externalRow,externalFingerprint,externalProblem,externalStage,externalTick,externalCallback,externalPortalAction,externalSlipFits,externalTransferPage} from '../src/external-finance.js';
import {CFG} from '../src/config.js';
import {signMatchToken,matchApi} from '../src/match.js';
const company='บริษัท ออมนิ แดช เพย์ วอลเล็ต จำกัด';
function record(kind,i=0){return {record_id:'rec'+kind+i,fields:kind==='partner'?{'รายการเบิก':i+'PAY_','ชื่อบริษัท':company,'ชื่อบริษัทคู่ค้าผู้รับเงิน':'Vendor '+i,'ยอดโอนเงิน':188+i,'เลขบัญชีผู้รับเงิน':'12345678'+String(i).padStart(2,'0'),'ธนาคาร':'KBANK','สกุลเงิน':'Thai Baht (THB)','ชื่อรายการ':'ค่าเดินทาง','ลงบันทึกค่าใช้จ่ายใน PEAK':{link:'https://doc.peakaccount.com/expenses?emi=NDk1MTUw&eti=reference'},'เอกสารแนบ':[{file_token:'f'+i,url:'https://temporary/one'}]}:{'Case Number':[{text:'DEAL'+i+'TH'}],'บริษัท':company,'ชื่อบัญชีผู้รับเงิน':'Customer '+i,'จำนวนเงิน':20,'เลขที่บัญชีธนาคาร':'87654321'+String(i).padStart(2,'0'),'ธนาคาร':'SCB','ประเภทตู้':'ตู้ชกมวย','ชื่อสถานที่ตั้งตู้':'Location '+i,'สลิปโอนเงินที่ใช้บริการกับตู้':[{file_token:'f'+i,url:'https://temporary/one'}]}};}
function harness(){
 const rows={partner:[],dealpay:[]},db=new Map(),cards=new Map(),writes=[];let serial=0,failId='';
 const owner={env:{FINANCE_ENABLED:'true',LARK_VERIFICATION_TOKEN:'verify',WORKER_URL:'https://example.test',KV:{get:async()=> 'token'}},ctx:{storage:{get:async k=>structuredClone(db.get(k)),put:async(k,v)=>db.set(k,structuredClone(v))}}};
 const real=globalThis.fetch;
 globalThis.fetch=async(url,opt={})=>{
  const path=new URL(url).pathname,body=opt.body?JSON.parse(opt.body):{};let data={};
  if(path.includes('/im/v1/messages')){if(opt.method==='POST'){data.message_id='om_'+(++serial);cards.set(data.message_id,{to:body.receive_id,card:JSON.parse(body.content)});}else cards.get(path.split('/').pop()).card=JSON.parse(body.content);}
  else if(path.includes(CFG.T_EMPLOYEE))data.items=[{fields:{'Name (TH)':'นายธีร์ชนาภัทร รุ่งโรจน์สุทธิธนา','Lark open_id':'ou_not'}},{fields:{'Name (TH)':'นางสาวภัทร์ปรียา อภิรติวงศ์โชติ','Lark open_id':'ou_may'}}];
  else {const kind=Object.keys(EXTERNAL_TABLES).find(k=>path.includes(EXTERNAL_TABLES[k].table));assert.ok(kind,'unknown '+path);const r=rows[kind].find(r=>path.endsWith('/'+r.record_id));if(r){if(opt.method==='PUT'){if(failId===r.record_id){failId='';return new Response(JSON.stringify({code:1254290,msg:'rate limit'}));}writes.push({kind,id:r.record_id,fields:body.fields});Object.assign(r.fields,body.fields);}data.record=structuredClone(r);}else data.items=structuredClone(rows[kind]);}
  return new Response(JSON.stringify({code:0,data}));
 };
 return {owner,rows,db,cards,writes,restore:()=>globalThis.fetch=real,failNext:id=>failId=id,callback:(saved,action='accept-all',id,actor=saved.recipient)=>({header:{token:'verify',app_id:CFG.LARK_APP_ID,event_type:'card.action.trigger'},event:{operator:{open_id:actor},action:{value:{externalFinance:true,nonce:saved.nonce,action,id}}}})};
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
  await externalTick(h.owner);assert.equal(h.db.get('external:active:not').length,0);const mayKeys=[...h.db.get('external:active:may')];assert.equal(mayKeys.length,3);
  for(const k of mayKeys){const saved=h.db.get(k);assert.equal(saved.recipient,'ou_may');assert.ok((await externalCallback(h.owner,h.callback(saved))).ok);}
  await externalTick(h.owner);assert.equal(h.db.get('external:active:transfer').length,3);
  for(const kind of Object.keys(h.rows))for(const r of h.rows[kind]){assert.equal(await externalStage(externalRow(kind,r)),'transfer');assert.notEqual(r.fields['รายการสำเร็จ'],true);assert.notEqual(r.fields['จ่ายแล้ว (PEAK)'],true);assert.match(r.fields[EF.delivery],/^ส่งแล้ว/);}
  assert.ok(h.writes.every(w=>!('ลงบันทึกค่าใช้จ่ายใน PEAK' in w.fields)&&!('เลขที่บัญชีธนาคาร' in w.fields)&&!('เลขบัญชีผู้รับเงิน' in w.fields)));
  const n=h.cards.size;await externalTick(h.owner);assert.equal(h.cards.size,n);
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
  assert.equal((await run('ODP')).results[0].already,true);
 }finally{h.restore();}
});
test('slip identity does not fall back to same amount, and external page uses its own authenticated API',()=>{const x=externalRow('dealpay',record('dealpay'));assert.equal(externalSlipFits({amount:20,currency:'THB',recipient_acct:'9999'},x),false);assert.equal(externalSlipFits({amount:20,currency:'THB',recipient_acct:'2100'},x),true);assert.match(externalTransferPage('abc'),/external-transfer-api/);});
test('legacy matcher cannot bypass external review or mark an external payment completed',async()=>{
 const env={SIGNING_SECRET:'test-key',ACCOUNTING_OPENIDS:'ou_accounting'},token=await signMatchToken(env,'ou_accounting');
 for(const kind of ['partner','dealpay']){const r=await matchApi('match-commit',new Request('https://example.test',{method:'POST',body:JSON.stringify({token,pairs:[{table:kind,record_id:'rec1',company_id:'ODP',image:''}]})}),env);const j=await r.json();assert.equal(j.results[0].ok,false);assert.match(j.results[0].error,/การ์ดรอนอตโอน/);}
});
