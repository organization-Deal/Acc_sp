// Read-only CFO bridge. PEAK credentials stay in the existing Worker environment.
import {unifiedPortalAuth} from './external-finance.js';
import {api,recordsPath,textOf,digest} from './finance.js';
import {CFG} from './config.js';

const BASE='https://api.peakaccount.com/api/v1/';
// SHA-256 of the dedicated backend-only read key. Revocation removes this hash.
const CFO_READ_KEY_HASH='c1f34aeacf4b9134a00d8ad9abfc28212c53c5ff55a8f47bf539fb5b974e3a28';
export async function peakSignature(connectId,stamp){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(connectId),{name:'HMAC',hash:'SHA-1'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(stamp))),x=>x.toString(16).padStart(2,'0')).join('');
}
async function headers(env){
 const stamp=new Date().toISOString().replace(/\D/g,'').slice(0,14);
 return {'Content-Type':'application/json','Time-Stamp':stamp,'Time-Signature':await peakSignature(env.PEAK_CONNECT_ID,stamp)};
}
async function client(owner){
 const {env,ctx}=owner;
 if(!env.PEAK_CONNECT_ID||!env.PEAK_PASSWORD)throw Error('ยังไม่มีข้อมูลเชื่อมต่อ PEAK ในระบบ');
 const cached=await ctx.storage.get('cfo:peak:client');
 if(cached&&cached.until>Date.now())return cached.token;
 const r=await fetch(BASE+'ClientToken',{method:'POST',headers:await headers(env),body:JSON.stringify({PeakClientToken:{connectId:env.PEAK_CONNECT_ID,password:env.PEAK_PASSWORD}}),signal:AbortSignal.timeout(25000)});
 if(!r.ok)throw Error('PEAK ยืนยันการเชื่อมต่อไม่สำเร็จ (HTTP '+r.status+')');
 const data=await r.json(),body=data.PeakClientToken||data.peakClientToken;
 if(String(body?.resCode)!=='200'||!body?.token)throw Error('PEAK ปฏิเสธข้อมูลเชื่อมต่อ ('+String(body?.resCode||'unknown').replace(/[^\w-]/g,'').slice(0,30)+')');
 await ctx.storage.put('cfo:peak:client',{token:body.token,until:Date.now()+23*3600000});return body.token;
}
const readQueues=new WeakMap();
async function get(owner,path,userToken,force=false){
 if(!userToken)throw Error('ยังไม่มี User Token ของบริษัท');
 const userKey=await digest(userToken),key='cfo:read:v1:'+await digest([userKey,path]);
 let state=readQueues.get(owner);if(!state){state={pending:new Map(),tails:new Map(),blocked:new Map()};readQueues.set(owner,state);}
 if(state.pending.has(key))return state.pending.get(key);
 const run=async()=>{
  const saved=await owner.ctx.storage.get(key);if(!force&&saved&&saved.until>Date.now())return {...saved,cached:true};
  for(let attempt=0;attempt<3;attempt++){
   const wait=(state.blocked.get(userKey)||0)-Date.now();if(wait>15000){const error=Error('PEAK จำกัดคำขอ กรุณารอ '+Math.ceil(wait/1000)+' วินาทีแล้วอัปเดตอีกครั้ง');error.retryAfterSeconds=Math.ceil(wait/1000);throw error;}if(wait>0)await new Promise(r=>setTimeout(r,wait));
   const r=await fetch(BASE+path,{headers:{...await headers(owner.env),'Client-Token':await client(owner),'User-Token':userToken},signal:AbortSignal.timeout(35000)});
   if(r.status===429){let body={};try{body=await r.json();}catch{}const seconds=Math.max(1,Number(r.headers?.get('Retry-After'))||Number(body.retryAfterSeconds)||2**attempt);state.blocked.set(userKey,Date.now()+seconds*1000);if(attempt<2&&seconds<=15)continue;const error=Error('PEAK จำกัดคำขอ กรุณารอ '+Math.ceil(seconds)+' วินาทีแล้วอัปเดตอีกครั้ง');error.retryAfterSeconds=Math.ceil(seconds);throw error;}
   if(!r.ok)throw Error('PEAK อ่านข้อมูลไม่สำเร็จ (HTTP '+r.status+')');
   const data=await r.json(),at=new Date().toISOString(),result={data,at,until:Date.now()+5*60000};
   if(Object.values(data).some(x=>x&&typeof x==='object'&&String(x.resCode)==='200')&&new TextEncoder().encode(JSON.stringify(result)).length<120000)await owner.ctx.storage.put(key,result);
   return {...result,cached:false};
  }
 };
 const result=(state.tails.get(userKey)||Promise.resolve()).catch(()=>{}).then(run);state.tails.set(userKey,result.catch(()=>{}));state.pending.set(key,result);
 try{return await result;}finally{state.pending.delete(key);}
}
export async function cfoRead(owner,b){
 const siteKey=typeof b.token==='string'&&b.token.length>=48&&await digest(b.token)===CFO_READ_KEY_HASH;
 if(siteKey){if(!['read','lark'].includes(b.op))throw Error('สิทธิ์ Dashboard ใช้อ่านข้อมูลเท่านั้น');}
 else {const saved=await unifiedPortalAuth(owner,b.token);if(saved.stage!=='transfer')throw Error('ไม่มีสิทธิ์ดูข้อมูล CFO');}
 if(!['probe','inspect','read','lark'].includes(b.op))throw Error('คำสั่ง CFO ไม่ถูกต้อง');
 const token=owner.env.PEAK_USER_TOKEN;
 if(b.op==='read'){
  const company=b.company||'PWA',emis={PWA:'MjUxNTQ2',PSH:'NTQzNjI3',ODP:'NDk1MTUw'};
  if(!emis[company])throw Error('บริษัทไม่ถูกต้อง');
  if(company!=='PWA'&&!siteKey)throw Error('ต้องใช้สิทธิ์ Dashboard สำหรับบริษัทนี้');
  const companyToken=company==='PWA'?token:b.peakToken;
  if(!companyToken)throw Error('ยังไม่เชื่อม PEAK ของ '+company);
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(b.month||''))throw Error('ระบุเดือน YYYY-MM');
  const start=b.fromMonth||b.month;
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(start)||start>b.month||start.slice(0,4)!==b.month.slice(0,4))throw Error('ช่วงเวลาไม่ถูกต้อง ต้องอยู่ในปีเดียวกัน');
  const [year,month]=b.month.split('-').map(Number),from=start.replace('-','')+'01',monthEnd=b.month.replace('-','')+new Date(Date.UTC(year,month,0)).getUTCDate(),to=b.toDate||monthEnd;
  if(!/^20\d{6}$/.test(to)||to<from||to>monthEnd||new Date(to.slice(0,4)+'-'+to.slice(4,6)+'-'+to.slice(6,8)+'T00:00:00Z').toISOString().slice(0,10).replaceAll('-','')!==to)throw Error('วันสิ้นสุดไม่ถูกต้อง');
  const page=Number(b.page||1);if(!Number.isInteger(page)||page<1||page>1000)throw Error('หน้าไม่ถูกต้อง');
  let path;
  if(['expenses','receipts'].includes(b.resource)){
   const resource=b.resource==='expenses'?'Expenses':'Receipts';
   if(b.code){if(!/^[A-Za-z0-9_-]{1,80}$/.test(b.code))throw Error('เลขเอกสารไม่ถูกต้อง');path=resource+'?code='+encodeURIComponent(b.code)+'&getResult=1';}
   else path=resource+'/list?dateStart='+from+'&dateEnd='+to+'&limit=100&page='+page+'&status=0'+(resource==='Expenses'?'&includeRemainAmount=1':'');
  }else if(b.resource==='accounts')path='PaymentMethods?limit=100&page='+page+'&getResult=1';
  else if(b.resource==='trial')path='FinancialReports/trialbalance?fromMonth='+start.replace('-','')+'&toMonth='+b.month.replace('-','')+'&isShowSubAccount=false';
  else if(b.resource==='chart')path='DailyJournals/accountcode';
  else if(b.resource==='contacts')path='Contacts/list?limit=100&page='+page;
  else if(b.resource==='ledger'){
   if(!/^\d{3,12}$/.test(b.account||''))throw Error('รหัสบัญชีไม่ถูกต้อง');
   path='FinancialReports/generalledger?fromDate='+from+'&toDate='+to+'&accountCode='+b.account+'&isShowSubAccount=true';
  }else throw Error('แหล่งข้อมูลไม่รองรับ');
  const result=await get(owner,path,companyToken,b.fresh==='1'),data=result.data;
  for(const [key,field] of [['PeakExpenses','expenses'],['PeakReceipts','receipts']])for(const row of data[key]?.[field]||[]){
   if(row.documentLink&&new URL(row.documentLink).searchParams.get('emi')!==emis[company])throw Error('ข้อมูล PEAK ไม่ตรงบริษัท '+company);
  }
  return {ok:true,company,at:result.at,cached:result.cached,data};
 }
 if(b.op==='lark'){
  const rows=[];let next='';
  do{const d=await api(owner.env,recordsPath(CFG.T_EXPENSE)+'?page_size=500'+(next?'&page_token='+encodeURIComponent(next):''));rows.push(...(d.items||[]));next=d.has_more?d.page_token:'';}while(next);
  return {ok:true,at:new Date().toISOString(),rows:rows.map(r=>{const f=r.fields;return {id:r.record_id,company:textOf(f['บริษัทที่เบิก']),date:f['วันที่ใช้จ่าย']||null,submittedAt:f['วันที่ส่งคำขอ']||null,amount:Number(f['จำนวนเงิน']),person:textOf(f['ผู้เบิก']),personIds:(f['ผู้เบิก']||[]).flatMap(p=>p.record_ids||[]),category:textOf(f['ประเภทค่าใช้จ่ายที่เบิก'])||textOf(f['หมวดค่าใช้จ่าย']),description:textOf(f['รายละเอียดค่าใช้จ่าย'])||textOf(f['AI Gen ค่าใช้จ่าย']),status:textOf(f['สถานะเบิก']),docNo:textOf(f['เลขคำขอ']),group:textOf(f['เลขรอบเบิก']),proof:['แนบ Pay Slip','แนบใบเสร็จ','แนบใบกำกับภาษี'].some(k=>f[k]?.length),url:'https://ljpth1hipfdu.jp.larksuite.com/base/'+CFG.BASE_TOKEN+'?table='+CFG.T_EXPENSE+'&record='+r.record_id};})};
 }
 const jobs=[['expenses','Expenses/list?limit=1&page=1&status=0&includeRemainAmount=1'],['receipts','Receipts/list?limit=1&page=1&status=0'],['accounts','PaymentMethods?limit=10&page=1&getResult=1']];
 if(b.op==='inspect'){jobs.splice(0,jobs.length,['expenseDetail','Expenses?code=EXP-202601073&getResult=1'],['receiptDetail','Receipts?code=RT-20260101002&getResult=1'],['monthExpenses','Expenses/list?dateStart=20261101&dateEnd=20261121&limit=100&page=1&status=0&includeRemainAmount=1'],['monthReceipts','Receipts/list?dateStart=20261101&dateEnd=20261121&limit=100&page=1&status=0'],['accounts','PaymentMethods?limit=100&page=1&getResult=1'],['ledger','FinancialReports/generalledger?fromDate=20261101&toDate=20261121&accountCode=111201&isShowSubAccount=true']);}
 const output={ok:true,source:'PEAK',at:new Date().toISOString(),results:{}};
 for(const [name,path] of jobs){try{output.results[name]=(await get(owner,path,token)).data;}catch(e){output.results[name]={error:e.message};}}
 try{output.results.larkExpense=(await api(owner.env,recordsPath(CFG.T_EXPENSE)+'?page_size=1'));}catch(e){output.results.larkExpense={error:e.message};}
 return output;
}
