// Read-only CFO bridge. PEAK credentials stay in the existing Worker environment.
import {unifiedPortalAuth} from './external-finance.js';
import {api,recordsPath} from './finance.js';
import {CFG} from './config.js';

const BASE='https://api.peakaccount.com/api/v1/';
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
async function get(owner,path,userToken){
 const {env}=owner;
 if(!userToken)throw Error('ยังไม่มี User Token ของบริษัท');
 const r=await fetch(BASE+path,{headers:{...await headers(env),'Client-Token':await client(owner),'User-Token':userToken},signal:AbortSignal.timeout(35000)});
 if(!r.ok)throw Error('PEAK อ่านข้อมูลไม่สำเร็จ (HTTP '+r.status+')');
 return r.json();
}
export async function cfoRead(owner,b){
 const saved=await unifiedPortalAuth(owner,b.token);
 if(saved.stage!=='transfer')throw Error('ไม่มีสิทธิ์ดูข้อมูล CFO');
 if(b.op!=='probe')throw Error('คำสั่ง CFO ไม่ถูกต้อง');
 const token=owner.env.PEAK_USER_TOKEN;
 const jobs=[['expenses','Expenses/list?limit=1&page=1&status=0&includeRemainAmount=1'],['receipts','Receipts/list?limit=1&page=1&status=0'],['accounts','PaymentMethods?limit=10&page=1&getResult=1']];
 const output={ok:true,source:'PEAK',at:new Date().toISOString(),results:{}};
 for(const [name,path] of jobs){try{output.results[name]=await get(owner,path,token);}catch(e){output.results[name]={error:e.message};}}
 try{output.results.larkExpense=(await api(owner.env,recordsPath(CFG.T_EXPENSE)+'?page_size=1'));}catch(e){output.results.larkExpense={error:e.message};}
 return output;
}
