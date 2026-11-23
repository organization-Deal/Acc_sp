import {ED,documentReady,documentCurrent,ensureExternalDocument,readExternalDocument} from './external-documents.js';
// Partner payments and per-customer refunds. This module never transfers money or creates PEAK documents.
import {api,recordsPath,people,textOf,digest,verifiedCallback,fingerprint} from './finance.js';
import {CFG} from './config.js';
import {companyFromName} from './companies.js';
import {matchOCR} from './match.js';
import {uploadBytesToBitable} from './lark.js';
import {transferPage,portalAuth,portalAction,internalTransferRows,slipFits} from './transfer.js';
import {expenseSummary} from './expense-summary.js';
import {internalTransferDocument} from './internal-transfer-document.js';

export const EXTERNAL_FLOW_VERSION='external-flow-v4-document-payment';
export const EF={request:'บัญชีเช็กแล้ว → ส่งให้นอต',status:'สถานะงาน',not:'นอตตรวจผ่าน',may:'เมย์อนุมัติ',delivery:'หลักฐานส่งให้นอต',audit:'ข้อมูล Flow (ระบบ)'};
export const EXTERNAL_TABLES={
 partner:{table:'tbldczVhrFWfJ5ze',label:'คู่ค้า',doc:'รายการเบิก',company:'ชื่อบริษัท',name:'ชื่อบริษัทคู่ค้าผู้รับเงิน',amount:'ยอดโอนเงิน',account:'เลขบัญชีผู้รับเงิน',detail:'ชื่อรายการ',attachments:['เอกสารแนบ']},
 dealpay:{table:'tblQ1irGp6iyz0Mc',label:'DEALPAY คืนเงินลูกค้า',doc:'Case Number',company:'บริษัท',name:'ชื่อบัญชีผู้รับเงิน',amount:'จำนวนเงิน',account:'เลขที่บัญชีธนาคาร',detail:'ชื่อสถานที่ตั้งตู้',attachments:['สลิปโอนเงินที่ใช้บริการกับตู้','หลักฐานในระบบที่ลูกค้าจ่ายมา']}
};
const ePeakCompany={PSH:'NTQzNjI3',PWA:'MjUxNTQ2',ODP:'NDk1MTUw'};
const eDigits=v=>textOf(v).replace(/\D/g,'');
const eLink=v=>v&&typeof v==='object'?v.link||'':textOf(v);
const eMoney=v=>Number(v).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
const eMd=v=>textOf(v).replace(/[\\*_\[\]<>]/g,' ').replace(/\r?\n/g,' ');
const ePlain=content=>({tag:'plain_text',content});
const ePara=content=>({tag:'div',text:{tag:'lark_md',content}});
const eButton=(label,value,url)=>({tag:'button',text:ePlain(label),type:'default',...(url?{url}:{value})});
const eCard=(title,elements,color='blue')=>({config:{wide_screen_mode:true,update_multi:true,enable_forward:false},header:{template:color,title:ePlain(title)},elements});
const eAudit=r=>{try{const a=JSON.parse(textOf(r.fields[EF.audit]));return a?.version===1?a:null;}catch{return null;}};
const eClosed=r=>r.fields['รายการสำเร็จ']===true||r.fields['จ่ายแล้ว (PEAK)']===true;
const eUrl=x=>'https://ljpth1hipfdu.jp.larksuite.com/base/'+CFG.BASE_TOKEN+'?table='+x.table+'&record='+encodeURIComponent(x.r.record_id);
export function externalRow(kind,r){
 const t=EXTERNAL_TABLES[kind];if(!t)throw Error('Unknown external table');const f=r.fields||{},company=companyFromName(textOf(f[t.company]));
 const evidence=t.attachments.map(k=>[k,(f[k]||[]).map(a=>String(a.file_token||'')).filter(Boolean).sort()]);
 const requesters=(Array.isArray(f['การเงินที่ทำเรื่องเบิก'])?f['การเงินที่ทำเรื่องเบิก']:[]).map(p=>({id:String(p.id||''),name:String(p.name||'')}));
 const rawAccount=textOf(f[t.account]).trim();
 const account=eDigits(rawAccount);
 const hasPaymentPdf=kind==='partner'&&(f['เอกสารแนบ']||[]).some(a=>a.file_token&&(/\.pdf$/i.test(a.name||'')||a.type==='application/pdf'));
 const hasBankNumber=/^[0-9\s-]+$/.test(rawAccount)&&/^\d{6,20}$/.test(account);
 const usesDocument=!rawAccount||/สแกน|คิวอาร์|คิวอา|\bQR\b|pay[- ]?in|ดู.*(?:เอกสาร|ไฟล์|แนบ|pdf)/i.test(rawAccount);
 const documentPayment=hasPaymentPdf&&!hasBankNumber&&(usesDocument||!/^\d{6,20}$/.test(account));
 return {documentPayment,paymentInstructions:documentPayment?(rawAccount||'ดูวิธีชำระใน PDF แนบ'):'',requesters,createdAt:Number(f[kind==='partner'?'วันที่ทำรายการ':'Date Created']||r.created_time||0),kind,table:t.table,r,id:kind+':'+r.record_id,doc:textOf(f[t.doc]),company,name:textOf(f[t.name]),amount:Number(f[t.amount]),account:documentPayment?'':account,bank:textOf(f['ธนาคาร']),currency:kind==='dealpay'?'THB':/THB|BAHT/i.test(textOf(f['สกุลเงิน']))?'THB':'',detail:textOf(f[t.detail]),note:textOf(f[kind==='dealpay'?'เหตุผลขอคืนเงิน':'เหตุผลในการเบิกเงิน'])||(kind==='dealpay'?'ลูกค้าชำระเงินแล้วไม่สามารถใช้บริการตู้ได้':''),machine:textOf(f['ประเภทตู้']),peak:eLink(f['ลงบันทึกค่าใช้จ่ายใน PEAK']),evidence,audit:eAudit(r)};
}
export async function externalFingerprint(x){
 // file_token is stable; signed download URLs and the random display case number are not financial identity.
 const fields=[x.kind,x.table,x.r.record_id,x.company?.id||'',x.name,x.account,x.bank,x.amount,x.currency,x.detail,x.note,x.machine,x.peak,x.evidence,x.requesters];
 if(x.documentPayment)fields.push(x.paymentInstructions);
 return digest(fields);
}
// Preserve genuine pre-document decisions only when their original financial snapshot still matches.
export async function externalUpgradeAudit(owner,x){
 const a=x.audit;if(!a||a.fingerprintVersion===2||!a.accounting?.at)return x;
 const old=await digest([x.kind,x.table,x.r.record_id,x.company?.id||'',x.name,x.account,x.bank,x.amount,x.currency,x.detail,textOf(x.r.fields['เหตุผลในการเบิกเงิน']),x.machine,x.peak,x.evidence]);
 if(a.fingerprint!==old)return x;
 const upgraded={...a,fingerprintVersion:2,legacyFingerprint:a.fingerprint,fingerprint:await externalFingerprint(x),schemaUpgradedAt:Date.now(),epoch:crypto.randomUUID()};
 await eWrite(owner.env,x,{[EF.audit]:JSON.stringify(upgraded)});return x;
}
export function externalProblem(x){
 if(!x.requesters.length||x.requesters.some(p=>!p.id||!p.name))return 'ระบุพนักงานผู้ตั้งเบิกก่อน';
 if(x.kind==='dealpay'&&!x.note)return 'ระบุเหตุผลขอคืนเงินก่อน';
 if(!x.company)return 'เลือกบริษัทผู้จ่ายก่อน';
 if(!Number.isFinite(x.amount)||x.amount<=0)return 'ยอดเงินไม่ถูกต้อง';
 if(!x.name||!x.documentPayment&&(!x.bank||!/^\d{6,20}$/.test(x.account)))return 'ชื่อผู้รับ ธนาคาร หรือเลขบัญชีไม่ครบ';
 if(x.currency!=='THB')return 'รอบนี้รองรับเงินบาทเท่านั้น';
 if(!x.detail)return 'รายละเอียดรายการไม่ครบ';
 if(x.kind==='partner'&&!x.peak)return 'แนบลิงก์ PEAK เดิมก่อน';
 if(x.peak){try{const u=new URL(x.peak);if(u.protocol!=='https:'||!['doc.peakaccount.com','secure.peakaccount.com'].includes(u.hostname)||u.searchParams.get('emi')!==ePeakCompany[x.company.id])return 'ลิงก์ PEAK ไม่ตรงบริษัทผู้จ่าย';}catch{return 'ลิงก์ PEAK ไม่ถูกต้อง';}}
 if(x.kind==='dealpay'&&!x.evidence.some(([,tokens])=>tokens.length))return 'แนบหลักฐานลูกค้าจ่ายแล้วใช้ตู้ไม่ได้ก่อน';
 return '';
}
export async function externalStage(x){
 if(eClosed(x.r))return 'closed';
 if(externalProblem(x))return 'blocked';
 const a=x.audit;if(!a)return 'accounting';
 if(a.fingerprint!==await externalFingerprint(x))return 'changed';
 if(a.stage==='returned')return 'returned';
 if(!a.accounting?.at)return 'accounting';
 if(!await documentReady(x,'request',a.fingerprint))return 'documents';
 if(a.stage==='not')return 'not';
 if(!a.not?.actor||!a.not?.at)return 'blocked';
 if(a.stage==='may')return 'may';
 if(a.stage==='transfer'&&a.may?.actor&&a.may?.at)return await documentReady(x,'approved',a.fingerprint)?'transfer':'documents';
 return 'blocked';
}
const eStatus={documents:'รอสร้างเอกสาร PDF',accounting:'รอบัญชีเช็ก',not:'บัญชีเช็กแล้ว • รอนอตตรวจ',may:'นอตตรวจผ่าน • รอเมย์อนุมัติ',transfer:'เมย์อนุมัติแล้ว • รอนอตโอน',returned:'ส่งกลับให้บัญชีตรวจใหม่',closed:'บันทึกโอนแล้ว'};
// One reviewed snapshot only. A resubmission needs its own authorization.
const delegatedSnapshot='f9bafaa2b570faeb137c462e012bd3db77ef4531d08f9351c206b57cd9d5bfa4';
const delegatedEpoch='d76c44d0-66c9-4e21-a9b9-d7a076b37d4c';
const permitsDelegate=x=>x.kind==='partner'&&x.audit?.fingerprint===delegatedSnapshot&&x.audit?.epoch===delegatedEpoch;
const statusFor=(stage,a)=>stage==='transfer'&&a?.may?.delegated?'นอตอนุมัติแทนเมย์แล้ว • รอนอตโอน':eStatus[stage];
async function eList(env,table){let out=[],page='';do{const d=await api(env,recordsPath(table)+'?page_size=500'+(page?'&page_token='+encodeURIComponent(page):''));out.push(...d.items||[]);page=d.has_more?d.page_token:'';}while(page);return out;}
export async function externalSnapshot(env){return (await Promise.all(Object.entries(EXTERNAL_TABLES).map(async([kind,t])=>(await eList(env,t.table)).map(r=>externalRow(kind,r))))).flat();}
async function eFresh(env,x){return externalRow(x.kind,(await api(env,recordsPath(x.table)+'/'+x.r.record_id)).record);}
async function eWrite(env,x,fields){await api(env,recordsPath(x.table)+'/'+x.r.record_id,'PUT',{fields});Object.assign(x.r.fields,fields);x.audit=eAudit(x.r);}
async function eStateWrite(env,x,a,extra={}){await eWrite(env,x,{[EF.audit]:JSON.stringify(a),[EF.status]:statusFor(a.stage,a)||'รอบัญชีเช็ก',[EF.not]:!!a.not,[EF.may]:!!a.may,...extra});}
export async function externalAccounting(owner,row){
 const x=await eFresh(owner.env,row);if(x.r.fields[EF.request]!==true)return x;
 const problem=externalProblem(x);if(eClosed(x.r)||problem){await eWrite(owner.env,x,{[EF.request]:false,[EF.status]:eClosed(x.r)?eStatus.closed:'ยังไม่ส่ง • '+problem});return x;}
 const fingerprint=await externalFingerprint(x),old=x.audit;
 if(!await documentReady(x,'request',fingerprint))return x;
 if(old?.fingerprint===fingerprint&&['may','transfer'].includes(old.stage)){
  await eWrite(owner.env,x,{[EF.request]:false,[EF.status]:statusFor(old.stage,old)});return x;
 }
 const at=Date.now(),a={version:1,fingerprintVersion:2,stage:'not',fingerprint,epoch:crypto.randomUUID(),accounting:{at,actor:'บัญชีตรวจผ่านจากช่องคำสั่งในตาราง'},history:[...(old?.history||[]),...(old?[{stage:old.stage,accounting:old.accounting,not:old.not,may:old.may,fingerprint:old.fingerprint}]:[])].slice(-10)};
 await eStateWrite(owner.env,x,a,{[EF.request]:false,[EF.delivery]:'รอส่งให้นอต'});return x;
}
async function eSend(env,to,c,key){const d=await api(env,'im/v1/messages?receive_id_type=open_id','POST',{receive_id:to,msg_type:'interactive',content:JSON.stringify(c),uuid:(await digest(key)).slice(0,50)});if(!d.message_id)throw Error('ส่งไม่สำเร็จ: ไม่มีรหัสข้อความ');return d.message_id;}
async function ePatch(owner,key,saved,c){const hash=await digest(c);if(saved.renderHash===hash)return;await api(owner.env,'im/v1/messages/'+encodeURIComponent(saved.message),'PATCH',{content:JSON.stringify(c)});saved.renderHash=hash;await owner.ctx.storage.put(key,saved);}
const eDocumentUrl=(x,nonce,stage,env)=> (env?.WORKER_URL||'https://accsp2026.organization-23c.workers.dev')+'/?act=external-document&k='+encodeURIComponent(nonce)+'&id='+encodeURIComponent(x.id)+'&stage='+stage;
function eDescription(x){return '**'+eMd(EXTERNAL_TABLES[x.kind].label)+' • '+eMd(x.r.fields[ED.number]||x.doc)+'**\n'+eMd(x.company?.name||'ยังไม่ระบุบริษัท')+'\n'+eMd(x.detail)+(x.machine?' • '+eMd(x.machine):'')+'\nผู้รับ: '+eMd(x.name)+' • **'+eMoney(x.amount)+' '+x.currency+'**\n'+eMd(x.bank)+' • '+eMd(x.paymentInstructions||x.account)+'\n'+(x.peak?'[ดู PEAK เดิม]('+x.peak+') | ':'')+'[เปิดรายการและหลักฐาน]('+eUrl(x)+')';}
async function eRender(saved,all){
 const elements=[ePara(saved.delegate?'สิทธิ์เฉพาะใบนี้ • ระบบบันทึกนอตเป็นผู้อนุมัติแทนเมย์': 'บัญชีเช็ก → นอตตรวจ → เมย์อนุมัติ → กลับนอตโอน\nปุ่มใช้ได้เฉพาะ'+(saved.stage==='not'?'นอต':'เมย์')+' • การอนุมัติยังไม่ใช่การโอนเงิน')];let pending=0;
 for(const sig of saved.signatures){const x=all.find(r=>r.id===sig.id);if(!x){elements.push(ePara('รายการต้นทางไม่พบ'));continue;}
  elements.push(ePara(eDescription(x)+'\n[เปิดใบขอจ่าย PDF]('+eDocumentUrl(x,saved.nonce,'request')+')'));const stage=await externalStage(x),same=x.audit?.epoch===sig.epoch&&await externalFingerprint(x)===sig.fingerprint;
  if(!same||['changed','blocked','documents'].includes(stage))elements.push(ePara('⚠️ ข้อมูลเปลี่ยนหรือไม่ครบ ให้บัญชีตรวจใหม่'));
  else if(stage!==saved.stage)elements.push(ePara('✅ '+(statusFor(stage,x.audit)||'สถานะเปลี่ยนแล้ว')));
  else {pending++;if(saved.errors?.[x.id])elements.push(ePara('⚠️ '+eMd(saved.errors[x.id])));elements.push({tag:'action',actions:[eButton(saved.stage==='not'?'ตรวจผ่าน → ส่งเมย์':'อนุมัติ → ส่งนอตรอโอน',{externalFinance:true,nonce:saved.nonce,action:'accept',id:x.id}),eButton('ส่งกลับบัญชี',{externalFinance:true,nonce:saved.nonce,action:'return',id:x.id})]});}
 }
 elements.splice(1,0,ePara('เหลือให้ตรวจ '+pending+' / '+saved.signatures.length+' รายการ'));
 if(pending>1)elements.push({tag:'action',actions:[{...eButton((saved.stage==='not'?'ตรวจผ่าน':'อนุมัติ')+'ที่เหลือ '+pending+' รายการ',{externalFinance:true,nonce:saved.nonce,action:'accept-all'}),type:'primary',confirm:{title:ePlain('ยืนยัน '+pending+' รายการ'),text:ePlain('ตรวจเอกสาร บริษัท ยอด และบัญชีผู้รับครบแล้ว')}}]});
 return {card:eCard(saved.delegate?'นอต • อนุมัติแทนเมย์เฉพาะใบนี้':saved.stage==='not'?'คู่ค้า / DEALPAY • รอนอตตรวจ':'คู่ค้า / DEALPAY • รอเมย์อนุมัติ',elements,saved.stage==='not'?'blue':'purple'),pending};
}
const eTransferUrl=(saved,env)=>(env.WORKER_URL||'https://accsp2026.organization-23c.workers.dev')+'/?act=external-transfers&k='+encodeURIComponent(saved.nonce);
const transferSummary=x=>x.kind==='internal'?x.summary:expenseSummary([x.detail],x.note);
const transferLabel=kind=>kind==='internal'?'เบิกภายใน':EXTERNAL_TABLES[kind].label;
const transferTotals=rows=>[...new Set(rows.map(x=>x.currency))].map(currency=>eMoney(rows.filter(x=>x.currency===currency).reduce((s,x)=>s+Math.round(x.amount*100),0)/100)+' '+currency).join(' + ')||'0.00 THB';
export function externalTransferCard(saved,rows,env){
 const groups=new Map();
 for(const x of rows){if(!groups.has(x.company.id))groups.set(x.company.id,[]);groups.get(x.company.id).push(x);}
 const elements=[ePara('**รอโอน '+rows.length+' รายการ • รวม '+transferTotals(rows)+'**\n'+(saved.unified?'เบิกภายใน '+rows.filter(x=>x.kind==='internal').length+' รายการ • ':'')+'คู่ค้า '+rows.filter(x=>x.kind==='partner').length+' รายการ • DEALPAY '+rows.filter(x=>x.kind==='dealpay').length+' รายการ'),ePara(rows.length?'เมย์อนุมัติแล้ว • ตรวจบริษัทผู้จ่ายก่อนโอน\nแนบสลิปสำเร็จแล้ว ระบบติ๊กรายการสำเร็จอัตโนมัติ':'ไม่มีรายการที่อนุมัติแล้วรอโอนในขณะนี้')];
 for(const group of groups.values())elements.push(ePara('**'+eMd(group[0].company.name)+'**\n'+group.length+' รายการ • '+transferTotals(group)));
 let shown=0;
 for(const group of groups.values())for(const x of group){
  const item=ePara('**'+(shown+1)+'. '+eMd(x.name)+' • '+eMoney(x.amount)+' '+x.currency+'**\n'+x.company.id+' • '+eMd(transferLabel(x.kind))+' • '+eMd(textOf(x.r.fields[ED.number])||x.doc)+'\n'+eMd(x.bank)+' • '+eMd(x.paymentInstructions||x.account)+'\nรายการ: '+eMd(transferSummary(x))+'\n[PDF รวมไฟล์แนบ]('+(x.pdf||eDocumentUrl(x,saved.nonce,'approved',env))+') | [เปิดรายการ / หลักฐาน]('+eUrl(x)+')'+(x.r.fields['หลักฐานการโอน']?.length?'\n⚠️ มีหลักฐานโอนแล้ว ตรวจสอบก่อนโอนซ้ำ':''));
  // Keep one card even for a large queue; the portal always contains every current row.
  if(shown>=30||new TextEncoder().encode(JSON.stringify([...elements,item])).length>23000)continue;
  elements.push(item);shown++;
 }
 if(shown<rows.length)elements.push(ePara('แสดง '+shown+' จาก '+rows.length+' รายการ • เปิดรายการรอโอนทั้งหมดด้านล่าง'));
 elements.push({tag:'action',actions:[{...eButton('เปิดรายการรอโอนทั้งหมด / แนบสลิป',null,eTransferUrl(saved,env)),type:'primary'}]});
 return eCard(saved.unified?'รายการรอโอนทั้งหมด • นอต':'คู่ค้า / DEALPAY • รอนอตโอน',elements,rows.length?'green':'grey');
}
async function eTransferSummary(owner,all,recipient,unified=false){
 const store=owner.ctx.storage,rows=[];
 for(const x of all)if(await externalStage(x)==='transfer')rows.push(x);
 const externalCount=rows.length;
 if(unified)for(const x of await internalTransferRows(owner))rows.push({...x,company:x.source.j.company,r:x.source.r,table:'tblgakFKBOvz9aCW'});
 rows.sort((a,b)=>a.company.id.localeCompare(b.company.id)||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
 const pointer=await store.get('external:transfer-summary'),keys=[...new Set([pointer,...await store.get('external:active:transfer')||[]].filter(Boolean))],existing=[];
 for(const key of keys){const saved=await store.get(key);if(saved)existing.push({key,saved});}
 const valid=existing.filter(({saved})=>!saved.retired&&saved.stage==='transfer'&&saved.recipient===recipient&&Date.now()-saved.created<7*86400000);
 let current=valid.find(x=>x.key===pointer)||valid.sort((a,b)=>b.saved.created-a.saved.created)[0],sends=0;
 if(!current&&rows.length){const nonce=crypto.randomUUID();current={key:'external:card:transfer:summary:'+nonce,saved:{version:1,stage:'transfer',recipient,nonce,created:Date.now()}};}
 if(current){
  const {key,saved}=current;saved.summary=true;saved.unified=unified;saved.signatures=await Promise.all(rows.map(async x=>({id:x.id,fingerprint:x.kind==='internal'?await fingerprint(x.r,x.source.j):await externalFingerprint(x),epoch:x.kind==='internal'?x.source.j.approvedPdf:x.audit?.epoch})));
  // Persist the same nonce before delivery, so a retry cannot create another summary.
  await store.put(key,saved);await store.put('external:nonce:'+saved.nonce,key);await store.put('external:transfer-summary',key);
  for(const row of rows)if(row.kind==='internal')row.pdf=eDocumentUrl({...row,id:'internal:'+row.id},saved.nonce,'approved',owner.env);
  const card=externalTransferCard(saved,rows,owner.env);
  // New approvals must produce a new message notification, not only edit an old card.
  // Keep an outbox key across retries, including response loss after Lark accepts POST.
  const identities=await Promise.all(saved.signatures.map(s=>digest([s.id,s.fingerprint,s.epoch])));
  const known=new Set(saved.notifiedIdentities||[]),added=identities.filter(id=>!known.has(id));
  if(rows.length&&(!saved.message||added.length)){
   if(!saved.notification){saved.notification={key:key+':delivery:'+crypto.randomUUID(),identities};await store.put(key,saved);}
   const oldMessage=saved.message;
   const message=await eSend(owner.env,recipient,card,saved.notification.key);
   saved.message=message;saved.sentAt=Date.now();saved.renderHash=await digest(card);
   saved.notifiedIdentities=saved.notification.identities||[];delete saved.notification;await store.put(key,saved);sends++;
   // A lost POST response may be deduplicated to the earlier payload. Refresh it
   // before marking any arrivals since that attempt as successfully delivered.
   saved.renderHash='';await ePatch(owner,key,saved,card);
   saved.notifiedIdentities=identities;await store.put(key,saved);
   if(oldMessage&&oldMessage!==message){try{await api(owner.env,'im/v1/messages/'+encodeURIComponent(oldMessage),'PATCH',{content:JSON.stringify(eCard('รายการรอโอนมีการอัปเดตแล้ว',[ePara('ใช้การ์ดล่าสุด หรือ[เปิดรายการรอโอนทั้งหมด]('+eTransferUrl(saved,owner.env)+')')],'grey'))});}catch(e){console.log('TRANSFER_OLD_CARD_PATCH_RETRY',e.message);}}
  }else{
   saved.notifiedIdentities=identities;await store.put(key,saved);
   await ePatch(owner,key,saved,card);
  }
 }
 for(const {key,saved} of existing){
  if(key===current?.key)continue;
  if(saved.message)await ePatch(owner,key,saved,eCard('รวมรายการรอโอนแล้ว',[ePara('รายการจากการ์ดนี้รวมอยู่ในการ์ดรอนอตโอนล่าสุดแล้ว'+(current&&saved.recipient===recipient?'\n[เปิดรายการรอโอนทั้งหมด]('+eTransferUrl(current.saved,owner.env)+')':''))],'grey'));
  saved.retired=true;await store.put(key,saved);
 }
 await store.put('external:active:transfer',current?[current.key]:[]);
 if(unified){
  for(const key of await store.get('active:transfer')||[]){const saved=await store.get(key);if(!saved)continue;
   if(saved.message)await ePatch(owner,key,saved,eCard('รวมรายการรอโอนแล้ว',[ePara('เบิกภายใน คู่ค้า และ DEALPAY อยู่ในการ์ดเดียวแล้ว'+(current&&saved.recipient===recipient?'\n[เปิดรายการรอโอนทั้งหมด]('+eTransferUrl(current.saved,owner.env)+')':''))],'grey'));
   saved.retired=true;saved.mergedInto=current?.key;await store.put(key,saved);
  }
  await store.put('active:transfer',[]);
  console.log('UNIFIED_TRANSFERS',JSON.stringify({count:rows.length,internal:rows.length-externalCount,external:externalCount,totals:transferTotals(rows),cards:current?1:0}));
 }
 return {count:externalCount,sends,cards:current?1:0};
}
async function eReceipt(owner,saved,all){
 const deliveryRole=saved.delegate?'delegate':saved.stage;
 if(!['not','may'].includes(saved.stage)||!saved.message||!saved.sentAt)return;
 for(const sig of saved.signatures){const x=all.find(r=>r.id===sig.id);if(!x||x.audit?.epoch!==sig.epoch||await externalFingerprint(x)!==sig.fingerprint)continue;
  if(x.audit.delivery?.[deliveryRole]?.message===saved.message)continue;
  x.audit.delivery={...x.audit.delivery,[deliveryRole]:{message:saved.message,at:saved.sentAt}};
  const at=new Date(saved.sentAt).toLocaleString('en-GB',{timeZone:'Asia/Bangkok',hour12:false});
  await eWrite(owner.env,x,{[EF.audit]:JSON.stringify(x.audit),...(saved.stage==='not'?{[EF.delivery]:'ส่งแล้ว • '+at}:{})});
 }
}
export async function externalTick(owner,{unified=false}={}){
 if(owner.env.FINANCE_ENABLED!=='true')return {disabled:true};
 const all=await externalSnapshot(owner.env),recipients=await people(owner.env);
 let enabledAt=await owner.ctx.storage.get('external:documents-enabled-at');if(!enabledAt){enabledAt=Date.now();await owner.ctx.storage.put('external:documents-enabled-at',enabledAt);}
 let documentBudget=4;
 const services={fingerprint:externalFingerprint,fresh:x=>eFresh(owner.env,x),write:(x,f)=>eWrite(owner.env,x,f),url:eUrl};
 for(let i=0;i<all.length;i++){
  let x=all[i];if(x.audit)x=all[i]=await externalUpgradeAudit(owner,x);const eligible=!!(x.r.fields[EF.status]||x.r.fields[EF.request]||x.r.fields[ED.number]||x.createdAt>=enabledAt);
  if(eligible&&(!eClosed(x.r)||x.audit?.paid)){
   const problem=externalProblem(x);let status='';
   if(problem)status='รอข้อมูล: '+problem;
   else {try{
    const hash=await externalFingerprint(x);
    if(!await documentCurrent(x,'request',hash)&&documentBudget>0){documentBudget--;x=all[i]=await ensureExternalDocument(owner,x,'request',services);}
    if(x.audit?.fingerprint===hash&&x.audit?.not?.actor&&x.audit?.may?.actor){
     const stage=x.audit.paid?'paid':'approved';if(!await documentCurrent(x,stage,hash)&&documentBudget>0){documentBudget--;x=all[i]=await ensureExternalDocument(owner,x,stage,services);}
    }
   }catch(e){status='สร้าง PDF ไม่สำเร็จ: '+String(e.message).slice(0,180);console.log('EXTERNAL_DOCUMENT_ERROR',x.id,String(e.message));}}
   if(status&&textOf(x.r.fields[ED.status])!==status)await eWrite(owner.env,x,{[ED.status]:status});
  }
  if(x.r.fields[EF.request]===true)x=all[i]=await externalAccounting(owner,x);
  if(!x.audit)continue;const stage=await externalStage(x);
  const status=stage==='changed'?'ข้อมูลรายการเปลี่ยน • ให้บัญชีตรวจใหม่':stage==='blocked'?'ข้อมูลไม่ครบ • '+externalProblem(x):statusFor(stage,x.audit);
  if(status&&textOf(x.r.fields[EF.status])!==status)await eWrite(owner.env,x,{[EF.status]:status,...(['changed','blocked'].includes(stage)?{[EF.not]:false,[EF.may]:false}:{})});
 }
 const transfer=await eTransferSummary(owner,all,recipients.not,unified);
 let sends=transfer.sends;const counts={not:0,may:0,transfer:transfer.count};
 for(const route of ['delegate','not','may']){
  const delegate=route==='delegate',stage=delegate?'may':route;
  const recipient=route==='may'?recipients.may:recipients.not,active=[],covered=new Set();
  for(const key of await owner.ctx.storage.get('external:active:'+route)||[]){
   const saved=await owner.ctx.storage.get(key);if(!saved?.message)continue;
   let pending;
   const render=await eRender(saved,all);await ePatch(owner,key,saved,render.card);pending=render.pending;await eReceipt(owner,saved,all);
   if(pending&&saved.recipient===recipient&&Date.now()-saved.created<7*86400000){active.push(key);for(const s of saved.signatures){const x=all.find(r=>r.id===s.id);if(x&&x.audit?.epoch===s.epoch&&await externalFingerprint(x)===s.fingerprint&&await externalStage(x)===stage)covered.add(x.id);}}
   else {saved.retired=true;await owner.ctx.storage.put(key,saved);}
  }
  const remaining=[];for(const x of all)if((!delegate||permitsDelegate(x))&&await externalStage(x)===stage){if(!delegate)counts[stage]++;if(!covered.has(x.id))remaining.push(x);}
  remaining.sort((a,b)=>a.kind.localeCompare(b.kind)||a.company.id.localeCompare(b.company.id)||a.id.localeCompare(b.id));
  for(let i=0;i<remaining.length&&sends<4;i+=5){
   const rows=remaining.slice(i,i+5),signatures=await Promise.all(rows.map(async x=>({id:x.id,fingerprint:await externalFingerprint(x),epoch:x.audit.epoch})));
   const key='external:card:'+route+':'+await digest([signatures,recipient,Math.floor(Date.now()/(7*86400000))]);let saved=await owner.ctx.storage.get(key);
   if(!saved){saved={version:1,stage,delegate,recipient,signatures,nonce:crypto.randomUUID(),created:Date.now()};await owner.ctx.storage.put(key,saved);await owner.ctx.storage.put('external:nonce:'+saved.nonce,key);}
   if(!saved.message){const c=(await eRender(saved,rows)).card;saved.message=await eSend(owner.env,recipient,c,key);saved.sentAt=Date.now();saved.renderHash=await digest(c);await owner.ctx.storage.put(key,saved);sends++;}
   await eReceipt(owner,saved,all);active.push(key);
  }
  await owner.ctx.storage.put('external:active:'+route,active);
 }
 const transferCards=transfer.cards;await owner.ctx.storage.put('external:lastPoll',{at:Date.now(),counts,sends,transferCards});console.log('EXTERNAL_FINANCE_POLL',JSON.stringify({counts,sends,transferCards}));return {ok:true,counts,sends,transferCards};
}
export async function externalCallback(owner,b){
 if(owner.env.FINANCE_ENABLED!=='true'||!verifiedCallback(owner.env,b))throw Error('Unauthorized callback');
 const v=b.event?.action?.value||{},actor=b.event?.operator?.open_id,key=await owner.ctx.storage.get('external:nonce:'+v.nonce),saved=key&&await owner.ctx.storage.get(key);
 if(!saved||saved.retired||saved.recipient!==actor||!['not','may'].includes(saved.stage)||!['accept','accept-all','return'].includes(v.action)||Date.now()-saved.created>7*86400000)return {ignored:true};
 const recipients=await people(owner.env);if(actor!==recipients[saved.delegate?'not':saved.stage])return {ignored:true};
 const all=await externalSnapshot(owner.env),results=[];saved.errors=saved.errors||{};
 for(const sig of saved.signatures.filter(s=>v.action==='accept-all'||v.id===s.id)){
  try{
   const original=all.find(x=>x.id===sig.id);if(!original)throw Error('ไม่พบรายการ');const x=await eFresh(owner.env,original);const stage=await externalStage(x);
   if(x.audit?.epoch!==sig.epoch||await externalFingerprint(x)!==sig.fingerprint)throw Error('ข้อมูลเปลี่ยน ให้บัญชีตรวจใหม่');
   if(saved.delegate&&(!permitsDelegate(x)||saved.stage!=='may'||v.action==='accept-all'))throw Error('สิทธิ์อนุมัติแทนไม่ตรงรายการ');
   if(stage!==saved.stage){results.push({id:x.id,already:true});continue;}
   const a={...x.audit};if(v.action==='return'){a.stage='returned';a.returned={actor,at:Date.now(),from:saved.stage};delete a.not;delete a.may;}
   else if(saved.stage==='not'){a.not={actor,at:Date.now()};a.stage='may';}
   else {if(a.not?.actor!==recipients.not)throw Error('ไม่พบผลตรวจของนอต');a.may={actor,at:Date.now()};
    if(saved.delegate){a.may.delegated=true;await owner.ctx.storage.put('external:delegate-decision:'+a.epoch,{actor,at:a.may.at,fingerprint:sig.fingerprint,id:x.id});}
    a.stage='transfer';}
   await eStateWrite(owner.env,x,a);Object.assign(original,x);delete saved.errors[x.id];results.push({id:x.id,ok:true});
  }catch(e){saved.errors[sig.id]=String(e.message||e);results.push({id:sig.id,ok:false,error:saved.errors[sig.id]});}
 }
 await owner.ctx.storage.put(key,saved);try{await ePatch(owner,key,saved,(await eRender(saved,all)).card);}catch(e){console.log('EXTERNAL_DECISION_CARD_PATCH_RETRY',e.message);}
 // Retry is an explicit new click on remaining items. Successful rows have advanced and cannot be approved twice.
 console.log('EXTERNAL_FINANCE_DECISION',JSON.stringify(results));return {ok:results.every(r=>r.ok||r.already),results};
}
export async function externalPortalAuth(owner,token){
 const key=await owner.ctx.storage.get('external:nonce:'+token),saved=key&&await owner.ctx.storage.get(key);
 if(!saved||saved.retired||saved.stage!=='transfer'||Date.now()-saved.created>7*86400000||saved.recipient!==(await people(owner.env)).not)throw Error('ลิงก์หมดอายุ เปิดการ์ดรอโอนล่าสุด');return saved;
}
const ePortalRow=(x,saved,env)=>({id:x.id,doc:EXTERNAL_TABLES[x.kind].label+' • '+(textOf(x.r.fields[ED.number])||x.doc),company:x.company.name,company_id:x.company.id,name:x.name,bank:x.bank,account:x.account,paymentInstructions:x.paymentInstructions,amount:x.amount,currency:x.currency,bills:1,summary:expenseSummary([x.detail],x.note),pdf:eDocumentUrl(x,saved.nonce,'approved',env),hasSlip:!!x.r.fields['หลักฐานการโอน']?.length});
export function externalSlipFits(o,x){return slipFits(o,{...x,company_id:x.company.id});}
export async function externalPortalAction(owner,b,session){
 const saved=session||await externalPortalAuth(owner,b.token),{ctx,env}=owner;
 if(saved.stage!=='transfer')throw Error('รายการทดสอบไม่รับสลิปจริง');
 if(b.op==='rows'){const rows=[];for(const x of await externalSnapshot(env))if(await externalStage(x)==='transfer')rows.push(ePortalRow(x,saved,env));return {ok:true,test:false,rows};}
 if(b.op==='prepare'){
  if(!['image/jpeg','image/png','image/webp'].includes(b.mime)||typeof b.image!=='string'||b.image.length>9*1024*1024)throw Error('รูปไม่ถูกต้องหรือใหญ่เกิน 6 MB');
  const hash=await digest(b.image);if(await ctx.storage.get('paidHash:'+hash))throw Error('สลิปนี้เคยใช้แล้ว');
  const o=await matchOCR(env,b.image,b.mime),ref=String(o.ref||'').replace(/\s/g,'');if(!ref||/^(null|none)$/i.test(ref))throw Error('อ่านเลขอ้างอิงไม่ได้');
  const refKey='paidRef:'+await digest(ref);if(await ctx.storage.get(refKey))throw Error('เลขอ้างอิงนี้เคยใช้แล้ว');
  const bytes=Uint8Array.from(atob(b.image),c=>c.charCodeAt(0)),file=await uploadBytesToBitable(env,bytes.buffer,b.filename||'transfer.jpg');
  const draft={id:crypto.randomUUID(),hash,refKey,ref,ocr:o,file,owner:saved.recipient,at:Date.now()};await ctx.storage.put('external:draft:'+draft.id,draft);return {ok:true,draft};
 }
 if(b.op==='commit'){
  if(!Array.isArray(b.pairs)||b.pairs.length<1||b.pairs.length>50)throw Error('เลือก 1–50 รายการ');const results=[],used=new Set();
  for(const p of b.pairs){try{
   const d=await ctx.storage.get('external:draft:'+p.draft);if(!d||d.owner!==saved.recipient||Date.now()-d.at>2*3600000)throw Error('สลิปหมดอายุ');
   const done=await ctx.storage.get('paidHash:'+d.hash);if(done){if(done.id===p.id){results.push({id:p.id,ok:true,already:true});continue;}throw Error('สลิปนี้ใช้กับรายการอื่นแล้ว');}
   if(used.has(p.id))throw Error('เลือกรายการซ้ำ');used.add(p.id);const prior=await ctx.storage.get(d.refKey);if(prior&&prior.id!==p.id)throw Error('เลขอ้างอิงใช้แล้ว');
   const [kind,rid]=String(p.id).split(':');if(!EXTERNAL_TABLES[kind]||!/^rec[a-zA-Z0-9]+$/.test(rid))throw Error('รายการไม่ถูกต้อง');
   let x=await eFresh(env,{kind,table:EXTERNAL_TABLES[kind].table,r:{record_id:rid}});if(await externalStage(x)!=='transfer'||x.company.id!==p.company||!externalSlipFits(d.ocr,x))throw Error('บริษัท ยอด บัญชี หรือผลอนุมัติไม่ตรง');
   const old=x.r.fields['หลักฐานการโอน']||[];if(old.length&&!old.some(f=>f.file_token===d.file))throw Error('มีหลักฐานอื่นอยู่แล้ว ตรวจใน Lark ก่อน');
   const reservation={id:p.id,at:Date.now(),file:d.file};await ctx.storage.put(d.refKey,reservation);
   await eWrite(env,x,{'หลักฐานการโอน':[{file_token:d.file}],'เวลาที่แมต':Date.now()});
   x=await eFresh(env,x);if(await externalStage(x)!=='transfer'||x.company.id!==p.company||!externalSlipFits(d.ocr,x))throw Error('ข้อมูลเปลี่ยนหลังแนบสลิป ยังไม่ปิดรายการ');
   const a={...x.audit,paid:{at:Date.now(),ref:d.ref,file:d.file,actor:saved.recipient}};
   await eWrite(env,x,{'รายการสำเร็จ':true,[EF.status]:eStatus.closed,[EF.audit]:JSON.stringify(a)});await ctx.storage.put('paidHash:'+d.hash,reservation);results.push({id:p.id,ok:true});
  }catch(e){results.push({id:p.id,ok:false,error:e.message});}}
  return {ok:true,results};
 }
 throw Error('คำสั่งไม่ถูกต้อง');
}
export function externalTransferPage(token){return transferPage(token).replaceAll('/?act=transfer-api','/?act=external-transfer-api');}

// Both existing transfer links lead to the same queue. TEST sessions remain isolated.
export async function unifiedPortalAuth(owner,token){
 const store=owner.ctx.storage;
 if(await store.get('external:nonce:'+token))return externalPortalAuth(owner,token);
 const saved=await portalAuth(owner,token);
 if(saved.retired&&saved.mergedInto){const current=await store.get(saved.mergedInto);if(!current||current.recipient!==saved.recipient)throw Error('ลิงก์หมดอายุ');return externalPortalAuth(owner,current.nonce);}
 if(saved.retired)throw Error('ลิงก์หมดอายุ เปิดการ์ดล่าสุด');
 return saved;
}
export async function unifiedPortalAction(owner,b){
 const saved=await unifiedPortalAuth(owner,b.token);
 if(saved.stage==='test')return portalAction(owner,b,saved);
 if(['resume','reread','reference','discard'].includes(b.op))return portalAction(owner,b,saved);
 if(b.op==='rows'){
  const [internal,external]=await Promise.all([internalTransferRows(owner),externalPortalAction(owner,{...b,op:'rows'},saved)]);
  const rows=[...internal.map(({source,...x})=>({...x,doc:'เบิกภายใน • '+x.doc,originalPdf:x.pdf,pdf:eDocumentUrl({id:'internal:'+x.id},saved.nonce,'approved',owner.env)})),...external.rows.map(x=>({...x,kind:x.id.split(':')[0]}))];
  rows.sort((a,b)=>a.company_id.localeCompare(b.company_id)||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
  return {ok:true,test:false,rows};
 }
 if(b.op==='prepare'){
  const result=await portalAction(owner,b,saved);
  await owner.ctx.storage.put('external:draft:'+result.draft.id,result.draft);
  return result;
 }
 if(b.op==='commit'){
  if(!Array.isArray(b.pairs)||b.pairs.length<1||b.pairs.length>50)throw Error('เลือก 1–50 รายการ');
  if(new Set(b.pairs.map(p=>p.id)).size!==b.pairs.length)throw Error('เลือกรายการซ้ำ');
  const results=[];
  for(const p of b.pairs){
   // Support slips prepared on either page before the two queues were combined.
   const draft=await owner.ctx.storage.get('draft:'+p.draft)||await owner.ctx.storage.get('external:draft:'+p.draft);
   if(draft&&draft.owner===saved.recipient&&Date.now()-draft.at<2*3600000){await owner.ctx.storage.put('draft:'+p.draft,draft);await owner.ctx.storage.put('external:draft:'+p.draft,draft);}
   const action=/^(partner|dealpay):/.test(String(p.id))?externalPortalAction:portalAction;
   const result=await action(owner,{...b,pairs:[p]},saved);results.push(...result.results);
  }
  return {ok:true,results};
 }
 throw Error('คำสั่งไม่ถูกต้อง');
}
export async function unifiedDocumentAccess(owner,b){
 if(String(b.id).startsWith('internal:')){
  const saved=await unifiedPortalAuth(owner,b.k);if(saved.stage!=='transfer'||b.stage!=='approved')throw Error('ไม่มีสิทธิ์');
  return internalTransferDocument(owner,String(b.id).slice('internal:'.length));
 }
 if(await owner.ctx.storage.get('external:nonce:'+b.k))return externalDocumentAccess(owner,b);
 const saved=await unifiedPortalAuth(owner,b.k);if(saved.stage!=='transfer')throw Error('ไม่มีสิทธิ์');
 return externalDocumentAccess(owner,b,saved);
}

export async function externalDocumentAccess(owner,b,session){
 const key=await owner.ctx.storage.get('external:nonce:'+b.k),saved=session||(key&&await owner.ctx.storage.get(key));
 if(!saved||saved.retired||Date.now()-saved.created>7*86400000||!['not','may','transfer'].includes(saved.stage))throw Error('ลิงก์หมดอายุ');
 const recipients=await people(owner.env);if(saved.recipient!==recipients[saved.stage==='may'&&!saved.delegate?'may':'not'])throw Error('ไม่มีสิทธิ์');
 const [kind,rid]=String(b.id||'').split(':');if(!EXTERNAL_TABLES[kind]||!/^rec[a-zA-Z0-9]+$/.test(rid))throw Error('รายการไม่ถูกต้อง');
 const x=await eFresh(owner.env,{kind,table:EXTERNAL_TABLES[kind].table,r:{record_id:rid}}),hash=await externalFingerprint(x);
 return readExternalDocument(owner,saved,x,b.stage,hash);
}
