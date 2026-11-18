import {snapshot,people,financeStage,fingerprint,textOf,digest,api,SUMMARY,recordsPath} from './finance.js';
import {matchOCR} from './match.js';
import {uploadBytesToBitable,downloadMediaByToken} from './lark.js';
const digits=v=>String(v||'').replace(/\D/g,'');
// Keep visible digits in their original positions: K BIZ also hides the final digit.
export function accountFits(raw,account){
 const mask=String(raw||'').trim().toLowerCase().replace(/[\s-]/g,'').replace(/[*•●]/g,'x');
 const target=String(account||'').replace(/\D/g,'');
 if(!/^[0-9x]+$/.test(mask)||mask.replace(/x/g,'').length<4||!target)return false;
 if(mask.includes('x'))return mask.length===target.length&&[...mask].every((c,i)=>c==='x'||c===target[i]);
 return mask.length<=target.length&&target.endsWith(mask);
}
export function bankCode(value){
 const v=String(value||'').toUpperCase().replace(/[\s.()_-]/g,'');
 if(/กสิกร|KASIKORN|KBANK/.test(v))return 'KBANK';
 if(/ไทยพาณิชย์|SIAMCOMMERCIAL|SCB/.test(v))return 'SCB';
 if(/กรุงไทย|KRUNGTHAI|KTB/.test(v)||v==='BT')return 'KTB';
 if(/กรุงศรี|AYUDHYA|BAY/.test(v))return 'BAY';
 if(/กรุงเทพ|BANGKOKBANK|BBL/.test(v))return 'BBL';
 if(/ทหารไทย|ธนชาต|TMB|TTB/.test(v))return 'TTB';
 if(/ออมสิน|GSB/.test(v))return 'GSB';
 if(/พร้อมเพย์|PROMPTPAY/.test(v))return 'PROMPTPAY';
 return '';
}
export function payerCompany(o){
 const v=String(o.sender_name||'').toUpperCase().replace(/\s/g,'');
 const ids=[];
 if(/OMNIDASHPAYWALLET|ออมนิแดชเพย์วอลเล/.test(v))ids.push('ODP');
 if(/PROSPERWEALTHYASSET|พรอสเพอร์เวลธี่เอสเซท/.test(v))ids.push('PWA');
 if(/PROSERVICEHOMESOLUTION|โปรเซอร์วิสโฮมโซลูชั่น/.test(v))ids.push('PSH');
 return ids.length===1?ids[0]:'';
}
export function slipFits(o,r){
 const payer=payerCompany(o),cid=r.company_id||r.company?.id;
 const fromBank=bankCode(o.recipient_bank),toBank=bankCode(r.bank);
 return o.amount!==null&&o.amount!==''&&Number.isFinite(Number(o.amount))&&Number(o.amount)>0&&Math.round(Number(o.amount)*100)===Math.round(r.amount*100)
  &&String(o.currency||'').toUpperCase()===r.currency&&accountFits(o.recipient_acct_mask||o.recipient_acct,r.account)
  &&(!payer||!cid||payer===cid)&&(!o.recipient_bank||(!!fromBank&&!!toBank&&fromBank===toBank));
}
export function slipChoices(o,rows,company){return rows.filter(r=>!r.hasSlip&&(!company||r.company_id===company)&&slipFits(o,r));}
async function saveDraft(owner,d){for(const key of ['draft:'+d.id,'external:draft:'+d.id,'draftHash:'+d.hash])await owner.ctx.storage.put(key,d);}
export async function resumeDrafts(owner,saved){
 const all=new Map();for(const prefix of ['draft:','external:draft:'])for(const [,d] of await owner.ctx.storage.list({prefix})){
  if(d.owner!==saved.recipient||Date.now()-d.at>2*3600000||await owner.ctx.storage.get('paidHash:'+d.hash))continue;
  if(!all.has(d.refKey))all.set(d.refKey,d);
 }
 return [...all.values()].sort((a,b)=>a.at-b.at).slice(-50);
}
async function retainDraftImage(owner,d,image,mime){
 d.imageKey='transfer-image:'+d.id;d.mime=mime;
 await owner.env.KV.put(d.imageKey,image,{expirationTtl:Math.max(60,Math.ceil((d.at+2*3600000-Date.now())/1000))});
}
export async function upgradeDraft(owner,d,image,mime){
 if(await digest(image)!==d.hash)throw Error('ภาพสลิปไม่ตรงกับไฟล์เดิม');
 if(await owner.ctx.storage.get('paidHash:'+d.hash))throw Error('สลิปนี้แนบสำเร็จแล้ว');
 const o=await matchOCR(owner.env,image,mime),ref=String(o.ref||'').replace(/\s/g,'');
 if(!/^[A-Za-z0-9_-]{6,80}$/.test(ref))throw Error('อ่านเลขอ้างอิงไม่ได้: '+JSON.stringify(o).slice(0,800));
 if(ref!==d.ref){
  const newKey='paidRef:'+await digest(ref);
  if(await owner.ctx.storage.get(d.refKey)||await owner.ctx.storage.get(newKey))throw Error('เลขอ้างอิงสลิปถูกใช้งานแล้ว กรุณาตรวจรายการเดิม');
  d.originalOcrRef=d.ref;d.ref=ref;d.refKey=newKey;
 }
 d.ocr=o;d.ocrVersion=2;await retainDraftImage(owner,d,image,mime);await saveDraft(owner,d);return d;
}
export async function rereadDraft(owner,id,saved){
 const d=await owner.ctx.storage.get('draft:'+id)||await owner.ctx.storage.get('external:draft:'+id);
 if(!d||d.owner!==saved.recipient||Date.now()-d.at>2*3600000)throw Error('สลิปหมดอายุ กรุณาอ่านใหม่');
 if(await owner.ctx.storage.get('paidHash:'+d.hash))throw Error('สลิปนี้แนบสำเร็จแล้ว');
 let image=d.imageKey?await owner.env.KV.get(d.imageKey):'',mime=d.mime||'image/jpeg';
 if(!image){
  let bytes;try{bytes=new Uint8Array(await downloadMediaByToken(owner.env,d.file));}catch{throw Error('ดึงภาพเดิมไม่ได้ กรุณาเลือกสลิปเดิมเพื่ออ่านใหม่ ระบบจะใช้รายการเดิม');}
  let bin='';for(let i=0;i<bytes.length;i+=32768)bin+=String.fromCharCode(...bytes.subarray(i,i+32768));
  image=btoa(bin);mime=bytes[0]===137?'image/png':bytes[0]===82?'image/webp':'image/jpeg';
 }
 if(d.ocrVersion!==2)await upgradeDraft(owner,d,image,mime);
 return {ok:true,draft:d,preview:'data:'+mime+';base64,'+image};
}
export async function portalAuth(owner,k){
 const key=await owner.ctx.storage.get('nonce:'+k), saved=key&&await owner.ctx.storage.get(key);
 if(!saved||!['transfer','test'].includes(saved.stage)||Date.now()-saved.created>7*86400000)throw Error('ลิงก์หมดอายุ เปิดการ์ดล่าสุดในผู้ช่วยบัญชี');
 const p=await people(owner.env);if(saved.recipient!==p.not)throw Error('ไม่มีสิทธิ์');return saved;
}
async function queue(owner,test){return (await snapshot(owner.env)).filter(x=>financeStage(x.r,x.j)===(test?'test':'transfer'));}
function view(x){const f=x.r.fields;return {id:x.r.record_id,doc:textOf(f['เลขใบขอเบิก']),company:x.j.company.name,company_id:x.j.company.id,name:x.j.employee.accountName,bank:x.j.employee.bankName,account:x.j.employee.accountNo,amount:Number(f['ยอดรวม']),currency:x.j.currency,bills:x.j.items.length,pdf:x.j.approvedPdf,hasSlip:!!f['หลักฐานการโอน']?.length};}
export async function internalTransferRows(owner){return (await queue(owner,false)).map(x=>({...view(x),kind:'internal',source:x}));}
export async function portalAction(owner,b,session){
 const {ctx,env}=owner, saved=session||await portalAuth(owner,b.token),test=saved.stage==='test';
 if(b.op==='rows')return {ok:true,test,rows:(await queue(owner,test)).map(view)};
 if(test)throw Error('TEST ดูและคัดลอกตัวอย่างได้ แต่ไม่รับสลิปจริงและไม่เปลี่ยนสถานะจ่าย');
 if(b.op==='resume')return {ok:true,drafts:await resumeDrafts(owner,saved)};
 if(b.op==='reread')return rereadDraft(owner,b.draft,saved);
 if(b.op==='prepare'){
  if(!['image/jpeg','image/png','image/webp'].includes(b.mime)||typeof b.image!=='string'||b.image.length>9*1024*1024)throw Error('รับ JPG/PNG/WebP ไม่เกิน 6 MB ต่อใบ');
  const bin=atob(b.image),bytes=Uint8Array.from(bin,c=>c.charCodeAt(0)),hash=await digest(b.image);
  if(await ctx.storage.get('paidHash:'+hash))throw Error('สลิปนี้เคยแนบแล้ว');
  let draft=await ctx.storage.get('draftHash:'+hash);
  if(draft&&draft.owner===saved.recipient&&Date.now()-draft.at<2*3600000){
   if(draft.ocrVersion!==2)await upgradeDraft(owner,draft,b.image,b.mime);
   return {ok:true,draft};
  }
  const o=await matchOCR(env,b.image,b.mime);
  const ref=String(o.ref||'').replace(/\s/g,'');
  if(!ref||/^(null|none)$/i.test(ref))throw Error('อ่านเลขอ้างอิงสลิปไม่ได้ กรุณาใช้ภาพชัดเจน');
  const refKey='paidRef:'+await digest(ref);
  if(await ctx.storage.get(refKey))throw Error('เลขอ้างอิงนี้เคยใช้แล้ว');
  const file=await uploadBytesToBitable(env,bytes.buffer,b.filename||'transfer.jpg');
  draft={id:crypto.randomUUID(),hash,refKey,ref,ocr:o,ocrVersion:2,file,filename:b.filename||'transfer.jpg',mime:b.mime,owner:saved.recipient,at:Date.now()};
  await retainDraftImage(owner,draft,b.image,b.mime);await saveDraft(owner,draft);
  return {ok:true,draft};
 }
 if(b.op==='commit'){
  if(!Array.isArray(b.pairs)||b.pairs.length<1||b.pairs.length>50)throw Error('เลือก 1–50 รายการ');
  const results=[], used=new Set();
  for(const p of b.pairs){try{
   const d=await ctx.storage.get('draft:'+p.draft);
   if(!d||d.owner!==saved.recipient||Date.now()-d.at>2*3600000)throw Error('สลิปหมดอายุ กรุณาอ่านใหม่');
   const done=await ctx.storage.get('paidHash:'+d.hash);
   if(done){if(done.id===p.id){results.push({id:p.id,ok:true,already:true});continue;}throw Error('สลิปถูกใช้กับรายการอื่นแล้ว');}
   if(used.has(p.id))throw Error('เลือกใบสรุปซ้ำในชุดนี้');used.add(p.id);
   const prior=await ctx.storage.get(d.refKey);if(prior&&prior.id!==p.id)throw Error('เลขอ้างอิงสลิปถูกใช้แล้ว');
   const x=(await queue(owner,false)).find(x=>x.r.record_id===p.id);if(!x)throw Error('รายการไม่อยู่ในคิวรอโอนหรือเป็น TEST');
   if(x.j.company.id!==p.company)throw Error('บริษัทไม่ตรง');
   if(!slipFits(d.ocr,view(x)))throw Error('ยอด สกุลเงิน หรือบัญชีผู้รับไม่ตรง');
   const fp=await fingerprint(x.r,x.j);
   x.r=(await api(env,recordsPath(SUMMARY)+'/'+p.id)).record;
   if(financeStage(x.r,x.j)!=='transfer'||await fingerprint(x.r,x.j)!==fp)throw Error('ข้อมูลเปลี่ยน กรุณาโหลดใหม่');
   const old=x.r.fields['หลักฐานการโอน']||[];
   if(old.length&&!old.some(f=>f.file_token===d.file))throw Error('มีหลักฐานอยู่แล้ว ต้องตรวจใน Lark ก่อนเพื่อไม่แนบทับ');
   const reserve={id:p.id,at:Date.now(),file:d.file};await ctx.storage.put(d.refKey,reserve);
   // Attach before setting paid. Retry can recover after either write without replacing another slip.
   await api(env,recordsPath(SUMMARY)+'/'+p.id,'PUT',{fields:{'หลักฐานการโอน':[{file_token:d.file}],'เวลาที่แมต':Date.now()}});
   await api(env,recordsPath(SUMMARY)+'/'+p.id,'PUT',{fields:{'รายการสำเร็จ':true}});
   await ctx.storage.put('paidHash:'+d.hash,reserve);results.push({id:p.id,ok:true});
  }catch(e){results.push({id:p.id,ok:false,error:e.message});}}
  console.log('TRANSFER_ATTACH_RESULTS',JSON.stringify(results));return {ok:true,results};
 }
 throw Error('คำสั่งไม่ถูกต้อง');
}
export function transferPage(token){return `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>รายการโอน • ผู้ช่วยบัญชี</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f5fa;color:#17213b;font:16px system-ui,sans-serif}main{max-width:1050px;margin:auto;padding:24px 16px 80px}h1{font-size:28px}h2{font-size:20px}.box,article{background:white;border:1px solid #dce2ec;border-radius:16px;padding:18px;margin:12px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}article{margin:0}button,select{padding:12px;border:1px solid #bcc8dd;border-radius:10px;font:inherit;cursor:pointer;background:white;color:#17213b}button.primary{background:#293cbd;color:white;border:0}button:disabled{opacity:.45;cursor:default}.muted{color:#637087;font-size:14px}.amount{font-size:26px;font-weight:700;margin:12px 0}.actions{display:flex;gap:8px;flex-wrap:wrap}.warn{background:#fff1d8;padding:14px;border-radius:10px}a{color:#293cbd}.slip{display:grid;grid-template-columns:70px 1fr;gap:12px;margin:14px 0;padding:12px;border:1px solid #dde3ed;border-radius:12px}.slip img{width:70px;height:90px;object-fit:contain}.slip select{width:100%;margin:6px 0}.ok{color:#087c49}.bad{color:#b22b31}input[type=file]{max-width:100%}#notice{white-space:pre-line}#drop{border:2px dashed #aab8d4;padding:20px;border-radius:12px;margin:12px 0}
</style><main><div class="muted">ผู้ช่วยบัญชี • นอต</div><h1>รายการรอโอนทั้งหมด</h1><div id="summary" class="box"></div><div id="notice" class="warn">กำลังโหลด…</div><div class="actions"><button id="refresh">โหลดรายการล่าสุด</button><button id="uploadJump">ไปแนบสลิป</button></div><div id="queue"></div><section class="box" id="upload"><h2>โอนแล้ว → แนบสลิปหลายใบ</h2><p>เลือกสลิปได้พร้อมกัน 20 ใบหรือสูงสุด 50 ใบ ระบบอ่านและเสนอคู่ให้ตรวจ ก่อนยืนยันแนบทั้งหมดครั้งเดียว เมื่อแนบสำเร็จ ระบบติ๊ก “รายการสำเร็จ” ให้อัตโนมัติ</p><div id="drop"><input id="files" type="file" accept="image/jpeg,image/png,image/webp" multiple><p class="muted">หรือลากรูปสลิปมาวางที่นี่</p></div><div id="paste" role="textbox" aria-label="วางภาพสลิปที่คัดลอก" contenteditable="true" tabindex="0" class="warn">คลิกที่นี่แล้ววางภาพสลิปที่คัดลอก</div><div id="progress"></div><div id="slips"></div><button class="primary" id="commit" disabled>ยืนยันแนบทั้งหมด</button><p id="result"></p></section></main><script>
const TOKEN=${JSON.stringify(token)},$=id=>document.getElementById(id);let rows=[],slips=[],test=false,busy=false;const fmt=n=>Number(n).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const dg=v=>String(v||'').replace(/\\D/g,'');
async function api(op,p={}){const r=await fetch('/?act=transfer-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:TOKEN,op,...p})});const j=await r.json();if(!j.ok)throw Error(j.error||'ไม่สำเร็จ');return j;}
async function copy(v,b){try{await navigator.clipboard.writeText(v);b.textContent='คัดลอกแล้ว ✓';setTimeout(()=>b.textContent=b.dataset.label,1600);}catch{prompt('คัดลอกข้อมูลนี้',v);}}
function totalText(items){return [...new Set(items.map(r=>r.currency))].map(currency=>fmt(items.filter(r=>r.currency===currency).reduce((s,r)=>s+Math.round(r.amount*100),0)/100)+' '+currency).join(' + ')||'0.00 THB';}
function renderQueue(){const root=$('queue');root.innerHTML='';$('summary').innerHTML='<strong>รอโอนทั้งหมด '+rows.length+' รายการ</strong><div class="amount">'+esc(totalText(rows))+'</div><div class="muted">เบิกภายใน '+rows.filter(r=>!r.kind||r.kind==='internal').length+' รายการ • คู่ค้า '+rows.filter(r=>r.kind==='partner').length+' รายการ • DEALPAY '+rows.filter(r=>r.kind==='dealpay').length+' รายการ</div>';for(const cid of [...new Set(rows.map(r=>r.company_id))]){const group=rows.filter(r=>r.company_id===cid),s=document.createElement('section');s.innerHTML='<h2>'+esc(group[0].company)+'</h2><p>'+group.length+' รายการโอน • '+group.reduce((n,r)=>n+r.bills,0)+' บิล • รวม '+esc(totalText(group))+'</p><div class="grid"></div>';for(const r of group){const a=document.createElement('article');a.innerHTML='<strong>'+esc(r.name)+'</strong><div>'+esc(r.bank)+' · '+esc(r.account)+'</div><div class="amount">'+fmt(r.amount)+' '+esc(r.currency)+'</div><div class="muted">'+esc(r.doc)+' • '+r.bills+' บิล</div>'+(r.hasSlip?'<p class="warn">มีสลิปอยู่แล้ว ตรวจรายการก่อนโอนซ้ำ</p>':'')+'<p class="actions"><button data-label="คัดลอกบัญชี">คัดลอกบัญชี</button><button data-label="คัดลอกยอด">คัดลอกยอด</button></p><a target="_blank" rel="noopener noreferrer" href="'+esc(r.pdf)+'">ดู PDF อนุมัติแล้ว</a>';const b=a.querySelectorAll('button');b[0].onclick=()=>copy(dg(r.account),b[0]);b[1].onclick=()=>copy(r.amount.toFixed(2),b[1]);s.querySelector('.grid').append(a);}root.append(s);}if(!rows.length)root.textContent='ไม่มีรายการรอโอน';}
async function load(){try{const j=await api('rows');rows=j.rows;test=j.test;$('notice').textContent=test?'TEST • ห้ามโอนเงินจริง • หน้านี้ดูและคัดลอกเพื่อทดสอบเท่านั้น ไม่บันทึกจ่าย':'เลือกบริษัทให้ตรงกับบัญชีที่ใช้โอน แล้วคัดลอกบัญชีและยอดไปโอนผ่านธนาคาร';$('files').disabled=test||busy;renderQueue();renderSlips();}catch(e){$('notice').textContent=e.message;}}
${accountFits.toString()}
${bankCode.toString()}
${payerCompany.toString()}
${slipFits.toString()}
${slipChoices.toString()}
function renderSlips(){
 const root=$('slips');root.innerHTML='';
 for(const s of slips){
  const el=document.createElement('div');el.className='slip';
  el.innerHTML=(s.url?'<img src="'+esc(s.url)+'">':'<div></div>')+'<div><strong>'+esc(s.name)+'</strong><p>'+esc(s.error||(s.done?'แนบสำเร็จ • รายการสำเร็จแล้ว':s.draft?fmt(s.draft.ocr.amount)+' '+s.draft.ocr.currency+' · '+s.draft.ocr.recipient_name+' · '+(s.draft.ocr.recipient_acct_mask||s.draft.ocr.recipient_acct):'รออ่านสลิป'))+'</p></div>';
  const box=el.lastChild;
  if(s.draft&&!s.done){
   const o=s.draft.ocr,detected=payerCompany(o),all=slipChoices(o,rows,'');
   if(!s.company&&!s.manualCompany)s.company=detected||(all.length===1?all[0].company_id:'');
   const cs=document.createElement('select');cs.setAttribute('aria-label','บริษัทผู้จ่าย');
   cs.innerHTML='<option value="">เลือกบริษัทผู้จ่าย</option>'+[...new Set(rows.map(r=>r.company_id))].map(id=>'<option value="'+esc(id)+'">'+esc(rows.find(r=>r.company_id===id).company)+'</option>').join('');
   cs.value=s.company||'';cs.disabled=busy||!!detected;
   cs.onchange=()=>{s.company=cs.value;s.manualCompany=true;s.id='';renderSlips();};box.append(cs);
   const choices=s.company?slipChoices(o,rows,s.company):[];
   if(!choices.some(r=>r.id===s.id))s.id='';
   if(!s.id&&choices.length===1&&!s.error)s.id=choices[0].id;
   const rs=document.createElement('select');rs.setAttribute('aria-label','รายการที่โอน');
   rs.innerHTML='<option value="">'+(!s.company?'เลือกบริษัทผู้จ่ายก่อน':choices.length>1?'พบหลายรายการ กรุณาเลือก':choices.length?'เลือกรายการที่โอน':'ไม่พบคู่ที่ยอด บัญชี และธนาคารตรง')+'</option>'+choices.map(r=>'<option value="'+esc(r.id)+'">'+esc(r.doc+' · '+r.name+' · '+fmt(r.amount))+'</option>').join('');
   rs.value=s.id||'';rs.disabled=busy;rs.onchange=()=>{s.id=rs.value;updateCommit();};box.append(rs);
   const info=document.createElement('p');info.className=s.id?'ok':'muted';
   info.textContent=s.id?'จับคู่แล้ว • ตรวจชื่อ บริษัท ยอด และบัญชีก่อนยืนยัน':detected?'อ่านบริษัทผู้จ่ายได้จากสลิป':'ยังระบุบริษัทผู้จ่ายไม่ได้';
   if(!choices.length&&s.company){const near=rows.filter(r=>!r.hasSlip&&r.company_id===s.company&&Math.round(r.amount*100)===Math.round(Number(o.amount)*100)&&accountFits(o.recipient_acct_mask||o.recipient_acct,r.account));if(near.length)info.textContent='บัญชีและยอดตรง แต่ธนาคารไม่ตรง: สลิป '+o.recipient_bank+' / รายการ '+near.map(r=>r.bank).join(', ')+' — กรุณาตรวจข้อมูล';}
   box.append(info);
   if(s.error){const retry=document.createElement('button');retry.textContent='อ่านสลิปนี้ใหม่';retry.disabled=busy;retry.onclick=async()=>{busy=true;renderSlips();try{const j=await api('reread',{draft:s.draft.id});s.draft=j.draft;s.url=j.preview;s.error='';}catch(e){s.error=e.message;}busy=false;renderSlips();};box.append(retry);}
  }
  root.append(el);
 }
 updateCommit();
}
async function resume(){
 if(test||busy)return;busy=true;$('files').disabled=true;
 try{const j=await api('resume');let i=0;for(const d of j.drafts){
  if(slips.some(s=>s.draft?.id===d.id))continue;
  const s={draft:d,name:d.filename||'สลิป '+d.ref};slips.push(s);$('progress').textContent='กู้คืนและอ่านสลิปเดิม '+(++i)+' / '+j.drafts.length+' ใบ…';
  try{const r=await api('reread',{draft:d.id});s.draft=r.draft;s.url=r.preview;}catch(e){s.error=e.message;}
  renderSlips();
 }$('progress').textContent='กู้คืนสลิป '+j.drafts.length+' ใบ • ตรวจคู่รายการแล้วกดยืนยันแนบทั้งหมด';
 }catch(e){$('progress').textContent='กู้คืนสลิปไม่สำเร็จ: '+e.message;}
 busy=false;$('files').disabled=false;renderSlips();
}
function updateCommit(){const ready=slips.filter(s=>s.draft&&s.id&&s.company&&!s.done&&!s.error);$('commit').disabled=busy||test||!ready.length;$('commit').textContent='ยืนยันแนบทั้งหมด ('+ready.length+' รายการ)';}
async function imageData(file,preserve=false){if(preserve&&file.size<=6*1024*1024)return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('อ่านไฟล์ไม่สำเร็จ'));r.readAsDataURL(file);});if(file.size>20*1024*1024)throw Error('ไฟล์ใหญ่เกิน 20 MB');const url=URL.createObjectURL(file),im=new Image();im.src=url;await im.decode();const scale=Math.min(1,1800/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.round(im.width*scale);c.height=Math.round(im.height*scale);c.getContext('2d').drawImage(im,0,0,c.width,c.height);const data=c.toDataURL('image/jpeg',.9);URL.revokeObjectURL(url);return data;}
async function add(files,preserve=false){if(test||busy)return;if(slips.length+files.length>50){alert('อัปโหลดได้สูงสุด 50 ใบต่อชุด');return;}busy=true;$('files').disabled=true;updateCommit();for(const f of files){const s={name:f.name};slips.push(s);try{s.url=await imageData(f,preserve);renderSlips();$('progress').textContent='อ่านสลิป '+slips.length+' ใบ…';const j=await api('prepare',{image:s.url.split(',')[1],mime:s.url.slice(5,s.url.indexOf(';')),filename:f.name});const existing=slips.find(x=>x!==s&&x.draft&&(x.draft.id===j.draft.id||x.draft.hash===j.draft.hash||x.draft.ref===j.draft.ref));if(existing){if(existing.done)throw Error('สลิปนี้แนบสำเร็จแล้ว');existing.draft=j.draft;existing.url=s.url;existing.name=s.name;existing.error='';existing.id='';slips.splice(slips.indexOf(s),1);}else s.draft=j.draft;}catch(e){s.error=e.message;}renderSlips();}busy=false;$('files').disabled=false;$('progress').textContent='อ่านเสร็จ ตรวจบริษัทผู้จ่ายและคู่รายการก่อนยืนยัน';renderSlips();}
$('paste').onpaste=e=>{e.preventDefault();if(test||busy)return;let files=[...e.clipboardData.files].filter(f=>/^image\\/(jpeg|png|webp)$/.test(f.type));if(!files.length){const doc=new DOMParser().parseFromString(e.clipboardData.getData('text/html')||e.clipboardData.getData('text/plain'),'text/html');for(const im of doc.querySelectorAll('img')){const m=im.getAttribute('src')?.match(/^data:(image\\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);if(!m||m[2].length>8*1024*1024)continue;try{files.push(new File([Uint8Array.from(atob(m[2]),c=>c.charCodeAt(0))],im.getAttribute('alt')||'pasted-slip.jpg',{type:m[1]}));}catch{}}}if(files.length)add(files,true);else $('progress').textContent='ไม่พบภาพในคลิปบอร์ด กรุณาคัดลอกภาพสลิปหรือเลือกไฟล์';};
$('files').onchange=e=>add([...e.target.files]);$('drop').ondragover=e=>e.preventDefault();$('drop').ondrop=e=>{e.preventDefault();add([...e.dataTransfer.files]);};$('refresh').onclick=()=>{if(!busy)load();};$('uploadJump').onclick=()=>$('upload').scrollIntoView({behavior:'smooth'});
$('commit').onclick=async()=>{const selected=slips.filter(s=>s.draft&&s.id&&s.company&&!s.done&&!s.error);if(new Set(selected.map(s=>s.id)).size!==selected.length){alert('มีหลายสลิปเลือกใบสรุปเดียวกัน กรุณาตรวจใหม่');return;}if(!confirm('โอนเงินจริงและตรวจบริษัท/บัญชี/ยอดตรงแล้ว ยืนยันแนบ '+selected.length+' รายการ?'))return;busy=true;renderSlips();let ok=0,fail=0;for(const s of selected){try{const j=await api('commit',{pairs:[{draft:s.draft.id,id:s.id,company:s.company}]}),r=j.results[0];if(!r.ok)throw Error(r.error);s.done=true;ok++;}catch(e){s.error=e.message;fail++;}$('result').textContent='แนบสำเร็จ '+ok+' รายการ • ไม่สำเร็จ '+fail+' รายการ';}busy=false;await load();};(async()=>{await load();await resume();})();
</script></html>`;}
