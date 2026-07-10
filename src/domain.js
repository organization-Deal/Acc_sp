// ════════════════════════════════════════════════════════════════
// domain.js — logic ล้วน ไม่มี I/O
// v2: รองรับโยนรูปทีเดียวหลายสิบใบ — จับคู่สะสม (ไม่รีเซ็ตทุกครั้ง) +
//     รูปที่จับคู่ไม่ได้เก็บไว้ใน "pool" ให้จัดเองผ่านหน้าเว็บ
// ════════════════════════════════════════════════════════════════
import { CFG, CAT_TABLE, COMMON_CATS } from './config.js';

// ── util ──
export function num(x) {
  const n = parseFloat(String(x).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}
export function money(x) {
  return x == null ? '-' : Number(x).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function extract(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(x => (x && x.text) || x).join('');
  if (v.text) return v.text;
  if (v.value) return extract(v.value);
  return '';
}
function genId() { return Math.random().toString(36).slice(2, 8); }

// ── classifier ──
export function classify(text) {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return null;
  let best = null, score = 0;
  CAT_TABLE.forEach(row => {
    let s = 0;
    row.k.split(',').forEach(kw => { kw = kw.trim().toLowerCase(); if (kw && t.indexOf(kw) >= 0) s++; });
    if (t.indexOf(row.n.toLowerCase()) >= 0) s += 2;
    if (s > score) { score = s; best = row; }
  });
  return score > 0 ? { name: best.n, code: best.c } : null;
}
export function codeOf(name) { const r = CAT_TABLE.find(x => x.n === name); return r ? r.c : ''; }
export function guessCategory(vendor) {
  const v = (vendor || '').toLowerCase();
  if (/ปตท|pt|bangchak|shell|esso|caltex|น้ำมัน|ปั๊ม/.test(v)) return 'ค่าน้ำมัน';
  if (/grab|taxi|bts|mrt|วิน|แท็กซี่|เดินทาง/.test(v))          return 'ค่าเดินทาง (บริหาร)';
  if (/โรงแรม|hotel|resort|ที่พัก/.test(v))                     return 'ค่าที่พัก';
  if (/ร้านอาหาร|cafe|coffee|กาแฟ|อาหาร|ภัตตาคาร/.test(v))      return 'ค่าอาหาร (บริหาร)';
  return '';
}

// ════════════════════════════════════════════════════════════════
// STATE MODEL
//   state.itemsById = { message_id: rawOcrItem }
//   state.bills     = [{ id, memberIds:[msgId,...], anchorId, amount, pay_amount,
//                         category, cat_code, ai_detail, pay_type, mismatch, warn }]
//   state.pool      = [msgId, ...]   ← รูปที่ยังไม่ได้จัดเข้าบิลไหน
// ════════════════════════════════════════════════════════════════
export function newState() { return { itemsById: {}, bills: [], pool: [] }; }

function recomputeBill(state, bill) {
  const members = bill.memberIds.map(id => state.itemsById[id]).filter(Boolean);
  const receipts = members.filter(m => m.role === 'RECEIPT');
  const anchor = receipts.find(m => m.tax_id) || receipts[0] || members.find(m => m.amount != null) || members[0];
  bill.anchorId = anchor ? anchor.message_id : (bill.anchorId || null);

  const amtSrc = receipts.find(m => m.amount != null) || members.find(m => m.amount != null);
  bill.amount = amtSrc ? amtSrc.amount : (bill.amount ?? null);
  const slip = members.find(m => (m.role === 'PAYSLIP' || m.role === 'PROOF') && m.amount != null);
  bill.pay_amount = slip ? slip.amount : null;
  bill.mismatch = bill.amount != null && bill.pay_amount != null &&
    Math.abs(bill.amount - bill.pay_amount) > CFG.AMOUNT_TOLERANCE;

  if (!bill.ai_detail) bill.ai_detail = (anchor && anchor.ai_detail) || '';
  if (!bill.pay_type) bill.pay_type = (anchor && anchor.pay_type) || '';

  if (!bill.categoryLocked) {
    let hit = classify([anchor && anchor.vendor, bill.ai_detail, anchor && anchor.invoice_no].join(' '));
    if (!hit) { const g = guessCategory(anchor && anchor.vendor); if (g) hit = { name: g, code: codeOf(g) }; }
    if (hit) { bill.category = hit.name; bill.cat_code = hit.code; }
  }

  bill.warn = !members.length ? ''
    : bill.amount == null ? 'ยังไม่มียอด — กรอกเองในหน้าจัดบิล'
    : (!slip && receipts.length ? 'ยังไม่พบสลิป/หลักฐานโอนของบิลนี้'
    : (bill.mismatch ? 'ยอดใบเสร็จ ≠ ยอดจ่าย — เช็กก่อนยืนยัน' : ''));
}

// ── รูป 1 ใบเข้ามา → จับเข้าบิลเดิม (ยอดตรง) / สร้างบิลใหม่ / เข้า pool ──
export function mergeItem(state, item) {
  state.itemsById[item.message_id] = item;
  const isBillish = item.amount != null && (item.role === 'RECEIPT' || item.role === 'PAYSLIP' || item.role === 'PROOF');
  if (!isBillish) { state.pool.push(item.message_id); return; }

  const existing = state.bills.find(b => {
    const matchAmount = (b.amount != null && Math.abs(b.amount - item.amount) <= CFG.AMOUNT_TOLERANCE) ||
                         (b.pay_amount != null && Math.abs(b.pay_amount - item.amount) <= CFG.AMOUNT_TOLERANCE);
    if (!matchAmount) return false;
    const dup = b.memberIds.some(id => state.itemsById[id] && state.itemsById[id].role === item.role);
    return !dup;
  });

  if (existing) {
    existing.memberIds.push(item.message_id);
    recomputeBill(state, existing);
  } else {
    const bill = { id: genId(), memberIds: [item.message_id], anchorId: item.message_id,
      amount: null, pay_amount: null, category: '', cat_code: '', ai_detail: '', pay_type: '',
      mismatch: false, warn: '', categoryLocked: false };
    recomputeBill(state, bill);
    state.bills.push(bill);
  }
}

// ── ย้ายรูป msgId ไปที่ไหนก็ได้: 'pool' | 'new' | billId ──
export function removeFromAll(state, msgId) {
  state.pool = state.pool.filter(id => id !== msgId);
  for (const b of state.bills) b.memberIds = b.memberIds.filter(id => id !== msgId);
  state.bills = state.bills.filter(b => b.memberIds.length > 0);
}
export function assignItem(state, msgId, target) {
  if (!state.itemsById[msgId]) return { ok: false, error: 'ไม่พบรูปนี้ (อาจถูกจัดไปแล้ว)' };
  removeFromAll(state, msgId);
  if (target === 'pool') { state.pool.push(msgId); return { ok: true }; }
  if (target === 'new') {
    const bill = { id: genId(), memberIds: [msgId], anchorId: msgId,
      amount: null, pay_amount: null, category: '', cat_code: '', ai_detail: '', pay_type: '',
      mismatch: false, warn: '', categoryLocked: false };
    recomputeBill(state, bill);
    state.bills.push(bill);
    return { ok: true, billId: bill.id };
  }
  const bill = state.bills.find(b => b.id === target);
  if (!bill) return { ok: false, error: 'ไม่พบบิลนี้ (อาจถูกลบไปแล้ว)' };
  bill.memberIds.push(msgId);
  recomputeBill(state, bill);
  return { ok: true };
}
// ── แก้ยอด/ชื่อ/หมวดของบิล ตรงๆ (จากหน้าเว็บ) ──
export function updateBill(state, billId, patch) {
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return { ok: false, error: 'ไม่พบบิลนี้' };
  if (patch.amount !== undefined) bill.amount = num(patch.amount);
  if (patch.ai_detail !== undefined) bill.ai_detail = String(patch.ai_detail).trim();
  if (patch.category !== undefined && patch.category) {
    bill.category = patch.category; bill.cat_code = codeOf(patch.category); bill.categoryLocked = true;
  }
  recomputeBill(state, bill);
  return { ok: true };
}
export function deleteBill(state, billId) {
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return { ok: false, error: 'ไม่พบบิลนี้' };
  state.pool.push(...bill.memberIds);
  state.bills = state.bills.filter(b => b.id !== billId);
  return { ok: true };
}

// ── พิมพ์ "ค่ากาแฟ 65 บาท" → แยกยอด+ชื่อรายการ (ต้องลงท้ายด้วย "บาท" กันชนกับข้อความคุยทั่วไป) ──
export function parseExpenseText(t) {
  const m = t.trim().match(/^(?:ค่า)?\s*(.+?)\s+([\d,]+(?:\.\d{1,2})?)\s*บาท\.?$/);
  if (!m) return null;
  const desc = m[1].trim();
  const amount = num(m[2]);
  if (!desc || amount == null) return null;
  return { ai_detail: 'ค่า' + desc, amount };
}

// ── แนบรูป/ไอเทมเข้ากับบิลที่ระบุ id ตรงๆ (ใช้ตอนรูปมาตอบคำถาม "มีใบเสร็จไหม") ──
export function attachItemToBill(state, billId, item) {
  state.itemsById[item.message_id] = item;
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return { ok: false, error: 'ไม่พบรายการที่รออยู่ (อาจถูกลบไปแล้ว)' };
  bill.memberIds.push(item.message_id);
  recomputeBill(state, bill);
  return { ok: true };
}

// ── แปลงเป็นรูปแบบเดิมที่ saveBills() ใน lark.js ใช้ (มี .anchor / .members เต็ม) ──
export function materializeBills(state) {
  return state.bills.map(b => ({
    anchor: state.itemsById[b.anchorId] || {},
    members: b.memberIds.map(id => state.itemsById[id]).filter(Boolean),
    amount: b.amount, pay_amount: b.pay_amount, category: b.category, cat_code: b.cat_code,
    ai_detail: b.ai_detail, pay_type: b.pay_type, mismatch: b.mismatch, warn: b.warn,
    no_receipt_reason: b.no_receipt_reason || null,
  }));
}

// ── ลิงก์ปุ่ม ──
export function actUrl(workerUrl, act, openId, tok, extra) {
  let u = workerUrl + '?act=' + act + '&u=' + encodeURIComponent(openId) + '&k=' + tok;
  if (extra) Object.keys(extra).forEach(k => { u += '&' + k + '=' + encodeURIComponent(extra[k]); });
  return u;
}

// ── การ์ดสรุปในแชท (มุมมอง live ระหว่างจัดบิล) ──
export function buildCard(openId, state, opts) {
  const url = (act) => actUrl(opts.workerUrl, act, openId, opts.tok);
  const bills = state.bills;
  const el = []; let total = 0;

  if (!bills.length) {
    el.push({ tag: 'div', text: { tag: 'lark_md', content: 'กำลังอ่านรูป... รอสักครู่' } });
    return { config: { wide_screen_mode: true },
      header: { template: 'grey', title: { tag: 'plain_text', content: '📋 กำลังจัดบิล' } }, elements: el };
  }

  bills.forEach((b, i) => {
    total += (b.amount || 0);
    const cat = b.category || '— (ยังไม่ระบุหมวด)';
    const warn = b.warn ? `\n⚠️ ${b.warn}` : '';
    const noRc = b.no_receipt_reason ? `\n📝 ไม่มีใบเสร็จ: ${b.no_receipt_reason}` : '';
    const pay = b.pay_type ? ` · จ่าย:${b.pay_type}` : '';
    el.push({ tag: 'div', text: { tag: 'lark_md', content:
      `**${i + 1}. ${cat}**\n${b.ai_detail || '-'}\nยอด **${money(b.amount)}** บ.${pay} · ${b.memberIds.length} รูป` + warn + noRc } });
  });
  el.push({ tag: 'hr' });
  el.push({ tag: 'div', text: { tag: 'lark_md', content: `รวม **${bills.length} รายการ** · **${money(total)}** บ.` } });

  if (state.pool.length) {
    el.push({ tag: 'div', text: { tag: 'lark_md', content:
      `🧩 มี **${state.pool.length} รูป** ยังไม่ได้จัดเข้ารายการไหน (หลักฐาน/รูปที่จับคู่ไม่ได้อัตโนมัติ)` } });
  }

  el.push({ tag: 'action', actions: [
    { tag: 'button', text: { tag: 'plain_text', content: bills.length > 1 ? '✅ ยืนยันทั้งหมด' : '✅ ยืนยัน' }, type: 'primary', url: url('confirm') },
    { tag: 'button', text: { tag: 'plain_text', content: '🧩 จัดบิล/แก้ไข' }, url: url('sort') },
    { tag: 'button', text: { tag: 'plain_text', content: '🗑️ ทิ้งทั้งหมด' }, type: 'danger', url: url('discard') } ] });

  el.push({ tag: 'note', elements: [{ tag: 'lark_md', content:
    'บิลไหนยอดผิดพิมพ์ `บิล 1 ยอด 350` แก้เร็วๆ ได้ · หรือกด 🧩 จัดบิล/แก้ไข ดูรูปทั้งหมดแบบละเอียด' }] });

  return { config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `📋 ตรวจก่อนยืนยัน (${bills.length} รายการ)` } },
    elements: el };
}

export function buildResultCard(mode, materialized, refs) {
  const el = []; let total = 0;
  materialized.forEach((b, i) => {
    total += (b.amount || 0);
    const ref = (refs && refs[i]) ? `  ·  ${refs[i]}` : '';
    el.push({ tag: 'div', text: { tag: 'lark_md', content:
      `**${i + 1}. ${b.category || '-'}**${ref}\n${b.ai_detail || '-'} · ยอด **${money(b.amount)}** บ.` } });
  });
  el.push({ tag: 'hr' });
  if (mode === 'saving') {
    el.push({ tag: 'div', text: { tag: 'lark_md', content: `⏳ **กำลังบันทึก ${materialized.length} รายการ...**` } });
    return { config: { wide_screen_mode: true },
      header: { template: 'turquoise', title: { tag: 'plain_text', content: '⏳ กำลังบันทึก' } }, elements: el };
  }
  el.push({ tag: 'div', text: { tag: 'lark_md', content: `✅ **บันทึกครบ ${materialized.length} รายการ — รวม ${money(total)} บ.**` } });
  return { config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '✅ บันทึกแล้ว' } }, elements: el };
}

// ── หน้าเว็บผลลัพธ์ (ปุ่ม discard / ยกเลิก) ──
export function htmlPage(title, msg) {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#fff;font-family:-apple-system,Roboto,Sarabun,sans-serif">'
    + '<div style="text-align:center;padding:32px 24px;max-width:340px">'
    + '<div style="font-size:48px;line-height:1;margin-bottom:12px">' + (title.split(' ')[0] || '✅') + '</div>'
    + '<div style="font-size:22px;font-weight:700;color:#1f2329;margin-bottom:10px">' + title + '</div>'
    + '<div style="font-size:15px;color:#646a73;line-height:1.6;white-space:pre-line">' + msg + '</div>'
    + '<div style="font-size:13px;color:#8f959e;margin-top:20px">ปิดหน้านี้แล้วกลับไปแชทได้เลย</div>'
    + '</div></body></html>';
}

// ════════════════════════════════════════════════════════════════
// หน้าเว็บ "จัดบิล" — SPA เบาๆ วานิลลา JS, ข้อมูลฝัง SSR ตอนโหลด
// mutations ยิง fetch() กลับมาที่ /?act=assign|update|delete|confirm-web
// ════════════════════════════════════════════════════════════════
export function sortPageHtml(openId, tok, workerUrl, state) {
  const bills = state.bills.map(b => ({
    id: b.id, amount: b.amount, category: b.category, ai_detail: b.ai_detail,
    warn: b.warn, memberIds: b.memberIds,
  }));
  const pool = state.pool;
  const itemsMeta = {};
  Object.keys(state.itemsById).forEach(id => {
    const it = state.itemsById[id];
    itemsMeta[id] = { role: it.role, amount: it.amount, vendor: it.vendor };
  });
  const initData = JSON.stringify({ bills, pool, itemsMeta, openId, tok, workerUrl, cats: COMMON_CATS });

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>จัดบิล</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,Roboto,Sarabun,sans-serif; background:#f5f6f7; color:#1f2329; padding-bottom:90px; }
  header { position:sticky; top:0; background:#fff; padding:14px 16px; border-bottom:1px solid #e5e6eb; z-index:5; }
  header h1 { font-size:17px; margin:0 0 2px; }
  header p { font-size:12px; color:#8f959e; margin:0; }
  .section { padding:14px 16px 4px; }
  .section h2 { font-size:13px; color:#646a73; margin:0 0 8px; font-weight:600; }
  .bill { background:#fff; border:1px solid #e5e6eb; border-radius:12px; padding:12px; margin-bottom:10px; }
  .bill .row1 { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
  .bill .idx { width:22px; height:22px; border-radius:50%; background:#3370ff; color:#fff; font-size:12px;
    display:flex; align-items:center; justify-content:center; flex:none; }
  .bill select, .bill input { border:1px solid #d0d3d6; border-radius:8px; padding:8px 10px; font-size:14px; width:100%; }
  .bill .amt-row { display:flex; gap:8px; margin-bottom:8px; }
  .bill .amt-row input { width:120px; }
  .bill .warn { font-size:12px; color:#b7791f; margin-bottom:8px; }
  .thumbs { display:flex; gap:6px; flex-wrap:wrap; }
  .thumb { position:relative; width:56px; height:56px; border-radius:8px; overflow:hidden; border:1px solid #e5e6eb; }
  .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .thumb .rm { position:absolute; top:0; right:0; background:rgba(0,0,0,.55); color:#fff; font-size:11px;
    width:18px; height:18px; display:flex; align-items:center; justify-content:center; }
  .del-bill { font-size:12px; color:#c0342b; margin-top:6px; display:inline-block; }
  .pool-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(90px,1fr)); gap:10px; }
  .pool-item { background:#fff; border:1px solid #e5e6eb; border-radius:10px; padding:6px; text-align:center; }
  .pool-item img { width:100%; height:70px; object-fit:cover; border-radius:6px; margin-bottom:6px; }
  .pool-item select { font-size:12px; padding:4px; }
  footer { position:fixed; bottom:0; left:0; right:0; background:#fff; border-top:1px solid #e5e6eb;
    padding:12px 16px; display:flex; gap:10px; }
  footer button { flex:1; padding:14px; font-size:15px; font-weight:700; border:none; border-radius:12px; }
  .btn-confirm { background:#3370ff; color:#fff; }
  .btn-add { background:#f0f1f3; color:#1f2329; }
  .empty { color:#8f959e; font-size:13px; padding:8px 0; }
  .toast { position:fixed; top:10px; left:50%; transform:translateX(-50%); background:#1f2329; color:#fff;
    padding:8px 16px; border-radius:20px; font-size:13px; opacity:0; transition:opacity .2s; z-index:20; }
</style></head>
<body>
<header><h1>🧩 จัดบิล</h1><p id="summary"></p></header>
<div class="section"><h2>รายการที่จัดแล้ว</h2><div id="bills"></div></div>
<div class="section"><h2>รูปที่ยังไม่ได้จัดเข้าไหน</h2><div id="pool" class="pool-grid"></div></div>
<footer>
  <button class="btn-add" onclick="addBlank()">➕ สร้างรายการเปล่า</button>
  <button class="btn-confirm" onclick="doConfirm()">✅ ยืนยันบันทึกทั้งหมด</button>
</footer>
<div class="toast" id="toast"></div>
<script>
let D = ${initData};

function imgUrl(id){ return D.workerUrl + '?act=img&u=' + encodeURIComponent(D.openId) + '&k=' + D.tok + '&id=' + encodeURIComponent(id); }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.style.opacity=1; setTimeout(()=>t.style.opacity=0,1600); }

async function api(act, body){
  const res = await fetch(D.workerUrl + '?act=' + act + '&u=' + encodeURIComponent(D.openId) + '&k=' + D.tok,
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  return res.json();
}
async function refresh(){
  const r = await api('state');
  if (!r.ok) { toast(r.error || 'โหลดไม่สำเร็จ'); return; }
  D.bills = r.bills; D.pool = r.pool; D.itemsMeta = r.itemsMeta;
  render();
}

function billOptionsHtml(excludeId){
  let h = '<option value="pool">-- ไม่ระบุ (พักไว้) --</option><option value="new">➕ สร้างรายการใหม่</option>';
  D.bills.forEach((b,i)=>{ if(b.id===excludeId) return;
    h += '<option value="'+b.id+'">'+(i+1)+'. '+(b.category||'ยังไม่มีหมวด')+' ('+(b.amount||0)+' บ.)</option>'; });
  return h;
}

function render(){
  document.getElementById('summary').textContent = D.bills.length + ' รายการ · ' + D.pool.length + ' รูปรอจัด';

  const billsEl = document.getElementById('bills');
  billsEl.innerHTML = D.bills.length ? '' : '<div class="empty">ยังไม่มีรายการ</div>';
  D.bills.forEach((b,i)=>{
    const div = document.createElement('div'); div.className='bill';
    div.innerHTML =
      '<div class="row1"><div class="idx">'+(i+1)+'</div>'+
      '<input type="text" placeholder="ชื่อรายการ" value="'+(b.ai_detail||'').replace(/"/g,'&quot;')+'" '+
      'onchange="updateField(\\''+b.id+'\\',\\'ai_detail\\',this.value)"></div>'+
      '<div class="amt-row">'+
      '<input type="number" inputmode="decimal" placeholder="ยอด" value="'+(b.amount!=null?b.amount:'')+'" '+
      'onchange="updateField(\\''+b.id+'\\',\\'amount\\',this.value)">'+
      '<select onchange="updateField(\\''+b.id+'\\',\\'category\\',this.value)">'+
        '<option value="">-- เลือกหมวด --</option>'+
        D.cats.map(c=>'<option value="'+c+'"'+(c===b.category?' selected':'')+'>'+c+'</option>').join('')+
      '</select></div>'+
      (b.warn?'<div class="warn">⚠️ '+b.warn+'</div>':'')+
      '<div class="thumbs">'+ b.memberIds.map(id=>thumbHtml(id, b.id)).join('') +'</div>'+
      '<div class="del-bill" onclick="delBill(\\''+b.id+'\\')">🗑️ ลบรายการนี้ (รูปกลับไปกองพัก)</div>';
    billsEl.appendChild(div);
  });

  const poolEl = document.getElementById('pool');
  poolEl.innerHTML = D.pool.length ? '' : '<div class="empty">ไม่มีรูปค้าง 🎉</div>';
  D.pool.forEach(id=>{
    const div = document.createElement('div'); div.className='pool-item';
    div.innerHTML = '<img src="'+imgUrl(id)+'" loading="lazy">'+
      '<select onchange="assign(\\''+id+'\\', this.value)">' +
      '<option value="">จัดเข้า...</option>' + billOptionsNoPool() + '</select>';
    poolEl.appendChild(div);
  });
}
function billOptionsNoPool(){
  let h = '<option value="new">➕ รายการใหม่</option>';
  D.bills.forEach((b,i)=>{ h += '<option value="'+b.id+'">'+(i+1)+'. '+(b.category||'ยังไม่มีหมวด')+' ('+(b.amount||0)+' บ.)</option>'; });
  return h;
}
function thumbHtml(id, billId){
  return '<div class="thumb"><img src="'+imgUrl(id)+'" loading="lazy" onerror="this.parentElement.style.display=\\'none\\'">'+
    '<div class="rm" onclick="assign(\\''+id+'\\',\\'pool\\')">✕</div></div>';
}

async function assign(msgId, target){
  const r = await api('assign', { msgId, target });
  if (!r.ok) { toast(r.error||'ทำไม่สำเร็จ'); return; }
  await refresh(); toast('จัดแล้ว');
}
async function updateField(billId, field, value){
  const patch = {}; patch[field] = value;
  const r = await api('update', { billId, patch });
  if (!r.ok) { toast(r.error||'บันทึกไม่สำเร็จ'); return; }
  await refresh();
}
async function delBill(billId){
  if (!confirm('ลบรายการนี้? รูปจะย้ายกลับไปกองพัก')) return;
  const r = await api('delete', { billId });
  if (!r.ok) { toast(r.error||'ลบไม่สำเร็จ'); return; }
  await refresh(); toast('ลบแล้ว');
}
async function addBlank(){
  const r = await api('newblank', {});
  if (!r.ok) { toast(r.error||'สร้างไม่สำเร็จ'); return; }
  await refresh();
}
async function doConfirm(){
  if (D.bills.length===0) { toast('ยังไม่มีรายการให้บันทึก'); return; }
  if (!confirm('ยืนยันบันทึก '+D.bills.length+' รายการเข้าระบบ?')) return;
  const r = await api('confirm-web', {});
  if (!r.ok) { toast(r.error||'บันทึกไม่สำเร็จ'); return; }
  document.body.innerHTML = '<div style="padding:60px 24px;text-align:center;font-family:-apple-system,sans-serif">'+
    '<div style="font-size:48px">✅</div><div style="font-size:20px;font-weight:700;margin-top:8px">บันทึกแล้ว '+r.count+' รายการ</div>'+
    '<div style="color:#8f959e;margin-top:8px">กลับไปแชทได้เลย</div></div>';
}
render();
</script></body></html>`;
}
