// Unified accounting cards. No bank transfer or PEAK payment is performed here.
import {CFG} from './config.js';
import {larkToken} from './lark.js';
export const SUMMARY='tblgakFKBOvz9aCW', LEDGER='tbljMfJTB5VIis8Y';
const BASE='https://ljpth1hipfdu.jp.larksuite.com/base/'+CFG.BASE_TOKEN;
const SUMMARY_URL=BASE+'?table='+SUMMARY+'&view=vewzhj4jy0';
const NAMES={not:'นายธีร์ชนาภัทร รุ่งโรจน์สุทธิธนา',may:'นางสาวภัทร์ปรียา อภิรติวงศ์โชติ'};
export const textOf=v=>Array.isArray(v)?v.map(textOf).join(''):v&&typeof v==='object'?String(v.text??v.name??v.value??''):String(v??'');
const linkOf=v=>v&&typeof v==='object'?v.link||'':String(v||'');
const md=v=>textOf(v).replace(/[\\*_\[\]<>]/g,' ').replace(/\r?\n/g,' ');
const money=v=>Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const testOf=(f,j)=>/\bTEST\b|ทดสอบ|ไม่โอนเงินจริง/i.test([f['เลขใบขอเบิก'],f['สรุปค่าใช้จ่าย'],f['หมายเหตุ'],JSON.stringify(j.items||[])].join(' '));
export const digest=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),n=>n.toString(16).padStart(2,'0')).join('');
export function financeProblem(f,j,id){
 if(!j||j.summaryId!==id||j.key!==textOf(f['รหัสงานระบบ']))return 'ไม่พบงานต้นทางที่ตรงกัน';
 if(!['PSH','PWA','ODP'].includes(j.company?.id))return 'บริษัทไม่รองรับ';
 if(!Array.isArray(j.items)||!j.items.length||!j.employee||!j.currency)return 'ข้อมูลงานไม่ครบ';
 const total=j.items.reduce((s,x)=>s+Math.round(Number(x.amount)*100),0);
 if(!Number.isFinite(total)||total<=0||Math.round(Number(f['ยอดรวม'])*100)!==total||Number(f['จำนวนรายการ'])!==j.items.length)return 'ยอดหรือจำนวนรายการเปลี่ยน';
 const pairs=[['บริษัท',j.company.name],['รหัสบริษัท',j.company.id],['ชื่อพนักงาน',j.employee.name],['ชื่อบัญชี',j.employee.accountName],['เลขบัญชี',j.employee.accountNo],['ธนาคาร',j.employee.bankName],['Doc ID',j.docId],['เลขใบขอเบิก',j.docNo]];
 if(pairs.some(([k,v])=>!v||textOf(f[k])!==String(v)))return 'ข้อมูลบริษัท ผู้เบิก บัญชี หรือเอกสารเปลี่ยน';
 if(!/^\d{6,20}$/.test(textOf(f['เลขบัญชี']).replace(/[\s-]/g,'')))return 'เลขบัญชีไม่ครบ';
 if(linkOf(f['ใบขอเบิก PDF'])!==j.pdfUrl)return 'PDF ต้นทางเปลี่ยน';
 return '';
}
export function financeStage(r,j){
 const f=r.fields||{},status=textOf(f['สถานะ']);
 if(!textOf(f['รหัสงานระบบ']))return 'legacy';
 if(f['รายการสำเร็จ']===true||f['จ่ายแล้ว (PEAK)']===true||status==='โอนแล้ว')return 'closed';
 if(financeProblem(f,j,r.record_id))return 'blocked';
 if(f['ส่งกลับแก้ไขก่อนอนุมัติ']===true||f.Reject===true)return 'returned';
 if(status==='อนุมัติแล้ว'&&f.Approve===true&&j.state==='APPROVED'&&linkOf(f['PDF อนุมัติแล้ว'])===j.approvedPdf&&j.approvedPdf){
  if(f['นอตตรวจผ่าน']!==true||!textOf(f['ผู้ตรวจสอบก่อนอนุมัติ'])||!f['เวลานอตตรวจผ่าน'])return 'blocked';
  return testOf(f,j)?'test':'transfer';
 }
 if(status!=='สร้างแล้ว'||f.Approve===true||j.state==='APPROVED')return 'waiting';
 if(!['COMPLETE','CREATED','READY','DONE','COMPLETED'].includes(j.state))return 'waiting';
 if(f['บัญชีตรวจผ่าน']!==true||!textOf(f['ผู้ตรวจบัญชี'])||!f['เวลาบัญชีตรวจผ่าน']||!textOf(f['ข้อมูลที่บัญชีตรวจผ่าน']))return 'accounting';
 if(f['นอตตรวจผ่าน']!==true)return 'not';
 return textOf(f['ผู้ตรวจสอบก่อนอนุมัติ'])&&f['เวลานอตตรวจผ่าน']?'may':'blocked';
}
export async function fingerprint(r,j){
 const f=r.fields;return digest([r.record_id,j.key,j.docId,j.pdfUrl,j.company,j.employee,j.currency,j.items,j.refs,
 ...['ยอดรวม','จำนวนรายการ','บริษัท','รหัสบริษัท','ชื่อพนักงาน','ชื่อบัญชี','เลขบัญชี','ธนาคาร','Doc ID','เลขใบขอเบิก','รายการต้นทาง JSON','สรุปค่าใช้จ่าย','ข้อมูลบริษัท ณ วันออกเอกสาร'].map(k=>f[k]??null)]);
}
// Every transition rechecks the exact financial data reviewed at the previous step.
export async function checkedStage(r,j){
 const stage=financeStage(r,j);
 if(!['not','may'].includes(stage))return stage;
 const hash=await fingerprint(r,j);
 if(textOf(r.fields['ข้อมูลที่บัญชีตรวจผ่าน'])!==hash)return 'accounting';
 if(stage==='may'&&textOf(r.fields['ข้อมูลที่นอตตรวจผ่าน'])!==hash)return 'not';
 return stage;
}
export async function api(env,path,method='GET',body){
 for(let attempt=0;;attempt++){
  const response=await fetch(CFG.LARK_HOST+'/open-apis/'+path,{method,headers:{Authorization:'Bearer '+await larkToken(env),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();
  if(response.ok&&result.code===0)return result.data;
  const e=Error('Lark '+response.status+'/'+result.code+' '+(result.msg||''));e.code=result.code;e.status=response.status;
  // Reads and exact card replacements can retry here. Decisions retry through the durable queue and revalidate.
  if(['GET','PATCH'].includes(method)&&rateLimited(e)&&attempt<2){await new Promise(resolve=>setTimeout(resolve,(attempt+1)*2000));continue;}
  throw e;
 }
}

export const recordsPath=table=>'bitable/v1/apps/'+CFG.BASE_TOKEN+'/tables/'+table+'/records';
async function list(env,table){let rows=[],page='';do{const d=await api(env,recordsPath(table)+'?page_size=500'+(page?'&page_token='+encodeURIComponent(page):''));rows.push(...(d.items||[]));page=d.has_more?d.page_token:'';}while(page);return rows;}
export async function snapshot(env){
 const [rows,ledgers]=await Promise.all([list(env,SUMMARY),list(env,LEDGER)]);const jobs={};
 for(const r of ledgers){try{const j=JSON.parse(textOf(r.fields['ข้อมูลงาน JSON']));if(j.key)jobs[j.key]=j;}catch{}}
 return rows.map(r=>({r,j:jobs[textOf(r.fields['รหัสงานระบบ'])]}));
}
export async function people(env){
 const rows=await list(env,CFG.T_EMPLOYEE),out={};
 for(const role of ['not','may']){const matches=rows.filter(r=>textOf(r.fields['Name (TH)'])===NAMES[role]);if(matches.length!==1)throw Error('ทะเบียน '+role+' ไม่ตรงหนึ่งคน');out[role]=textOf(matches[0].fields['Lark open_id']);if(!/^ou_[a-z0-9]+$/.test(out[role]))throw Error('ไม่พบ Lark open_id ของ '+role);}
 if(out.not===out.may)throw Error('ผู้ตรวจและผู้อนุมัติต้องเป็นคนละคน');
 return out;
}
const plain=content=>({tag:'plain_text',content});
const paragraph=content=>({tag:'div',text:{tag:'lark_md',content}});
const button=(label,value,url)=>({tag:'button',text:plain(label),...(url?{url}:{value}),type:'default'});
const card=(title,elements,template='blue')=>({config:{wide_screen_mode:true,update_multi:true,enable_forward:false},header:{template,title:plain(title)},elements});
function rowText(x){const f=x.r.fields;return '**'+md(f['เลขใบขอเบิก'])+' • '+md(x.j.company.name)+'**\n'+md(f['ชื่อพนักงาน'])+' • '+x.j.items.length+' บิล • **'+money(f['ยอดรวม'])+' '+md(x.j.currency)+'**\n[ดู PDF]('+linkOf(f['ใบขอเบิก PDF'])+') | [เปิดรายการ]('+SUMMARY_URL+'&record='+x.r.record_id+')';}
function reviewCard(stage,rows,nonce){
 const pending=rows.filter(x=>!x.reviewStatus);
 const elements=[paragraph('ตรวจเอกสารก่อนกด • ปุ่มใช้ได้เฉพาะ'+(stage==='accounting'?'ฝ่ายบัญชี':stage==='not'?'นอต':'เมย์')+'\n'+rows.length+' ใบสรุป แยกบริษัท • ไม่ใช่การยืนยันโอนเงิน')];
 elements.push(paragraph('เหลือให้กด '+pending.length+' / '+rows.length+' ใบ'));
 for(const x of rows){elements.push(paragraph(x.j?rowText(x):md(x.r.record_id)));if(x.reviewStatus){elements.push(paragraph(x.reviewStatus));continue;}if(x.reviewError)elements.push(paragraph(x.reviewError));elements.push({tag:'action',actions:[button(stage==='accounting'?'บัญชีตรวจผ่าน → ส่งให้นอต':stage==='not'?'ตรวจผ่าน → ส่งให้เมย์':'Approve',{finance:true,nonce,action:'accept',id:x.r.record_id}),button('ส่งกลับแก้ไข',{finance:true,nonce,action:'return',id:x.r.record_id})]});}
 if(pending.length)elements.push({tag:'action',actions:[{...button(stage==='not'?'ตรวจผ่านที่เหลือ '+pending.length+' ใบ':'Approve ที่เหลือ '+pending.length+' ใบ',{finance:true,nonce,action:'accept-all'}),type:'primary',confirm:{title:plain('ยืนยัน '+pending.length+' ใบสรุป'),text:plain('ตรวจเอกสารและยอดครบทุกบริษัทแล้วใช่ไหม')}}]});
 return card(stage==='accounting'?'รอบัญชีตรวจเอกสาร • ผู้ช่วยบัญชี':stage==='not'?'รอนอตตรวจ • ผู้ช่วยบัญชี':'รอเมย์อนุมัติ • ผู้ช่วยบัญชี',elements,stage==='not'?'blue':'purple');
}
function transferCard(rows,test,portal){
 const elements=[paragraph(test?'**ทดสอบกระบวนการ • ห้ามโอนเงินจริง • ไม่ลง PEAK**':'**นอตตรวจและเมย์อนุมัติ พร้อม PDF แล้ว → รอนอตโอน**')];
 for(const company of ['PSH','PWA','ODP'])for(const currency of [...new Set(rows.filter(x=>x.j.company.id===company).map(x=>x.j.currency))]){
  const group=rows.filter(x=>x.j.company.id===company&&x.j.currency===currency);elements.push({tag:'hr'},paragraph('**'+md(group[0].j.company.name)+'**\n'+group.length+' รายการโอน ('+group.reduce((s,x)=>s+x.j.items.length,0)+' บิล) • รวม **'+money(group.reduce((s,x)=>s+Number(x.r.fields['ยอดรวม']),0))+' '+md(currency)+'**'));
  for(const x of group){const f=x.r.fields;elements.push(paragraph('**'+md(f['ชื่อบัญชี'])+'**\n'+md(f['ธนาคาร'])+' • '+md(f['เลขบัญชี'])+'\nยอด **'+money(f['ยอดรวม'])+' '+md(currency)+'**\n'+md(f['เลขใบขอเบิก'])+(f['หลักฐานการโอน']?.length?'\n⚠️ มีสลิปแล้ว ตรวจหลักฐานก่อน ห้ามโอนซ้ำ':'')+'\n[PDF อนุมัติแล้ว]('+x.j.approvedPdf+') | [เปิดรายการ]('+SUMMARY_URL+'&record='+x.r.record_id+')'));}
 }
 elements.push(paragraph(test?'เมย์อนุมัติแล้ว ระบบส่งกลับมาหานอตสำเร็จ — รายการนี้ไม่นับในยอดรอโอนจริง':'หลังโอน ส่งสลิปหลายใบผ่านคำสั่ง “แมตยอด” ในแชทผู้ช่วยบัญชี เลือกบริษัทและตรวจคู่รายการก่อนยืนยัน'));
 elements.push({tag:'action',actions:[{...button(test?'เปิดหน้าโอนตัวอย่าง':'เปิดรายการโอน / แนบสลิปหลายใบ',null,portal),type:'primary'}]});
 return card(test?'TEST • เมย์อนุมัติแล้ว → นอต':'รายการรอโอน • NOT',elements,test?'orange':'green');
}
async function send(env,to,c,uuid){const d=await api(env,'im/v1/messages?receive_id_type=open_id','POST',{receive_id:to,msg_type:'interactive',content:JSON.stringify(c),uuid:uuid.slice(0,50)});if(!d.message_id)throw Error('No message_id');return d.message_id;}
async function patch(env,id,c){return api(env,'im/v1/messages/'+encodeURIComponent(id),'PATCH',{content:JSON.stringify(c)});}
// Keep a review card's membership stable while its remaining documents are reviewed.
export async function reviewRows(saved,all,storage){
 const out=[];
 for(const [id,expected,,,accountingAt,notAt,resendAt] of saved.signatures){
  const source=all.find(x=>x.r.record_id===id),x=source?{...source}:{r:{record_id:id,fields:{}},j:null};
  const f=x.r.fields,done=await storage.get('decision:'+saved.nonce+':'+id);
  const same=x.j&&await fingerprint(x.r,x.j)===expected;
  const stage=x.j?await checkedStage(x.r,x.j):'missing';
  const epoch=(saved.stage!=='not'||(resendAt||0)===(f['เวลาขอส่งให้นอตซ้ำ']||0))&&(accountingAt===undefined||accountingAt===(f['เวลาบัญชีตรวจผ่าน']||0))&&(notAt===undefined||saved.stage==='not'||notAt===(f['เวลานอตตรวจผ่าน']||0));
  if(saved.retired||Date.now()-saved.created>7*86400000)x.reviewStatus='⚠️ การ์ดนี้สิ้นสุดแล้ว ใช้การ์ดล่าสุด';
  else if(!same)x.reviewStatus='⚠️ ข้อมูลเปลี่ยน ต้องตรวจเอกสารฉบับล่าสุด';
  else if(stage==='returned')x.reviewStatus='↩️ ส่งกลับแก้ไขแล้ว';
  else if(f.Approve===true)x.reviewStatus='✅ เมย์อนุมัติแล้ว • '+(f['PDF อนุมัติแล้ว']?'ดูสถานะโอนในรายการ':md(f['สถานะระบบแยกบริษัท']||'รอสร้าง PDF อนุมัติ'));
  else if(saved.stage==='not'&&f['นอตตรวจผ่าน']===true)x.reviewStatus='✅ นอตตรวจผ่านแล้ว → รอเมย์อนุมัติ';
  else if(done)x.reviewStatus=done.action==='return'?'↩️ ส่งกลับแก้ไขแล้ว':'✅ ทำรายการแล้ว • ตรวจสถานะล่าสุดในตาราง';
  else if(stage!==saved.stage||!epoch)x.reviewStatus='⚠️ สถานะเปลี่ยน ใช้การ์ดล่าสุด';
  if(!x.reviewStatus&&saved.errors?.[id])x.reviewError=saved.errors[id];
  if(!x.reviewStatus&&saved.processing?.includes(id))x.reviewStatus='⏳ กำลังตรวจและบันทึกผล';
  out.push(x);
 }
 return out;
}
export async function refreshReview(owner,key,saved,all){
 const rows=await reviewRows(saved,all,owner.ctx.storage),c=reviewCard(saved.stage,rows,saved.nonce),hash=await digest(c);
 if(saved.message&&!saved.shared){
  const oldMessage=saved.message;
  saved.message=await send(owner.env,saved.recipient,c,await digest([key,'shared-card-v1']));
  saved.shared=true;saved.sentAt=Date.now();saved.renderHash='';
  await owner.ctx.storage.put(key,saved);
  console.log('FINANCE_CARD_MIGRATED',saved.stage,oldMessage,saved.message);
 }
 if(saved.message&&saved.renderHash!==hash){await patch(owner.env,saved.message,c);saved.renderHash=hash;await owner.ctx.storage.put(key,saved);console.log('FINANCE_CARD_UPDATED',saved.message,rows.filter(x=>!x.reviewStatus).length);}
 return rows.filter(x=>!x.reviewStatus);
}
export const TABLE_REQUEST='ส่งให้นอต (คำสั่งจากตาราง)';
export const DELIVERY_STATUS='สถานะส่งให้นอต', DELIVERY_AT='วันที่–เวลาส่งให้นอต', DELIVERY_ID='รหัสข้อความส่งให้นอต';
// This receipt is written only after Lark has returned a message_id.
export async function recordNotDelivery(owner,key,saved,all){
 if(saved.stage!=='not'||!saved.sent||!saved.message)return;
 const {env,ctx}=owner;
 const targets=[];
 for(const [id,expected,,,accountingAt,,resendAt] of saved.signatures){
  const x=all.find(x=>x.r.record_id===id);if(!x?.j)continue;
  if(await fingerprint(x.r,x.j)!==expected||accountingAt!==undefined&&accountingAt!==(x.r.fields['เวลาบัญชีตรวจผ่าน']||0))continue;
  if((resendAt||0)!==(x.r.fields['เวลาขอส่งให้นอตซ้ำ']||0))continue;
  targets.push(x);
 }
 if(!targets.length)return;
 if(!saved.sentAt){
  const d=await api(env,'im/v1/messages/'+encodeURIComponent(saved.message));
  const m=d.items?.find(x=>x.message_id===saved.message),at=Number(m?.create_time);
  if(!Number.isFinite(at)||at<=0)throw Error('ไม่พบเวลาส่งจาก Lark');
  saved.sentAt=at;await ctx.storage.put(key,saved);
 }
 const updates=targets.filter(x=>Number(x.r.fields[DELIVERY_AT]||0)<saved.sentAt||textOf(x.r.fields[DELIVERY_ID])===saved.message&&textOf(x.r.fields[DELIVERY_STATUS])!=='ส่งแล้ว').map(x=>({record_id:x.r.record_id,fields:{[DELIVERY_STATUS]:'ส่งแล้ว',[DELIVERY_AT]:saved.sentAt,[DELIVERY_ID]:saved.message}}));
 if(updates.length){const d=await api(env,recordsPath(SUMMARY)+'/batch_update','POST',{records:updates});if(!d.records||d.records.length!==updates.length)throw Error('บันทึกหลักฐานส่งไม่ครบ');for(const u of updates)Object.assign(targets.find(x=>x.r.record_id===u.record_id).r.fields,u.fields);}
}
export function tableReviewProblem(r,j){
 const f=r.fields||{};
 if(f.Approve===true||j?.state==='APPROVED'||f['รายการสำเร็จ']===true||f['จ่ายแล้ว (PEAK)']===true)return 'อนุมัติหรือจ่ายแล้ว ไม่ส่งซ้ำ';
 if(textOf(f['สถานะ'])!=='สร้างแล้ว'||!['COMPLETE','CREATED','READY','DONE','COMPLETED'].includes(j?.state))return 'ยังไม่พร้อมตรวจ กรุณาสร้างเอกสารให้ครบ';
 return financeProblem(f,j,r.record_id);
}
export async function tableReview(env,x){
 // The button uses Bitable edit permissions, not a public approval URL.
 x.r=(await api(env,recordsPath(SUMMARY)+'/'+x.r.record_id)).record;
 if(x.r.fields[TABLE_REQUEST]!==true)return;
 const problem=tableReviewProblem(x.r,x.j);
 const fields={[TABLE_REQUEST]:false};
 if(problem){fields['ผลตรวจบัญชี (ระบบ)']=problem;if(!x.r.fields[DELIVERY_ID])fields[DELIVERY_STATUS]='ยังไม่ส่ง • '+problem;}
 else {
  const hash=await fingerprint(x.r,x.j);
  if(x.r.fields['บัญชีตรวจผ่าน']===true&&textOf(x.r.fields['ข้อมูลที่บัญชีตรวจผ่าน'])===hash&&!x.r.fields['ส่งกลับแก้ไขก่อนอนุมัติ']){if(x.r.fields['นอตตรวจผ่าน']===true){fields['ผลตรวจบัญชี (ระบบ)']='นอตตรวจผ่านแล้ว • ไม่ย้อนขั้นอนุมัติ';}else {fields['เวลาขอส่งให้นอตซ้ำ']=Math.max(Date.now(),Number(x.r.fields['เวลาขอส่งให้นอตซ้ำ']||0)+1);fields['ผลตรวจบัญชี (ระบบ)']='รับคำสั่งส่งอีกครั้ง • รอส่งให้นอต';fields[DELIVERY_STATUS]='รอส่งอีกครั้ง';}}
  else Object.assign(fields,{'บัญชีตรวจผ่าน':true,'ผู้ตรวจบัญชี':'ตรวจผ่านจากปุ่มในตารางสรุปรอบเบิก','เวลาบัญชีตรวจผ่าน':Date.now(),'ข้อมูลที่บัญชีตรวจผ่าน':hash,'นอตตรวจผ่าน':false,'ข้อมูลที่นอตตรวจผ่าน':'','ผู้ตรวจสอบก่อนอนุมัติ':'','เวลานอตตรวจผ่าน':null,'ส่งกลับแก้ไขก่อนอนุมัติ':false,Reject:false,'ผลตรวจบัญชี (ระบบ)':'บัญชีตรวจผ่าน • รอส่งให้นอต',[DELIVERY_STATUS]:'รอส่ง',[DELIVERY_AT]:null,[DELIVERY_ID]:''});
 }
 await api(env,recordsPath(SUMMARY)+'/'+x.r.record_id,'PUT',{fields});
 Object.assign(x.r.fields,fields);
}
// Single coordinator DO serializes polling and callbacks; receipt sessions use other names.
export async function financeTick(owner){
 const {env,ctx}=owner;if(env.FINANCE_ENABLED!=='true')return {disabled:true};
 if(!env.LARK_VERIFICATION_TOKEN)throw Error('Missing callback verification setting');
 for(const key of await ctx.storage.get('pending-finance-retries')||[]){const job=await ctx.storage.get(key);if(job&&!job.done&&job.nextAt<=Date.now()){await financeCallback(owner,job.body);break;}}
 const [all,recipients]=await Promise.all([snapshot(env),people(env)]);const groups={accounting:[],not:[],may:[],transfer:[],test:[]};
 // Recover receipts for existing cards without sending them again or inventing dates.
 if(ctx.storage.list&&!await ctx.storage.get('delivery-backfill:v1')){
  let complete=true;
  for(const prefix of ['card:v2:not:','card:v3:not:']){const old=await ctx.storage.list({prefix});for(const [key,saved] of old){try{await recordNotDelivery(owner,key,saved,all);}catch(e){complete=false;console.log('DELIVERY_RECEIPT_RETRY',e.message);}}}
  if(complete)await ctx.storage.put('delivery-backfill:v1',true);
 }
 for(const x of all){if(x.r.fields[TABLE_REQUEST]===true)await tableReview(env,x);const stage=await checkedStage(x.r,x.j);if(stage!=='accounting'&&groups[stage])groups[stage].push(x);}
 if(env.FINANCE_TEST_ONLY==='true'){groups.accounting=[];groups.not=[];groups.may=[];groups.transfer=[];}
 let sends=0;
 for(const stage of Object.keys(groups)){
  if(['not','may'].includes(stage)){
   const active=[],covered=new Set();
   for(const key of await ctx.storage.get('active:'+stage)||[]){
    const saved=await ctx.storage.get(key);if(!saved?.sent)continue;
    try{await recordNotDelivery(owner,key,saved,all);}catch(e){console.log('DELIVERY_RECEIPT_RETRY',e.message);}
    const pending=await refreshReview(owner,key,saved,all);await recordNotDelivery(owner,key,saved,all);
    if(pending.length&&saved.recipient===recipients[stage]){active.push(key);pending.forEach(x=>covered.add(x.r.record_id));}
   }
   const remaining=groups[stage].filter(x=>!covered.has(x.r.record_id)).sort((a,b)=>a.r.record_id.localeCompare(b.r.record_id));
   for(let i=0;i<remaining.length&&sends<4;i+=5){
    const chunk=remaining.slice(i,i+5),signatures=await Promise.all(chunk.map(async x=>[x.r.record_id,await fingerprint(x.r,x.j),linkOf(x.r.fields['PDF อนุมัติแล้ว']),x.r.fields['หลักฐานการโอน']||[],x.r.fields['เวลาบัญชีตรวจผ่าน']||0,x.r.fields['เวลานอตตรวจผ่าน']||0,...(stage==='not'?[x.r.fields['เวลาขอส่งให้นอตซ้ำ']||0]:[])]));
    const key='card:v3:'+stage+':'+await digest([signatures,recipients[stage]]);
    let saved=await ctx.storage.get(key);
    if(!saved){saved={stage,nonce:crypto.randomUUID(),signatures,created:Date.now(),recipient:recipients[stage]};await ctx.storage.put(key,saved);await ctx.storage.put('nonce:'+saved.nonce,key);}
    if(!saved.sent){const c=reviewCard(stage,chunk,saved.nonce);try{saved.message=await send(env,saved.recipient,c,await digest(key));}catch(e){if(stage==='not')await api(env,recordsPath(SUMMARY)+'/batch_update','POST',{records:chunk.map(x=>({record_id:x.r.record_id,fields:{[DELIVERY_STATUS]:'ส่งไม่สำเร็จ • ระบบจะลองใหม่'}}))});throw e;}saved.sent=true;saved.shared=true;saved.sentAt=Date.now();saved.renderHash=await digest(c);await ctx.storage.put(key,saved);sends++;}
    await recordNotDelivery(owner,key,saved,all);
    active.push(key);
   }
   await ctx.storage.put('active:'+stage,active);continue;
  }
  const rows=groups[stage].sort((a,b)=>a.r.record_id.localeCompare(b.r.record_id));const size=['accounting','not','may'].includes(stage)?5:15;
  const active=[];
  for(let i=0;i<rows.length;i+=size){const chunk=rows.slice(i,i+size);const signatures=await Promise.all(chunk.map(async x=>[x.r.record_id,await fingerprint(x.r,x.j),linkOf(x.r.fields['PDF อนุมัติแล้ว']),x.r.fields['หลักฐานการโอน']||[],...(['accounting','not','may'].includes(stage)?[x.r.fields['เวลาบัญชีตรวจผ่าน']||0,x.r.fields['เวลานอตตรวจผ่าน']||0]:[])]));
   const key='card:v2:'+stage+':'+await digest(['accounting','not','may'].includes(stage)?[signatures,recipients[stage]]:signatures);active.push(key);let saved=await ctx.storage.get(key);
   if(saved?.sent)continue;if(sends>=4)continue;
   if(stage==='accounting'&&!recipients.accounting){console.log('FINANCE_ACCOUNTANT_MISSING',chunk.length);continue;}
   if(!saved){saved={stage,nonce:crypto.randomUUID(),signatures,created:Date.now(),recipient:recipients[stage]||recipients.not};await ctx.storage.put(key,saved);await ctx.storage.put('nonce:'+saved.nonce,key);}
   const c=['accounting','not','may'].includes(stage)?reviewCard(stage,chunk,saved.nonce):transferCard(chunk,stage==='test',(env.WORKER_URL||'https://accsp2026.organization-23c.workers.dev')+'/?act=transfers&k='+encodeURIComponent(saved.nonce));
   saved.message=await send(env,saved.recipient,c,await digest(key));saved.sent=true;saved.shared=true;await ctx.storage.put(key,saved);console.log('FINANCE_CARD_SENT',stage,chunk.length,saved.message);sends++;
  }
  const old=await ctx.storage.get('active:'+stage)||[];
  // Retire only after replacements have all been sent.
  const ready=(await Promise.all(active.map(k=>ctx.storage.get(k)))).every(x=>x?.sent);
  if(ready){for(const key of old.filter(k=>!active.includes(k))){const prev=await ctx.storage.get(key);if(prev?.message){await patch(env,prev.message,card('รายการมีการอัปเดตแล้ว',[paragraph('ใช้การ์ดล่าสุดหรือเปิดรายการใน Lark เพื่อดูสถานะปัจจุบัน'),{tag:'action',actions:[button('เปิดสรุปรอบเบิก',null,SUMMARY_URL)]}],'grey'));prev.retired=true;await ctx.storage.put(key,prev);}}
   await ctx.storage.put('active:'+stage,active);}
 }
 await ctx.storage.put('lastPoll',{at:Date.now(),counts:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),sends});
 console.log('FINANCE_POLL',JSON.stringify({counts:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),sends}));
 return {ok:true,sends};
}
export function verifiedCallback(env,b){return !!env.LARK_VERIFICATION_TOKEN&&b?.header?.token===env.LARK_VERIFICATION_TOKEN&&b.header.app_id===CFG.LARK_APP_ID&&b.header.event_type==='card.action.trigger';}
async function runFinanceCallback(owner,b){
 const {env,ctx}=owner;if(env.FINANCE_ENABLED!=='true'||!verifiedCallback(env,b))throw Error('Unauthorized callback');
 const v=b.event?.action?.value||{},actor=b.event?.operator?.open_id;
 const key=await ctx.storage.get('nonce:'+v.nonce),saved=key&&await ctx.storage.get(key);
 if(!saved||saved.retired||saved.recipient!==actor||!['not','may'].includes(saved.stage)||Date.now()-saved.created>7*86400000)return {ignored:true};
 if(!['accept','accept-all','return'].includes(v.action))return {ignored:true};
 const targets=saved.signatures.filter(x=>v.action==='accept-all'||x[0]===v.id);if(!targets.length)return {ignored:true};
 const recipients=await people(env);if(actor!==recipients[saved.stage])return {ignored:true};
 const all=await snapshot(env),results=[];let retry=false;saved.errors=saved.errors||{};saved.processing=targets.filter(([id])=>!saved.errors[id]?.includes('ข้อมูล')).map(x=>x[0]);await ctx.storage.put(key,saved);
 try{await refreshReview(owner,key,saved,all);}catch(e){console.log('FINANCE_CARD_PATCH_RETRY',saved.message,e.message);}
 for(const [id,expected] of targets){
  const doneKey='decision:'+saved.nonce+':'+id;if(await ctx.storage.get(doneKey)){results.push(id+' ทำรายการแล้ว');saved.processing=saved.processing.filter(x=>x!==id);delete saved.errors[id];continue;}
  try{
   const x=all.find(x=>x.r.record_id===id);if(!x||await checkedStage(x.r,x.j)!==saved.stage||await fingerprint(x.r,x.j)!==expected)throw Error('ข้อมูลหรือสถานะเปลี่ยน กรุณาใช้การ์ดล่าสุด');
   // Read record immediately before mutation, and compare with issued card again.
   x.r=(await api(env,recordsPath(SUMMARY)+'/'+id)).record;
   if(await checkedStage(x.r,x.j)!==saved.stage||await fingerprint(x.r,x.j)!==expected)throw Error('ข้อมูลเปลี่ยนระหว่างตรวจ');
   const issued=saved.signatures.find(s=>s[0]===id);
   if(saved.stage==='not'&&(issued[6]||0)!==(x.r.fields['เวลาขอส่งให้นอตซ้ำ']||0))throw Error('มีการส่งการ์ดใหม่แล้ว กรุณาใช้การ์ดล่าสุด');
   const f=x.r.fields;const checked=textOf(f['ข้อมูลที่นอตตรวจผ่าน']);
   if(saved.stage==='may'&&checked&&checked!==expected)throw Error('ข้อมูลต่างจากที่นอตตรวจ ต้องตรวจใหม่');
   const fields=v.action==='return'?{'ส่งกลับแก้ไขก่อนอนุมัติ':true,'นอตตรวจผ่าน':false,'ข้อมูลที่นอตตรวจผ่าน':'','บัญชีตรวจผ่าน':false,'ข้อมูลที่บัญชีตรวจผ่าน':''}:
    saved.stage==='accounting'?{'บัญชีตรวจผ่าน':true,'ผู้ตรวจบัญชี':actor,'เวลาบัญชีตรวจผ่าน':Date.now(),'ข้อมูลที่บัญชีตรวจผ่าน':expected,'นอตตรวจผ่าน':false,'ข้อมูลที่นอตตรวจผ่าน':'','ผู้ตรวจสอบก่อนอนุมัติ':'','เวลานอตตรวจผ่าน':null}:
    saved.stage==='not'?{'นอตตรวจผ่าน':true,'ผู้ตรวจสอบก่อนอนุมัติ':'นอต (NOT)','เวลานอตตรวจผ่าน':Date.now(),'ข้อมูลที่นอตตรวจผ่าน':expected}:{Approve:true};
   await api(env,recordsPath(SUMMARY)+'/'+id,'PUT',{fields});
   Object.assign(x.r.fields,fields);
   delete saved.errors[id];
   await ctx.storage.put(doneKey,{at:Date.now(),actor,action:v.action,fingerprint:expected});results.push(textOf(f['เลขใบขอเบิก'])+' '+(v.action==='return'?'ส่งกลับแล้ว':saved.stage==='accounting'?'บัญชีตรวจผ่านแล้ว รอส่งให้นอต':saved.stage==='not'?'ตรวจผ่านแล้ว':'อนุมัติแล้ว รอสร้าง PDF'));
  }catch(e){const transient=rateLimited(e);retry=retry||transient;const label=textOf(all.find(x=>x.r.record_id===id)?.r.fields['เลขใบขอเบิก'])||id;
   saved.errors[id]=transient?'⏳ ยังไม่สำเร็จ • Lark จำกัดคำขอ ระบบจะลองใหม่':'⚠️ ยังไม่สำเร็จ • '+e.message;results.push(label+' — '+saved.errors[id]);
  }
  saved.processing=saved.processing.filter(x=>x!==id);await ctx.storage.put(key,saved);
  try{await refreshReview(owner,key,saved,all);}catch(e){console.log('FINANCE_CARD_PATCH_RETRY',saved.message,e.message);}
 }
 // Update this exact card after persisting the decision, including partial success.
 try{await refreshReview(owner,key,saved,all);}catch(e){console.log('FINANCE_CARD_PATCH_RETRY',saved.message,e.message);}
 await send(env,actor,card('ผลการดำเนินการ',[paragraph(results.map(md).join('\n'))]),await digest([saved.nonce,v.action,targets.map(x=>x[0]),results]));
 return {ok:!retry,retry};
}


const rateLimited=e=>Number(e?.code)===1254290||Number(e?.code)===230020||e?.status===429;
// Only an authenticated human click creates a retry job; retries never invent approvals.
export async function financeCallback(owner,b){
 const {env,ctx}=owner;if(env.FINANCE_ENABLED!=='true'||!verifiedCallback(env,b))throw Error('Unauthorized callback');
 const v=b.event?.action?.value||{},actor=b.event?.operator?.open_id;
 const cardKey=await ctx.storage.get('nonce:'+v.nonce),saved=cardKey&&await ctx.storage.get(cardKey);
 if(!saved||saved.retired||saved.recipient!==actor||!['not','may'].includes(saved.stage)||!['accept','accept-all','return'].includes(v.action)||Date.now()-saved.created>7*86400000)return {ignored:true};
 const retryKey='finance-retry:'+await digest([v.nonce,v.action,v.id||'',b.header.event_id||'']);
 const prior=await ctx.storage.get(retryKey);if(prior?.done)return {duplicate:true};
 const job={body:b,attempt:(prior?.attempt||0)+1,nextAt:Date.now()+60000};await ctx.storage.put(retryKey,job);await ctx.storage.put('pending-finance-retries',[...new Set([...(await ctx.storage.get('pending-finance-retries')||[]),retryKey])]);
 let result;
 try{result=await runFinanceCallback(owner,b);}catch(e){if(!rateLimited(e)){job.done=true;await ctx.storage.put(retryKey,job);throw e;}result={retry:true};console.log('FINANCE_RETRY_QUEUED',job.attempt,e.message);}
 if(!result.retry||job.attempt>=3){job.done=true;if(result.retry){const latest=await ctx.storage.get(cardKey);latest.processing=[];for(const id of Object.keys(latest.errors||{}))latest.errors[id]='⚠️ ยังไม่สำเร็จหลังลอง 3 ครั้ง • กดตรวจผ่านอีกครั้ง';await ctx.storage.put(cardKey,latest);job.exhausted=true;}}
 await ctx.storage.put(retryKey,job);if(job.done)await ctx.storage.put('pending-finance-retries',(await ctx.storage.get('pending-finance-retries')||[]).filter(k=>k!==retryKey));return result;
}
