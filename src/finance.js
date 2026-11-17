// Unified accounting cards. No bank transfer or PEAK payment is performed here.
import {CFG} from './config.js';
import {larkToken} from './lark.js';
const SUMMARY='tblgakFKBOvz9aCW', LEDGER='tbljMfJTB5VIis8Y';
const BASE='https://ljpth1hipfdu.jp.larksuite.com/base/'+CFG.BASE_TOKEN;
const SUMMARY_URL=BASE+'?table='+SUMMARY+'&view=vewzhj4jy0';
const NAMES={not:'นายธีร์ชนาภัทร รุ่งโรจน์สุทธิธนา',may:'นางสาวภัทร์ปรียา อภิรติวงศ์โชติ'};
export const textOf=v=>Array.isArray(v)?v.map(textOf).join(''):v&&typeof v==='object'?String(v.text??v.name??v.value??''):String(v??'');
const linkOf=v=>v&&typeof v==='object'?v.link||'':String(v||'');
const md=v=>textOf(v).replace(/[\\*_\[\]<>]/g,' ').replace(/\r?\n/g,' ');
const money=v=>Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const testOf=(f,j)=>/\bTEST\b|ทดสอบ|ไม่โอนเงินจริง/i.test([f['เลขใบขอเบิก'],f['สรุปค่าใช้จ่าย'],f['หมายเหตุ'],JSON.stringify(j.items||[])].join(' '));
const digest=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),n=>n.toString(16).padStart(2,'0')).join('');
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
 if(f['นอตตรวจผ่าน']!==true)return 'not';
 return textOf(f['ผู้ตรวจสอบก่อนอนุมัติ'])&&f['เวลานอตตรวจผ่าน']?'may':'blocked';
}
export async function fingerprint(r,j){
 const f=r.fields;return digest([r.record_id,j.key,j.docId,j.pdfUrl,j.company,j.employee,j.currency,j.items,j.refs,
 ...['ยอดรวม','จำนวนรายการ','บริษัท','รหัสบริษัท','ชื่อพนักงาน','ชื่อบัญชี','เลขบัญชี','ธนาคาร','Doc ID','เลขใบขอเบิก','รายการต้นทาง JSON','สรุปค่าใช้จ่าย','ข้อมูลบริษัท ณ วันออกเอกสาร'].map(k=>f[k]??null)]);
}
async function api(env,path,method='GET',body){
 const response=await fetch(CFG.LARK_HOST+'/open-apis/'+path,{method,headers:{Authorization:'Bearer '+await larkToken(env),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const result=await response.json();if(!response.ok||result.code!==0)throw Error('Lark '+response.status+'/'+result.code+' '+(result.msg||''));return result.data;
}
const recordsPath=table=>'bitable/v1/apps/'+CFG.BASE_TOKEN+'/tables/'+table+'/records';
async function list(env,table){let rows=[],page='';do{const d=await api(env,recordsPath(table)+'?page_size=500'+(page?'&page_token='+encodeURIComponent(page):''));rows.push(...(d.items||[]));page=d.has_more?d.page_token:'';}while(page);return rows;}
async function snapshot(env){
 const [rows,ledgers]=await Promise.all([list(env,SUMMARY),list(env,LEDGER)]);const jobs={};
 for(const r of ledgers){try{const j=JSON.parse(textOf(r.fields['ข้อมูลงาน JSON']));if(j.key)jobs[j.key]=j;}catch{}}
 return rows.map(r=>({r,j:jobs[textOf(r.fields['รหัสงานระบบ'])]}));
}
async function people(env){
 const rows=await list(env,CFG.T_EMPLOYEE),out={};
 for(const role of ['not','may']){const matches=rows.filter(r=>textOf(r.fields['Name (TH)'])===NAMES[role]);if(matches.length!==1)throw Error('ทะเบียน '+role+' ไม่ตรงหนึ่งคน');out[role]=textOf(matches[0].fields['Lark open_id']);if(!/^ou_[a-z0-9]+$/.test(out[role]))throw Error('ไม่พบ Lark open_id ของ '+role);}
 if(out.not===out.may)throw Error('ผู้ตรวจและผู้อนุมัติต้องเป็นคนละคน');return out;
}
const plain=content=>({tag:'plain_text',content});
const paragraph=content=>({tag:'div',text:{tag:'lark_md',content}});
const button=(label,value,url)=>({tag:'button',text:plain(label),...(url?{url}:{value}),type:'default'});
const card=(title,elements,template='blue')=>({config:{wide_screen_mode:true},header:{template,title:plain(title)},elements});
function rowText(x){const f=x.r.fields;return '**'+md(f['เลขใบขอเบิก'])+' • '+md(x.j.company.name)+'**\n'+md(f['ชื่อพนักงาน'])+' • '+x.j.items.length+' บิล • **'+money(f['ยอดรวม'])+' '+md(x.j.currency)+'**\n[ดู PDF]('+linkOf(f['ใบขอเบิก PDF'])+') | [เปิดรายการ]('+SUMMARY_URL+'&record='+x.r.record_id+')';}
function reviewCard(stage,rows,nonce){
 const elements=[paragraph('ตรวจเอกสารก่อนกด • ปุ่มใช้ได้เฉพาะ'+(stage==='not'?'นอต':'เมย์')+'\n'+rows.length+' ใบสรุป แยกบริษัท • ไม่ใช่การยืนยันโอนเงิน')];
 for(const x of rows){elements.push(paragraph(rowText(x)),{tag:'action',actions:[button(stage==='not'?'ตรวจผ่าน':'Approve',{finance:true,nonce,action:'accept',id:x.r.record_id}),button('ส่งกลับแก้ไข',{finance:true,nonce,action:'return',id:x.r.record_id})]});}
 elements.push({tag:'action',actions:[{...button(stage==='not'?'ตรวจผ่านทั้งหมดในชุดนี้':'Approve ทั้งหมดในชุดนี้',{finance:true,nonce,action:'accept-all'}),type:'primary',confirm:{title:plain('ยืนยัน '+rows.length+' ใบสรุป'),text:plain('ตรวจเอกสารและยอดครบทุกบริษัทแล้วใช่ไหม')}}]});
 return card(stage==='not'?'รอนอตตรวจ • ผู้ช่วยบัญชี':'รอเมย์อนุมัติ • ผู้ช่วยบัญชี',elements,stage==='not'?'blue':'purple');
}
function transferCard(rows,test){
 const elements=[paragraph(test?'**ทดสอบกระบวนการ • ห้ามโอนเงินจริง • ไม่ลง PEAK**':'**นอตตรวจและเมย์อนุมัติ พร้อม PDF แล้ว → รอนอตโอน**')];
 for(const company of ['PSH','PWA','ODP'])for(const currency of [...new Set(rows.filter(x=>x.j.company.id===company).map(x=>x.j.currency))]){
  const group=rows.filter(x=>x.j.company.id===company&&x.j.currency===currency);elements.push({tag:'hr'},paragraph('**'+md(group[0].j.company.name)+'**\n'+group.length+' รายการโอน ('+group.reduce((s,x)=>s+x.j.items.length,0)+' บิล) • รวม **'+money(group.reduce((s,x)=>s+Number(x.r.fields['ยอดรวม']),0))+' '+md(currency)+'**'));
  for(const x of group){const f=x.r.fields;elements.push(paragraph('**'+md(f['ชื่อบัญชี'])+'**\n'+md(f['ธนาคาร'])+' • '+md(f['เลขบัญชี'])+'\nยอด **'+money(f['ยอดรวม'])+' '+md(currency)+'**\n'+md(f['เลขใบขอเบิก'])+(f['หลักฐานการโอน']?.length?'\n⚠️ มีสลิปแล้ว ตรวจหลักฐานก่อน ห้ามโอนซ้ำ':'')+'\n[PDF อนุมัติแล้ว]('+x.j.approvedPdf+') | [เปิดรายการ]('+SUMMARY_URL+'&record='+x.r.record_id+')'));}
 }
 elements.push(paragraph(test?'เมย์อนุมัติแล้ว ระบบส่งกลับมาหานอตสำเร็จ — รายการนี้ไม่นับในยอดรอโอนจริง':'หลังโอน ส่งสลิปหลายใบผ่านคำสั่ง “แมตยอด” ในแชทผู้ช่วยบัญชี เลือกบริษัทและตรวจคู่รายการก่อนยืนยัน'));
 if(!test)elements.push({tag:'action',actions:[button('เปิดรายการรอโอน',null,BASE+'?table='+SUMMARY+'&view=vewmaVZMKW')]});
 return card(test?'TEST • เมย์อนุมัติแล้ว → นอต':'รายการรอโอน • NOT',elements,test?'orange':'green');
}
async function send(env,to,c,uuid){const d=await api(env,'im/v1/messages?receive_id_type=open_id','POST',{receive_id:to,msg_type:'interactive',content:JSON.stringify(c),uuid:uuid.slice(0,50)});if(!d.message_id)throw Error('No message_id');return d.message_id;}
async function patch(env,id,c){return api(env,'im/v1/messages/'+encodeURIComponent(id),'PATCH',{content:JSON.stringify(c)});}
// Single coordinator DO serializes polling and callbacks; receipt sessions use other names.
export async function financeTick(owner){
 const {env,ctx}=owner;if(env.FINANCE_ENABLED!=='true')return {disabled:true};
 if(!env.LARK_VERIFICATION_TOKEN)throw Error('Missing callback verification setting');
 const [all,recipients]=await Promise.all([snapshot(env),people(env)]);const groups={not:[],may:[],transfer:[],test:[]};
 for(const x of all){const stage=financeStage(x.r,x.j);if(groups[stage])groups[stage].push(x);}
 if(env.FINANCE_TEST_ONLY==='true'){groups.not=[];groups.may=[];groups.transfer=[];}
 let sends=0;
 for(const stage of Object.keys(groups)){
  const rows=groups[stage].sort((a,b)=>a.r.record_id.localeCompare(b.r.record_id));const size=stage==='not'||stage==='may'?5:15;
  const active=[];
  for(let i=0;i<rows.length;i+=size){const chunk=rows.slice(i,i+size);const signatures=await Promise.all(chunk.map(async x=>[x.r.record_id,await fingerprint(x.r,x.j),linkOf(x.r.fields['PDF อนุมัติแล้ว']),x.r.fields['หลักฐานการโอน']||[]]));
   const key='card:'+stage+':'+await digest(signatures);active.push(key);let saved=await ctx.storage.get(key);
   if(saved?.sent)continue;if(sends>=4)continue;
   if(!saved){saved={stage,nonce:crypto.randomUUID(),signatures,created:Date.now(),recipient:stage==='may'?recipients.may:recipients.not};await ctx.storage.put(key,saved);await ctx.storage.put('nonce:'+saved.nonce,key);}
   const c=stage==='not'||stage==='may'?reviewCard(stage,chunk,saved.nonce):transferCard(chunk,stage==='test');
   saved.message=await send(env,saved.recipient,c,await digest(key));saved.sent=true;await ctx.storage.put(key,saved);console.log('FINANCE_CARD_SENT',stage,chunk.length,saved.message);sends++;
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
export async function financeCallback(owner,b){
 const {env,ctx}=owner;if(env.FINANCE_ENABLED!=='true'||!verifiedCallback(env,b))throw Error('Unauthorized callback');
 const v=b.event?.action?.value||{},actor=b.event?.operator?.open_id;
 const key=await ctx.storage.get('nonce:'+v.nonce),saved=key&&await ctx.storage.get(key);
 if(!saved||saved.retired||saved.recipient!==actor||!['not','may'].includes(saved.stage)||Date.now()-saved.created>7*86400000)return {ignored:true};
 if(!['accept','accept-all','return'].includes(v.action))return {ignored:true};
 const targets=saved.signatures.filter(x=>v.action==='accept-all'||x[0]===v.id);if(!targets.length)return {ignored:true};
 const recipients=await people(env);if(actor!==recipients[saved.stage])return {ignored:true};
 const all=await snapshot(env),results=[];
 for(const [id,expected] of targets){
  const doneKey='decision:'+saved.nonce+':'+id;if(await ctx.storage.get(doneKey)){results.push(id+' ทำรายการแล้ว');continue;}
  try{
   const x=all.find(x=>x.r.record_id===id);if(!x||financeStage(x.r,x.j)!==saved.stage||await fingerprint(x.r,x.j)!==expected)throw Error('ข้อมูลหรือสถานะเปลี่ยน กรุณาใช้การ์ดล่าสุด');
   // Read record immediately before mutation, and compare with issued card again.
   x.r=(await api(env,recordsPath(SUMMARY)+'/'+id)).record;
   if(financeStage(x.r,x.j)!==saved.stage||await fingerprint(x.r,x.j)!==expected)throw Error('ข้อมูลเปลี่ยนระหว่างตรวจ');
   const f=x.r.fields;const checked=textOf(f['ข้อมูลที่นอตตรวจผ่าน']);
   if(saved.stage==='may'&&checked&&checked!==expected)throw Error('ข้อมูลต่างจากที่นอตตรวจ ต้องตรวจใหม่');
   const fields=v.action==='return'?{'ส่งกลับแก้ไขก่อนอนุมัติ':true,'นอตตรวจผ่าน':false,'ข้อมูลที่นอตตรวจผ่าน':''}:
    saved.stage==='not'?{'นอตตรวจผ่าน':true,'ผู้ตรวจสอบก่อนอนุมัติ':'นอต (NOT)','เวลานอตตรวจผ่าน':Date.now(),'ข้อมูลที่นอตตรวจผ่าน':expected}:{Approve:true};
   await api(env,recordsPath(SUMMARY)+'/'+id,'PUT',{fields});
   await ctx.storage.put(doneKey,{at:Date.now(),actor,action:v.action,fingerprint:expected});results.push(textOf(f['เลขใบขอเบิก'])+' '+(v.action==='return'?'ส่งกลับแล้ว':saved.stage==='not'?'ตรวจผ่านแล้ว':'อนุมัติแล้ว รอสร้าง PDF'));
  }catch(e){results.push(id+' — '+e.message);}
 }
 // Preserve buttons for unselected documents; poll replaces cards after state changes.
 await send(env,actor,card('ผลการดำเนินการ',[paragraph(results.map(md).join('\n'))]),await digest([saved.nonce,v.action,targets.map(x=>x[0])]));
 return {ok:true};
}
