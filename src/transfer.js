import {snapshot,people,financeStage,fingerprint,textOf,digest,api,SUMMARY,recordsPath} from './finance.js';
import {matchOCR} from './match.js';
import {uploadBytesToBitable} from './lark.js';
const digits=v=>String(v||'').replace(/\D/g,'');
export function slipFits(o,r){
 const acc=digits(o.recipient_acct), target=digits(r.account);
 return Number.isFinite(Number(o.amount))&&Math.round(Number(o.amount)*100)===Math.round(r.amount*100)&&String(o.currency||'').toUpperCase()===r.currency&&acc.length>=4&&target.endsWith(acc);
}
export async function portalAuth(owner,k){
 const key=await owner.ctx.storage.get('nonce:'+k), saved=key&&await owner.ctx.storage.get(key);
 if(!saved||!['transfer','test'].includes(saved.stage)||Date.now()-saved.created>7*86400000)throw Error('ลิงก์หมดอายุ เปิดการ์ดล่าสุดในผู้ช่วยบัญชี');
 const p=await people(owner.env);if(saved.recipient!==p.not)throw Error('ไม่มีสิทธิ์');return saved;
}
async function queue(owner,test){return (await snapshot(owner.env)).filter(x=>financeStage(x.r,x.j)===(test?'test':'transfer'));}
function view(x){const f=x.r.fields;return {id:x.r.record_id,doc:textOf(f['เลขใบขอเบิก']),company:x.j.company.name,company_id:x.j.company.id,name:x.j.employee.accountName,bank:x.j.employee.bankName,account:x.j.employee.accountNo,amount:Number(f['ยอดรวม']),currency:x.j.currency,bills:x.j.items.length,pdf:x.j.approvedPdf,hasSlip:!!f['หลักฐานการโอน']?.length};}
export async function portalAction(owner,b){
 const {ctx,env}=owner, saved=await portalAuth(owner,b.token),test=saved.stage==='test';
 if(b.op==='rows')return {ok:true,test,rows:(await queue(owner,test)).map(view)};
 if(test)throw Error('TEST ดูและคัดลอกตัวอย่างได้ แต่ไม่รับสลิปจริงและไม่เปลี่ยนสถานะจ่าย');
 if(b.op==='prepare'){
  if(!['image/jpeg','image/png','image/webp'].includes(b.mime)||typeof b.image!=='string'||b.image.length>9*1024*1024)throw Error('รับ JPG/PNG/WebP ไม่เกิน 6 MB ต่อใบ');
  const bin=atob(b.image),bytes=Uint8Array.from(bin,c=>c.charCodeAt(0)),hash=await digest(b.image);
  if(await ctx.storage.get('paidHash:'+hash))throw Error('สลิปนี้เคยแนบแล้ว');
  let draft=await ctx.storage.get('draftHash:'+hash);
  if(draft&&draft.owner===saved.recipient&&Date.now()-draft.at<2*3600000)return {ok:true,draft};
  const o=await matchOCR(env,b.image,b.mime);
  const ref=String(o.ref||'').replace(/\s/g,'');
  if(!ref||/^(null|none)$/i.test(ref))throw Error('อ่านเลขอ้างอิงสลิปไม่ได้ กรุณาใช้ภาพชัดเจน');
  const refKey='paidRef:'+await digest(ref);
  if(await ctx.storage.get(refKey))throw Error('เลขอ้างอิงนี้เคยใช้แล้ว');
  const file=await uploadBytesToBitable(env,bytes.buffer,b.filename||'transfer.jpg');
  draft={id:crypto.randomUUID(),hash,refKey,ref,ocr:o,file,owner:saved.recipient,at:Date.now()};
  await ctx.storage.put('draft:'+draft.id,draft);await ctx.storage.put('draftHash:'+hash,draft);
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
</style><main><div class="muted">ผู้ช่วยบัญชี • นอต</div><h1>รายการโอน</h1><div id="notice" class="warn">กำลังโหลด…</div><div class="actions"><button id="refresh">โหลดรายการล่าสุด</button><button id="uploadJump">ไปแนบสลิป</button></div><div id="queue"></div><section class="box" id="upload"><h2>โอนแล้ว → แนบสลิปหลายใบ</h2><p>เลือกสลิปได้พร้อมกัน 20 ใบหรือสูงสุด 50 ใบ ระบบอ่านและเสนอคู่ให้ตรวจ ก่อนยืนยันแนบทั้งหมดครั้งเดียว</p><div id="drop"><input id="files" type="file" accept="image/jpeg,image/png,image/webp" multiple><p class="muted">หรือลากรูปสลิปมาวางที่นี่</p></div><div id="progress"></div><div id="slips"></div><button class="primary" id="commit" disabled>ยืนยันแนบทั้งหมด</button><p id="result"></p></section></main><script>
const TOKEN=${JSON.stringify(token)},$=id=>document.getElementById(id);let rows=[],slips=[],test=false,busy=false;const fmt=n=>Number(n).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const dg=v=>String(v||'').replace(/\\D/g,'');
async function api(op,p={}){const r=await fetch('/?act=transfer-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:TOKEN,op,...p})});const j=await r.json();if(!j.ok)throw Error(j.error||'ไม่สำเร็จ');return j;}
async function copy(v,b){try{await navigator.clipboard.writeText(v);b.textContent='คัดลอกแล้ว ✓';setTimeout(()=>b.textContent=b.dataset.label,1600);}catch{prompt('คัดลอกข้อมูลนี้',v);}}
function renderQueue(){const root=$('queue');root.innerHTML='';for(const cid of [...new Set(rows.map(r=>r.company_id))]){const group=rows.filter(r=>r.company_id===cid),s=document.createElement('section');s.innerHTML='<h2>'+esc(group[0].company)+'</h2><p>'+group.length+' รายการโอน • '+group.reduce((n,r)=>n+r.bills,0)+' บิล</p><div class="grid"></div>';for(const r of group){const a=document.createElement('article');a.innerHTML='<strong>'+esc(r.name)+'</strong><div>'+esc(r.bank)+' · '+esc(r.account)+'</div><div class="amount">'+fmt(r.amount)+' '+esc(r.currency)+'</div><div class="muted">'+esc(r.doc)+' • '+r.bills+' บิล</div>'+(r.hasSlip?'<p class="warn">มีสลิปอยู่แล้ว ตรวจรายการก่อนโอนซ้ำ</p>':'')+'<p class="actions"><button data-label="คัดลอกบัญชี">คัดลอกบัญชี</button><button data-label="คัดลอกยอด">คัดลอกยอด</button></p><a target="_blank" rel="noopener noreferrer" href="'+esc(r.pdf)+'">ดู PDF อนุมัติแล้ว</a>';const b=a.querySelectorAll('button');b[0].onclick=()=>copy(dg(r.account),b[0]);b[1].onclick=()=>copy(r.amount.toFixed(2),b[1]);s.querySelector('.grid').append(a);}root.append(s);}if(!rows.length)root.textContent='ไม่มีรายการรอโอน';}
async function load(){try{const j=await api('rows');rows=j.rows;test=j.test;$('notice').textContent=test?'TEST • ห้ามโอนเงินจริง • หน้านี้ดูและคัดลอกเพื่อทดสอบเท่านั้น ไม่บันทึกจ่าย':'เลือกบริษัทให้ตรงกับบัญชีที่ใช้โอน แล้วคัดลอกบัญชีและยอดไปโอนผ่านธนาคาร';$('files').disabled=test||busy;renderQueue();renderSlips();}catch(e){$('notice').textContent=e.message;}}
function fits(o,r){const a=dg(o.recipient_acct);return Math.round(Number(o.amount)*100)===Math.round(r.amount*100)&&String(o.currency||'').toUpperCase()===r.currency&&a.length>=4&&dg(r.account).endsWith(a);}
function renderSlips(){const root=$('slips');root.innerHTML='';for(const s of slips){const el=document.createElement('div');el.className='slip';el.innerHTML='<img src="'+esc(s.url)+'"><div><strong>'+esc(s.name)+'</strong><p>'+esc(s.error|| (s.done?'แนบสำเร็จแล้ว':s.draft?fmt(s.draft.ocr.amount)+' '+s.draft.ocr.currency+' · '+s.draft.ocr.recipient_name+' · '+s.draft.ocr.recipient_acct:'รออ่านสลิป'))+'</p></div>';const box=el.lastChild;if(s.draft&&!s.done){const cs=document.createElement('select');cs.innerHTML='<option value="">เลือกบริษัทผู้จ่าย</option>'+[...new Set(rows.map(r=>r.company_id))].map(id=>'<option value="'+esc(id)+'">'+esc(rows.find(r=>r.company_id===id).company)+'</option>').join('');cs.value=s.company||'';cs.disabled=busy;cs.onchange=()=>{s.company=cs.value;s.id='';renderSlips();};box.append(cs);const choices=rows.filter(r=>r.company_id===s.company&&!r.hasSlip&&fits(s.draft.ocr,r));const rs=document.createElement('select');rs.innerHTML='<option value="">'+(choices.length?'เลือกรายการที่โอน':'ไม่พบคู่ที่ยอด/บัญชีตรง')+'</option>'+choices.map(r=>'<option value="'+esc(r.id)+'">'+esc(r.doc+' · '+r.name+' · '+fmt(r.amount))+'</option>').join('');if(!s.id&&choices.length===1)s.id=choices[0].id;rs.value=s.id||'';rs.disabled=busy;rs.onchange=()=>{s.id=rs.value;updateCommit();};box.append(rs);}root.append(el);}updateCommit();}
function updateCommit(){const ready=slips.filter(s=>s.draft&&s.id&&s.company&&!s.done&&!s.error);$('commit').disabled=busy||test||!ready.length;$('commit').textContent='ยืนยันแนบทั้งหมด ('+ready.length+' รายการ)';}
async function imageData(file){if(file.size>20*1024*1024)throw Error('ไฟล์ใหญ่เกิน 20 MB');const url=URL.createObjectURL(file),im=new Image();im.src=url;await im.decode();const scale=Math.min(1,1800/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.round(im.width*scale);c.height=Math.round(im.height*scale);c.getContext('2d').drawImage(im,0,0,c.width,c.height);const data=c.toDataURL('image/jpeg',.9);URL.revokeObjectURL(url);return data;}
async function add(files){if(test||busy)return;if(slips.length+files.length>50){alert('อัปโหลดได้สูงสุด 50 ใบต่อชุด');return;}busy=true;$('files').disabled=true;updateCommit();for(const f of files){const s={name:f.name};slips.push(s);try{s.url=await imageData(f);renderSlips();$('progress').textContent='อ่านสลิป '+slips.length+' ใบ…';const j=await api('prepare',{image:s.url.split(',')[1],mime:'image/jpeg',filename:f.name});if(slips.some(x=>x!==s&&x.draft&&(x.draft.hash===j.draft.hash||x.draft.ref===j.draft.ref)))throw Error('สลิปซ้ำในชุดนี้');s.draft=j.draft;}catch(e){s.error=e.message;}renderSlips();}busy=false;$('files').disabled=false;$('progress').textContent='อ่านเสร็จ เลือกบริษัทผู้จ่ายของแต่ละสลิป แล้วตรวจคู่รายการ';renderSlips();}
$('files').onchange=e=>add([...e.target.files]);$('drop').ondragover=e=>e.preventDefault();$('drop').ondrop=e=>{e.preventDefault();add([...e.dataTransfer.files]);};$('refresh').onclick=()=>{if(!busy)load();};$('uploadJump').onclick=()=>$('upload').scrollIntoView({behavior:'smooth'});
$('commit').onclick=async()=>{const selected=slips.filter(s=>s.draft&&s.id&&s.company&&!s.done&&!s.error);if(new Set(selected.map(s=>s.id)).size!==selected.length){alert('มีหลายสลิปเลือกใบสรุปเดียวกัน กรุณาตรวจใหม่');return;}if(!confirm('โอนเงินจริงและตรวจบริษัท/บัญชี/ยอดตรงแล้ว ยืนยันแนบ '+selected.length+' รายการ?'))return;busy=true;renderSlips();let ok=0,fail=0;for(const s of selected){try{const j=await api('commit',{pairs:[{draft:s.draft.id,id:s.id,company:s.company}]}),r=j.results[0];if(!r.ok)throw Error(r.error);s.done=true;ok++;}catch(e){s.error=e.message;fail++;}$('result').textContent='แนบสำเร็จ '+ok+' รายการ • ไม่สำเร็จ '+fail+' รายการ';}busy=false;await load();};load();
</script></html>`;}
