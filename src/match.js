import { COMPANIES, companyOf, companyFromName } from './companies.js';
// ════════════════════════════════════════════════════════════════
// match.js — ฟีเจอร์ "แมตยอด" (แยกตัวจาก flow ReceiptBot เดิม ไม่ชนกัน)
//   reuse จาก lark.js: larkToken, uploadBytesToBitable
//   reuse จาก config.js: CFG (BASE_TOKEN / LARK_HOST / CLAUDE_*)
// ════════════════════════════════════════════════════════════════
import { CFG } from './config.js';
import { larkToken, uploadBytesToBitable } from './lark.js';

const enc = new TextEncoder(), dec = new TextDecoder();

// ── 3 ตาราง + ช่อง (ชื่อ field ตรงกับที่สร้างไว้ใน Bitable) ──
export const TABLES = {
  partner:  { label:'คู่ค้า',   table_id:'tbldczVhrFWfJ5ze', f_company:'ชื่อบริษัท',
              f_name:'ชื่อบริษัทคู่ค้าผู้รับเงิน', f_amount:'ยอดโอนเงิน', f_account:'เลขบัญชีผู้รับเงิน', f_currency:'สกุลเงิน' },
  internal: { label:'ภายใน',    table_id:'tblgakFKBOvz9aCW', f_company:'บริษัท',
              f_name:'ชื่อพนักงาน', f_amount:'ยอดรวม', f_account:'เลขบัญชี', f_currency:null },
  dealpay:  { label:'DEALPAY',  table_id:'tblQ1irGp6iyz0Mc', f_company:'บริษัท',
              f_name:'ชื่อบัญชีผู้รับเงิน', f_amount:'จำนวนเงิน', f_account:'เลขที่บัญชีธนาคาร', f_currency:null },
};
// ช่อง write-back (เหมือนกันทั้ง 3 ตาราง)
export const WB = { slip:'หลักฐานการโอน', done:'รายการสำเร็จ', matchedAt:'เวลาที่แมต' };

// ════════ ตรรกะแมต (ทดสอบผ่านแล้ว) ════════
function parseAmount(s){ if(s==null)return NaN; if(typeof s==='number')return s;
  const m=String(s).replace(/[฿,\s]/g,'').replace(/บาท/g,'').match(/-?\d+(\.\d+)?/); return m?parseFloat(m[0]):NaN; }
function normCur(s){ s=String(s||'').toUpperCase();
  if(/USD|ดอลล|US\$|\$/.test(s))return'USD'; if(/THB|บาท|฿|BAHT/.test(s))return'THB'; return''; }
function curMatch(a,b){ a=normCur(a);b=normCur(b); if(!a||!b)return true; return a===b; }
function digitsOnly(s){ return String(s||'').replace(/\D/g,''); }
function last4(s){ const d=digitsOnly(s); return d.length>=4?d.slice(-4):d; }
const TITLES=/(นาย|นางสาว|น\.ส\.|นาง|บจก\.?|บริษัท|จำกัด|มหาชน|ห้างหุ้นส่วน|หจก\.?|ร้าน|คุณ|mr\.?|ms\.?|mrs\.?|co\.?,?\s?ltd\.?|company|limited)/gi;
function normName(s){ return String(s||'').toLowerCase().replace(/[*.\-_/()]/g,' ').replace(TITLES,' ').replace(/\s+/g,'').trim(); }
function lev(a,b){ a=a||'';b=b||'';const m=a.length,n=b.length;if(!m)return n;if(!n)return m;
  const d=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);for(let j=0;j<=n;j++)d[0][j]=j;
  for(let i=1;i<=m;i++)for(let j=1;j<=n;j++){const c=a[i-1]===b[j-1]?0:1;d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+c);}return d[m][n]; }
function nameSim(a,b){ a=normName(a);b=normName(b);if(!a||!b)return 0;if(a===b)return 1;
  if(a.includes(b)||b.includes(a))return 0.92;const L=Math.max(a.length,b.length);return 1-lev(a,b)/L; }

export function matchOne(slip, rows){
  if(!companyOf(slip.company_id))return {status:'miss',reason:'ต้องเลือกบริษัทก่อนแมตสลิป'};
  const amt=parseAmount(slip.amount), cur=normCur(slip.currency);
  if(isNaN(amt)) return {status:'miss',reason:'อ่านยอดไม่ได้'};
  const cands=rows.filter(r=>companyOf(slip.company_id) && r.company_id===slip.company_id && !r.matched && Math.abs(r.amount-amt)<0.005 && curMatch(r.currency,cur));
  if(cands.length===0){
    const curBlock=rows.some(r=>Math.abs(r.amount-amt)<0.005 && !curMatch(r.currency,cur));
    const anyAmt=rows.some(r=>Math.abs(r.amount-amt)<0.005);
    return {status:'miss',reason:curBlock?'ยอดตรงแต่คนละสกุลเงิน':(anyAmt?'ยอดตรงแต่ถูกจับไปหมดแล้ว':'ไม่มียอดนี้ในสรุปเบิก')};
  }
  if(cands.length===1){cands[0].matched=true;return {status:'ok',row:cands[0],by:'ยอด'};}
  const acc=last4(slip.recipient_acct);
  if(acc){ const byAcc=cands.filter(r=>r.account && last4(r.account)===acc);
    if(byAcc.length===1){byAcc[0].matched=true;return {status:'ok',row:byAcc[0],by:'บัญชี'};} }
  const scored=cands.map(r=>({r,s:nameSim(r.name,slip.recipient_name)})).sort((a,b)=>b.s-a.s);
  const gap=scored.length<2?1:scored[0].s-scored[1].s;
  if(scored[0].s>=0.6 && gap>=0.15){scored[0].r.matched=true;return {status:'ok',row:scored[0].r,by:'ชื่อ'};}
  return {status:'warn',cands,reason:`มี ${cands.length} รายการยอดเท่ากัน แยกด้วยบัญชี/ชื่อไม่ชัด`};
}
function rowFromRecord(rec, T, tableKey){
  const f=rec.fields||{};
  const val=x=>{ if(x==null)return ''; if(Array.isArray(x))return x.map(v=>v&&v.text?v.text:v).join(' ');
    if(typeof x==='object')return x.text||x.name||''; return x; };
  return { company_id:companyFromName(val(f[T.f_company]))?.id || '', company:val(f[T.f_company]) || 'ยังไม่ระบุบริษัท', record_id:rec.record_id, name:val(f[T.f_name]), amount:parseAmount(val(f[T.f_amount])),
    account:digitsOnly(val(f[T.f_account])), currency:T.f_currency?normCur(val(f[T.f_currency])):'', matched:false, table:tableKey };
}

// ════════ Bitable list / update ════════
async function listOpenRecords(env, T){
  const tok=await larkToken(env); let items=[], page='';
  for(let g=0; g<40; g++){
    const url=`${CFG.LARK_HOST}/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${T.table_id}/records?page_size=500`+(page?`&page_token=${encodeURIComponent(page)}`:'');
    const j=await (await fetch(url,{headers:{Authorization:'Bearer '+tok}})).json();
    if(j.code!==0) throw new Error('list '+j.code+' '+j.msg);
    items=items.concat(j.data.items||[]);
    if(!j.data.has_more) break; page=j.data.page_token;
  }
  return items.filter(it=>{ const v=it.fields?.[WB.done]; return v!==true && v!=='true'; });
}
async function putRecord(env, T, record_id, fields){
  const tok=await larkToken(env);
  const url=`${CFG.LARK_HOST}/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${T.table_id}/records/${record_id}`;
  const j=await (await fetch(url,{method:'PUT',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'},body:JSON.stringify({fields})})).json();
  if(j.code!==0) throw new Error('put '+j.code+' '+j.msg);
  return j;
}

// ════════ Claude OCR สลิปโอน (ต่างจาก claudeOCR เดิมที่อ่านใบเสร็จ) ════════
function abToBase64(buf){ const b=new Uint8Array(buf);let s='';const c=0x8000;
  for(let i=0;i<b.length;i+=c)s+=String.fromCharCode.apply(null,b.subarray(i,i+c)); return btoa(s); }
export async function matchOCR(env, base64, mime){
  const key=env.CLAUDE_KEY||env.ANTHROPIC_API_KEY;
  const mt=/png|jpe?g|webp|gif/i.test(mime||'') ? String(mime).toLowerCase().replace('image/jpg','image/jpeg') : 'image/jpeg';
  const prompt=`อ่านสลิปโอนเงินธนาคารไทย ตอบ JSON เท่านั้น:
{"ref":"Transaction ID / เลขที่รายการ / เลขอ้างอิง หรือ null","amount":เลข|null,"currency":"THB|USD","recipient_name":"ชื่อผู้รับ|null","recipient_acct":"เลขบัญชีผู้รับตามภาพ เก็บ x และขีดทุกตำแหน่ง|null","recipient_acct_mask":"เลขบัญชีผู้รับตามภาพ ห้ามลบหรือเติมตัวเลข/x|null","recipient_bank":"ชื่อธนาคารผู้รับ|null","sender_name":"ชื่อผู้โอนฝั่ง From ทั้งไทยและอังกฤษ|null","sender_acct":"เลขบัญชีผู้โอนตามภาพ|null"}
เริ่มอ่าน ref จากบรรทัด เลขที่รายการ / Transaction ID ใต้หัวข้อ Transfer Completed ด้านบนของสลิป K BIZ คัดลอกรหัสทั้งหมดทั้งตัวอักษรและตัวเลขตามภาพ (มักขึ้นต้น TRTS หรือ TRBS) รหัสนี้คือเลขอ้างอิงธุรกรรมที่ต้องการ ห้ามใช้เลขบัญชีหรือวันที่แทน ห้ามเดาหรือเพิ่มลดตัวเลข ถ้าอ่านไม่ได้จริงให้ null
ห้ามเดาตัวเลขที่ซ่อน สลิป K BIZ เช่น xxx-x-x9079-x ให้คงเป็น xxx-x-x9079-x ไม่ใช่ 9079 เพราะตัวสุดท้ายก็ถูกซ่อน ชื่อธนาคารผู้รับอ่านจากฝั่ง To ไม่ใช่โลโก้หัวกระดาษหรือฝั่ง From ชื่อบริษัทผู้โอนอ่านจากฝั่ง From เท่านั้น ถ้าอ่านไม่ได้ให้ null ยอดใช้จำนวนเงินโอน ไม่รวมค่าธรรมเนียม`;
  const read=async instruction=>{
  const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
    headers:{'x-api-key':key,'anthropic-version':CFG.CLAUDE_VERSION,'Content-Type':'application/json'},
    body:JSON.stringify({model:CFG.CLAUDE_MODEL,max_tokens:1000,messages:[
      {role:'user',content:[{type:'image',source:{type:'base64',media_type:mt,data:base64}},{type:'text',text:instruction}]},
      {role:'assistant',content:'{'}]})});
  const raw=await res.text(); let body;
  try{ body=JSON.parse(raw); }catch(e){ throw new Error('Claude ไม่ใช่ JSON: '+raw.slice(0,80)); }
  if(body.error) throw new Error('Claude: '+(body.error.message||'').slice(0,120));
  let text=(body.content||[]).map(c=>c.text||'').join(''); if(text[0]!=='{')text='{'+text;
  const m=text.match(/\{[\s\S]*\}/); if(!m) throw new Error('no json');
  return JSON.parse(m[0]);
  };
  const o=await read(prompt);
  if(!o.ref||/^(null|none)$/i.test(String(o.ref))){
    const reference=await read('อ่านเฉพาะรหัสธุรกรรมจากภาพนี้: บรรทัด "เลขที่รายการ / Transaction ID" ใต้ "Transfer Completed" ด้านบนของสลิป K BIZ หรือเลขอ้างอิงธุรกรรมของธนาคารอื่น คัดลอกตัวอักษรและตัวเลขทุกตัวตรงตามภาพ ห้ามใช้เลขบัญชี วันที่ หรือเดาตัวเลข ตอบ JSON เท่านั้น {"ref":"รหัสที่อ่านได้ หรือ null ถ้าอ่านไม่ได้"}');
    o.ref=reference.ref||null;
  }
  o.amount=parseAmount(o.amount); return o;
}

// ════════ token gate (HMAC) ════════
async function hmac(secret,msg){
  const k=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC',k,enc.encode(msg))));
}
export async function signMatchToken(env, open_id){
  const exp=Date.now()+30*60*1000; const b=`${open_id}.${exp}`;
  return `${b64url(enc.encode(b))}.${await hmac(env.SIGNING_SECRET,b)}`;
}
export async function verifyMatchToken(env, token){
  try{ const [b,sig]=String(token).split('.'); const body=dec.decode(ub64url(b));
    if(await hmac(env.SIGNING_SECRET,body)!==sig) return null;
    const [open_id,exp]=body.split('.'); if(Date.now()>Number(exp)) return null; return {open_id};
  }catch(e){ return null; }
}
function allowedAcct(env, open_id){
  const wl=(env.ACCOUNTING_OPENIDS||'').split(',').map(s=>s.trim()).filter(Boolean);
  return open_id && wl.includes(open_id);
}

// ════════ API (เรียกจาก index.js handlePost) ════════
const J=(o)=>new Response(JSON.stringify(o),{headers:{'Content-Type':'application/json; charset=utf-8'}});
export async function matchApi(act, request, env){
  let body={}; try{ body=await request.json(); }catch(e){}
  const v=await verifyMatchToken(env, body.token); if(!v) return J({ok:false,error:'token ไม่ผ่าน'});
  if(act==='match-ocr'){
    try{ return J({ok:true,data:await matchOCR(env, body.image, body.mime)}); }
    catch(e){ return J({ok:false,error:'อ่านไม่ได้: '+String(e.message||e).slice(0,110)}); }
  }
  if(!allowedAcct(env, v.open_id)) return J({ok:false,error:'ไม่มีสิทธิ์ (เฉพาะฝ่ายบัญชี)'});

  if(act==='match-rows'){
    if(['partner','dealpay'].includes(body.table))return J({ok:false,error:'คู่ค้าและ DEALPAY ใช้ปุ่มแนบสลิปจากการ์ดรอนอตโอน หลังผ่านบัญชี นอต และเมย์แล้ว'});
    // ดึงทุกตาราง (auto) หรือเฉพาะตารางเดียวถ้าระบุ
    const keys = (body.table && body.table!=='all' && TABLES[body.table]) ? [body.table] : Object.keys(TABLES);
    try{
      let rows=[];
      for(const key of keys){
        if(key==='partner'||key==='dealpay')continue;
        const T=TABLES[key];
        const recs=await listOpenRecords(env,T);
        rows=rows.concat(recs.map(r=>rowFromRecord(r,T,key)).filter(r=>r.name && !isNaN(r.amount)));
      }
      return J({ok:true,rows});
    }catch(e){ return J({ok:false,error:String(e.message||e)}); }
  }

  if(act==='match-commit'){
    const results=[];
    for(const pr of (body.pairs||[])){
      try{
        if(pr.table==='partner'||pr.table==='dealpay')throw new Error('คู่ค้าและ DEALPAY ต้องแนบสลิปจากการ์ดรอนอตโอน เพื่อยืนยันผลอนุมัติและบัญชีผู้รับ');
        const T=TABLES[pr.table]; if(!T) throw new Error('ตารางของรายการไม่ถูกต้อง');
        if(!companyOf(pr.company_id))throw new Error('ต้องเลือกบริษัทก่อนแมตสลิป');
        const current=(await listOpenRecords(env,T)).find(r=>r.record_id===pr.record_id);
        if(!current || rowFromRecord(current,T,pr.table).company_id!==pr.company_id)throw new Error('บริษัทไม่ตรงหรือรายการเสร็จแล้ว กรุณาโหลดใหม่');
        const buf=b64ToBuf(pr.image);
        const ft=await uploadBytesToBitable(env, buf, pr.filename||'slip.jpg');   // reuse ตัวเดิม (bitable_image)
        await putRecord(env, T, pr.record_id, { [WB.slip]:[{file_token:ft}], [WB.matchedAt]:Date.now() });
        await putRecord(env, T, pr.record_id, { [WB.done]:true });                // ติ๊กสุดท้าย -> ปลุกระบบแจ้งแชท
        results.push({record_id:pr.record_id,ok:true});
      }catch(e){ results.push({record_id:pr.record_id,ok:false,error:String(e.message||e)}); }
    }
    return J({ok:true,results});
  }
  return J({ok:false,error:'unknown act'});
}

// ════════ การ์ดในแชท ════════
export function matchCard(link){
  return { config:{wide_screen_mode:true},
    header:{template:'red',title:{tag:'plain_text',content:'แมตยอด · ฝ่ายบัญชี'}},
    elements:[
      {tag:'div',text:{tag:'lark_md',content:'เบิกภายใน: เปิดหน้าแมตแล้วแนบสลิป\nคู่ค้า / DEALPAY: ใช้ปุ่มแนบสลิปจากการ์ดรอนอตโอน หลังเมย์อนุมัติ'}},
      {tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:'เปิดหน้าแมตยอด'},type:'primary',url:link}]}
    ]};
}

// ════════ base64 helpers ════════
function b64url(u8){ let s='';for(const b of u8)s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function ub64url(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); const bin=atob(s);
  const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u; }
function b64ToBuf(b64){ const bin=atob(b64);const u=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer; }

// ════════ หน้าเว็บแมต ════════
export function matchPageHTML(token){
return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>แมตยอด | DEAL</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Anuphan:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#F5F3EF;--ink:#2B2B2B;--red:#8B1E1E;--line:#E2DDD4;--card:#FBFAF7;--muted:#7A756C;--ok:#2F6B3E;--ok-bg:#EAF2EB;--warn:#8A6D1E;--warn-bg:#F5EFDD;--miss:#8B1E1E;--miss-bg:#F4E7E7;--sans:'Plus Jakarta Sans','Anuphan',sans-serif;--thai:'Anuphan','Plus Jakarta Sans',sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--thai);font-size:15px;line-height:1.55}
.wrap{max-width:1000px;margin:0 auto;padding:24px 18px 80px}.mark{font-family:var(--sans);font-weight:700;font-size:19px}.mark b{color:var(--red)}
h1{font-family:var(--sans);font-size:23px;margin:12px 0 16px}
.step{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px}
label{font-family:var(--sans);font-weight:600;font-size:14px;display:block;margin-bottom:8px}
select{width:100%;max-width:320px;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;font-family:var(--thai);font-size:15px}
.drop{border:1.5px dashed var(--line);border-radius:12px;padding:24px;text-align:center;background:#fff;cursor:pointer}.drop.over{border-color:var(--red)}.drop strong{font-family:var(--sans)}.drop p{margin:6px 0 0;color:var(--muted);font-size:13px}
.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.thumb{width:56px;height:56px;border-radius:8px;object-fit:cover;border:1px solid var(--line)}
button.go{font-family:var(--sans);font-weight:600;font-size:15px;background:var(--red);color:#fff;border:none;padding:12px 26px;border-radius:10px;cursor:pointer}button.go:disabled{background:#C9C3B9;cursor:not-allowed}
.bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:8px}.bar>span{display:block;height:100%;background:var(--ink);width:0;transition:width .2s}small.mut{color:var(--muted)}
.row{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.stat{flex:1;min-width:100px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.stat .n{font-family:var(--sans);font-weight:700;font-size:24px}.stat .l{color:var(--muted);font-size:13px}.stat.ok .n{color:var(--ok)}.stat.warn .n{color:var(--warn)}.stat.miss .n{color:var(--miss)}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:6px}th{font-family:var(--sans);text-align:left;font-size:12px;color:var(--muted);text-transform:uppercase;padding:9px 8px;border-bottom:1px solid var(--line)}td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}tr.ok{background:var(--ok-bg)}tr.warn{background:var(--warn-bg)}tr.miss{background:var(--miss-bg)}
.amt{font-family:var(--sans);font-weight:600}.badge{font-family:var(--sans);font-size:11px;font-weight:600;padding:3px 9px;border-radius:99px}.badge.ok{background:var(--ok);color:#fff}.badge.warn{background:var(--warn);color:#fff}.badge.miss{background:var(--miss);color:#fff}
.hidden{display:none}.err{color:var(--red);font-size:13px;margin-top:10px}
</style></head><body><div class="wrap">
<span class="mark">DEAL<b>!</b></span><h1>แมตยอด → เขียนกลับ Bitable</h1>
<div class="step"><label>1 · ตาราง (ปล่อย “ทั้งหมด” ได้เลย ระบบแยกให้เอง)</label>
<select id="table"><option value="all" selected>ทั้งหมด (auto)</option><option value="partner">คู่ค้า</option><option value="internal">ภายใน</option><option value="dealpay">DEALPAY</option></select>
<label>บริษัทผู้จ่าย <select id="company" onchange="loadRows()"><option value="">เลือกบริษัทก่อนแมต</option>${COMPANIES.map(c=>`<option value="${c.id}">${c.label}</option>`).join('')}</select></label><div id="loadrows"><small class="mut">ระบบจะดึงรายการที่ยังไม่แมตจากทุกตารางมาให้เอง</small></div></div>
<div class="step"><label>2 · โยนสลิปโอน</label>
<div class="drop" id="drop"><strong>ลากสลิปมาวาง</strong><p>หรือกดเลือก · <span id="count">0</span> ใบ</p></div>
<input type="file" id="file" accept="image/*" multiple class="hidden"/><div class="thumbs" id="thumbs"></div></div>
<div class="step"><button class="go" id="run" disabled>แมตยอด</button>
<div id="prog" class="hidden"><div class="bar"><span id="fill"></span></div><small class="mut" id="ptext"></small></div>
<div class="err hidden" id="err"></div></div>
<div id="results" class="hidden">
<div class="row"><div class="stat ok"><div class="n" id="cOk">0</div><div class="l">แมตแล้ว</div></div>
<div class="stat warn"><div class="n" id="cWarn">0</div><div class="l">ต้องเช็ก</div></div>
<div class="stat miss"><div class="n" id="cMiss">0</div><div class="l">ไม่เจอคู่</div></div></div>
<table><thead><tr><th>#</th><th>สลิป</th><th>ยอด</th><th>ผู้รับ/บัญชี</th><th>จับคู่กับ</th><th>วิธี</th><th>สถานะ</th></tr></thead><tbody id="rows"></tbody></table>
<div class="row" style="margin-top:16px"><button class="go" id="commit" disabled>ยืนยัน & เขียนกลับ Bitable</button></div>
<div id="commitOut"></div></div>
<script>
const TOKEN=${JSON.stringify(token)};const $=id=>document.getElementById(id);
const LABEL={partner:'คู่ค้า',internal:'ภายใน',dealpay:'DEALPAY'};
const slips=[];let refRows=[];let matched=[];
const fmt=n=>(n==null||isNaN(n))?'':Number(n).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
function pAmt(s){if(s==null)return NaN;if(typeof s==='number')return s;const m=String(s).replace(/[฿,\\s]/g,'').replace(/บาท/g,'').match(/-?\\d+(\\.\\d+)?/);return m?parseFloat(m[0]):NaN;}
function nCur(s){s=String(s||'').toUpperCase();if(/USD|ดอลล|US\\$|\\$/.test(s))return'USD';if(/THB|บาท|฿|BAHT/.test(s))return'THB';return'';}
function cM(a,b){a=nCur(a);b=nCur(b);if(!a||!b)return true;return a===b;}
function dg(s){return String(s||'').replace(/\\D/g,'');}function l4(s){const d=dg(s);return d.length>=4?d.slice(-4):d;}
const TT=/(นาย|นางสาว|น\\.ส\\.|นาง|บจก\\.?|บริษัท|จำกัด|มหาชน|ห้างหุ้นส่วน|หจก\\.?|ร้าน|คุณ|mr\\.?|ms\\.?|mrs\\.?|co\\.?,?\\s?ltd\\.?|company|limited)/gi;
function nN(s){return String(s||'').toLowerCase().replace(/[*.\\-_/()]/g,' ').replace(TT,' ').replace(/\\s+/g,'').trim();}
function lev(a,b){a=a||'';b=b||'';const m=a.length,n=b.length;if(!m)return n;if(!n)return m;const d=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);for(let j=0;j<=n;j++)d[0][j]=j;for(let i=1;i<=m;i++)for(let j=1;j<=n;j++){const c=a[i-1]===b[j-1]?0:1;d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+c);}return d[m][n];}
function sim(a,b){a=nN(a);b=nN(b);if(!a||!b)return 0;if(a===b)return 1;if(a.includes(b)||b.includes(a))return 0.92;const L=Math.max(a.length,b.length);return 1-lev(a,b)/L;}
function matchOne(o){const amt=pAmt(o.amount),cur=nCur(o.currency);if(isNaN(amt))return{status:'miss',reason:'อ่านยอดไม่ได้'};
 const c=refRows.filter(r=>$('company').value && r.company_id===$('company').value && !r.matched&&Math.abs(r.amount-amt)<0.005&&cM(r.currency,cur));
 if(c.length===0){const cb=refRows.some(r=>Math.abs(r.amount-amt)<0.005&&!cM(r.currency,cur));return{status:'miss',reason:cb?'คนละสกุลเงิน':'ไม่มียอดนี้'};}
 if(c.length===1){c[0].matched=true;return{status:'ok',row:c[0],by:'ยอด'};}
 const a=l4(o.recipient_acct);if(a){const ba=c.filter(r=>r.account&&l4(r.account)===a);if(ba.length===1){ba[0].matched=true;return{status:'ok',row:ba[0],by:'บัญชี'};}}
 const sc=c.map(r=>({r,s:sim(r.name,o.recipient_name)})).sort((x,y)=>y.s-x.s);const gap=sc.length<2?1:sc[0].s-sc[1].s;
 if(sc[0].s>=0.6&&gap>=0.15){sc[0].r.matched=true;return{status:'ok',row:sc[0].r,by:'ชื่อ'};}
 return{status:'warn',cands:c,reason:'ยอดซ้ำ แยกไม่ชัด'};}
async function api(act,payload){const r=await fetch('/?act='+act,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:TOKEN,...payload})});return r.json();}
async function loadRows(){$('loadrows').innerHTML='<small class="mut">กำลังดึง…</small>';
 const j=await api('match-rows',{table:$('table').value});
 if(!j.ok){$('loadrows').innerHTML='<span class="err">'+(j.error||'โหลดไม่ได้')+'</span>';return;}
 refRows=j.rows.map(x=>({...x,matched:false}));matched=[];$('results').classList.add('hidden');$('commit').disabled=true;$('loadrows').innerHTML='<small class="mut">รายการที่ยังไม่แมต: '+refRows.length+' ราย · ไม่มีบริษัทที่รู้จัก '+refRows.filter(r=>!r.company_id).length+' ราย (ต้องระบุบริษัทก่อนแมต)</small>';updateRun();}
$('table').addEventListener('change',loadRows);
const drop=$('drop'),fi=$('file');drop.onclick=()=>fi.click();
['dragover','dragenter'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('over');}));
drop.addEventListener('drop',ev=>add(ev.dataTransfer.files));fi.addEventListener('change',ev=>add(ev.target.files));
function add(list){const fs=[...list].filter(f=>f.type.startsWith('image/'));let p=fs.length;if(!p)return;
 fs.forEach(f=>{const rd=new FileReader();rd.onload=()=>{const u=rd.result;slips.push({id:crypto.randomUUID(),name:f.name,dataURL:u,base64:u.split(',')[1],mime:f.type});if(--p===0)renderThumbs();};rd.readAsDataURL(f);});}
function renderThumbs(){const b=$('thumbs');b.innerHTML='';slips.forEach(s=>{const i=document.createElement('img');i.className='thumb';i.src=s.dataURL;b.appendChild(i);});$('count').textContent=slips.length;updateRun();}
function updateRun(){$('run').disabled=!(slips.length&&$('company').value&&refRows.some(r=>r.company_id===$('company').value));}
$('run').onclick=async()=>{refRows.forEach(r=>r.matched=false);$('run').disabled=true;$('err').classList.add('hidden');$('prog').classList.remove('hidden');$('fill').style.width='0%';
 const out=new Array(slips.length);let i=0,done=0;const N=slips.length;
 async function w(){const idx=i++;if(idx>=N)return;const s=slips[idx];
  try{const j=await api('match-ocr',{image:s.base64,mime:s.mime});out[idx]=j.ok?{ok:true,data:j.data}:{ok:false,error:j.error};}catch(e){out[idx]={ok:false,error:'ocr fail'};}
  done++;$('fill').style.width=Math.round(done/N*100)+'%';$('ptext').textContent='อ่านสลิป '+done+'/'+N;return w();}
 await Promise.all(Array.from({length:Math.min(5,N)},w));
 matched=slips.map((s,idx)=>{const o=out[idx];if(!o.ok)return{slip:s,ocr:null,m:{status:'miss',reason:o.error||'อ่านไม่ได้'}};return{slip:s,ocr:o.data,m:matchOne(o.data)};});
 render();$('prog').classList.add('hidden');$('run').disabled=false;};
function render(){let ok=0,w=0,m=0;const tb=$('rows');tb.innerHTML='';
 matched.forEach((x,i)=>{const st=x.m.status;if(st==='ok')ok++;else if(st==='warn')w++;else m++;const o=x.ocr||{};
  let mc='—',by='';if(st==='ok'){mc=x.m.row.company+' · '+x.m.row.name+' <small class="mut">('+(LABEL[x.m.row.table]||'')+')</small>';by=x.m.by;}else if(st==='warn'){mc=x.m.cands.map(c=>c.name).join(' / ');}else mc='<small class="mut">'+(x.m.reason||'')+'</small>';
  const badge=st==='ok'?'<span class="badge ok">แมตแล้ว</span>':st==='warn'?'<span class="badge warn">ต้องเช็ก</span>':'<span class="badge miss">ไม่เจอคู่</span>';
  const tr=document.createElement('tr');tr.className=st;
  tr.innerHTML='<td>'+(i+1)+'</td><td><img class="thumb" style="width:40px;height:40px" src="'+x.slip.dataURL+'"></td><td class="amt">'+(o.amount!=null&&!isNaN(o.amount)?fmt(o.amount):'?')+(nCur(o.currency)==='USD'?' <small class="mut">USD</small>':'')+'</td><td>'+(o.recipient_name||'—')+(o.recipient_acct?'<div><small class="mut">…'+l4(o.recipient_acct)+'</small></div>':'')+'</td><td>'+mc+'</td><td><small class="mut">'+by+'</small></td><td>'+badge+'</td>';
  tb.appendChild(tr);});
 $('cOk').textContent=ok;$('cWarn').textContent=w;$('cMiss').textContent=m;$('results').classList.remove('hidden');
 $('commit').disabled=ok===0;$('commit').textContent='ยืนยัน & เขียนกลับ Bitable ('+ok+' รายการ)';}
$('commit').onclick=async()=>{$('commit').disabled=true;$('commit').textContent='กำลังเขียนกลับ…';
 const pairs=matched.filter(x=>x.m.status==='ok').map(x=>({company_id:x.m.row.company_id,record_id:x.m.row.record_id,table:x.m.row.table,image:x.slip.base64,mime:x.slip.mime,filename:x.slip.name}));
 const j=await api('match-commit',{table:$('table').value,pairs});
 if(!j.ok){$('commitOut').innerHTML='<span class="err">'+(j.error||'เขียนไม่สำเร็จ')+'</span>';$('commit').disabled=false;return;}
 const okN=j.results.filter(x=>x.ok).length,fail=j.results.length-okN;
 $('commitOut').innerHTML='<div class="row"><div class="stat ok"><div class="n">'+okN+'</div><div class="l">เขียนกลับสำเร็จ (ติ๊กรายการสำเร็จแล้ว)</div></div>'+(fail?'<div class="stat miss"><div class="n">'+fail+'</div><div class="l">ล้มเหลว</div></div>':'')+'</div>';
 $('commit').textContent='เสร็จแล้ว ✓';};
loadRows();
</script></body></html>`;
}
