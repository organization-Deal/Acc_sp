import {validDate} from './validation.js';
import { COMPANIES, companyOf } from './companies.js';
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
  bill.amount = bill.amountLocked ? bill.amount : amtSrc ? amtSrc.amount : (bill.amount ?? null);
  const slip = members.find(m => (m.role === 'PAYSLIP' || m.role === 'PROOF') && m.amount != null);
  bill.pay_amount = slip ? slip.amount : null;
  bill.mismatch = bill.amount != null && bill.pay_amount != null &&
    Math.abs(bill.amount - bill.pay_amount) > CFG.AMOUNT_TOLERANCE;

  if (!bill.expense_date) bill.expense_date = (anchor && anchor.date) || '';
  if (slip) bill.pay_type = 'เงินโอน';
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

  const candidates = state.bills.filter(b => {
    if ((b.company_id || null) !== (item.company_id || null)) return false;
    const matchAmount = (b.amount != null && Math.abs(b.amount - item.amount) <= CFG.AMOUNT_TOLERANCE) ||
                         (b.pay_amount != null && Math.abs(b.pay_amount - item.amount) <= CFG.AMOUNT_TOLERANCE);
    if (!matchAmount) return false;
    const dup = b.memberIds.some(id => state.itemsById[id] && state.itemsById[id].role === item.role);
    return !dup;
  });

  if (candidates.length > 1) { state.pool.push(item.message_id); return; }
  const existing = candidates[0];
  if (existing) {
    existing.memberIds.push(item.message_id);
    recomputeBill(state, existing);
  } else {
    const bill = { id: genId(), company_id: item.company_id || null, memberIds: [item.message_id], anchorId: item.message_id,
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
  const source = state.bills.find(b=>b.memberIds.includes(msgId));
  if (source?.id === target) return {ok:true};
  const sourceCompany = source?.company_id || state.itemsById[msgId].company_id || null;
  const destination = state.bills.find(b=>b.id===target);
  if(target!=='pool' && target!=='new' && !destination) return {ok:false,error:'ไม่พบบิลปลายทาง'};
  if(destination && sourceCompany && destination.company_id && sourceCompany!==destination.company_id)
    return {ok:false,error:'รูปอยู่คนละบริษัท กรุณาตรวจและเปลี่ยนบริษัทก่อนย้าย'};
  state.itemsById[msgId].company_id = sourceCompany;
  removeFromAll(state, msgId);
  if (target === 'pool') { state.pool.push(msgId); return { ok: true }; }
  if (target === 'new') {
    const bill = { id: genId(), company_id: sourceCompany, memberIds: [msgId], anchorId: msgId,
      amount: null, pay_amount: null, category: '', cat_code: '', ai_detail: '', pay_type: '',
      mismatch: false, warn: '', categoryLocked: false };
    recomputeBill(state, bill);
    state.bills.push(bill);
    return { ok: true, billId: bill.id };
  }
  const bill = state.bills.find(b => b.id === target);
  if (!bill) return { ok: false, error: 'ไม่พบบิลนี้ (อาจถูกลบไปแล้ว)' };
  bill.company_id = bill.company_id || sourceCompany;
  bill.memberIds.push(msgId);
  recomputeBill(state, bill);
  return { ok: true };
}
// ── แก้ยอด/ชื่อ/หมวดของบิล ตรงๆ (จากหน้าเว็บ) ──
export function updateBill(state, billId, patch) {
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return { ok: false, error: 'ไม่พบบิลนี้' };
  if (patch.expense_date !== undefined && !validDate(patch.expense_date)) return {ok:false,error:'วันที่ใช้จ่ายไม่ถูกต้อง'};
  if (patch.pay_type !== undefined && !CFG.PAY_TYPES.includes(patch.pay_type)) return {ok:false,error:'วิธีจ่ายไม่ถูกต้อง'};
  if (patch.category !== undefined && !codeOf(patch.category)) return {ok:false,error:'กรุณาเลือกหมวดจากรายการ'};
  if (patch.expense_date !== undefined) bill.expense_date=patch.expense_date;
  if (patch.pay_type !== undefined) bill.pay_type=patch.pay_type;
  if (patch.purpose_confirmed !== undefined) bill.purpose_confirmed=patch.purpose_confirmed===true;
  if (patch.company_id !== undefined) {
    if(!companyOf(patch.company_id)) return {ok:false,error:'บริษัทไม่ถูกต้อง'};
    bill.company_id=patch.company_id;
    bill.memberIds.forEach(id=>{if(state.itemsById[id])state.itemsById[id].company_id=patch.company_id;});
  }
  if (patch.receipt_requested !== undefined) bill.receipt_requested=patch.receipt_requested===true;
  if (patch.amount !== undefined) { bill.amount = num(patch.amount); bill.amountLocked = true; }
  if (patch.ai_detail !== undefined) {bill.ai_detail = String(patch.ai_detail).trim();bill.purpose_confirmed=false;}
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
    expense_date:b.expense_date||'',purpose_confirmed:b.purpose_confirmed===true, company_id: b.company_id || null, receipt_requested: b.receipt_requested === true,
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
      `**${i + 1}. ${cat}**\n🏢 ${companyOf(b.company_id)?.label || "ยังไม่เลือกบริษัท"}\n${b.ai_detail || '-'}\nยอด **${money(b.amount)}** บ.${pay} · ${b.memberIds.length} รูป` + warn + noRc } });
  });
  el.push({ tag: 'hr' });
  el.push({ tag: 'div', text: { tag: 'lark_md', content: `รวม **${bills.length} รายการ** · **${money(total)}** บ.` } });

  if (state.pool.length) {
    el.push({ tag: 'div', text: { tag: 'lark_md', content:
      `🧩 มี **${state.pool.length} รูป** ยังไม่ได้จัดเข้ารายการไหน (หลักฐาน/รูปที่จับคู่ไม่ได้อัตโนมัติ)` } });
  }

  el.push({ tag: 'action', actions: [
    { tag: 'button', text: { tag: 'plain_text', content: '📝 ตรวจรายละเอียดและเลือกบริษัท' }, type: 'primary', url: url('sort') },
    { tag: 'button', text: { tag: 'plain_text', content: '🗑️ ทิ้งทั้งหมด' }, type: 'danger', url: url('discard') } ] });

  el.push({ tag: 'note', elements: [{ tag: 'lark_md', content:
    'กดตรวจรายละเอียดและเลือกบริษัท ตรวจยอด หมวด และรูปของแต่ละบิล แล้วกดยืนยันบันทึกในหน้านั้น' }] });

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
      `**${i + 1}. ${b.category || '-'}** · ${companyOf(b.company_id)?.label || "ยังไม่เลือกบริษัท"}${ref}\n${b.ai_detail || '-'} · ยอด **${money(b.amount)}** บ.` } });
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
  const icon = title.split(' ')[0] || '✅';
  const accent = icon === '✅' ? '#2F7D4F' : icon === '⚠️' ? '#B7791F' : icon === '🗑️' ? '#6F6A63' : '#8B1E1E';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<meta name="color-scheme" content="light only">'
    + '<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Anuphan:wght@400;500;600;700&display=swap" rel="stylesheet">'
    + '</head>'
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;'
    + 'background:#F5F3EF;font-family:\'Plus Jakarta Sans\',\'Anuphan\',-apple-system,BlinkMacSystemFont,sans-serif;'
    + '-webkit-font-smoothing:antialiased;letter-spacing:-0.01em">'
    + '<div style="text-align:center;padding:32px 26px;max-width:340px;width:100%;background:#FFFFFF;'
    + 'border-radius:24px;box-shadow:0 10px 40px rgba(43,43,43,.10)">'
    + '<div style="width:60px;height:60px;border-radius:50%;background:' + accent + '1f;display:flex;align-items:center;justify-content:center;'
    + 'font-size:28px;margin:0 auto 16px">' + icon + '</div>'
    + '<div style="font-size:21px;font-weight:700;color:#2B2B2B;margin-bottom:10px;letter-spacing:-0.02em">' + title.replace(icon, '').trim() + '</div>'
    + '<div style="font-size:15px;color:#6F6A63;line-height:1.65;white-space:pre-line">' + msg + '</div>'
    + '<div style="font-size:13px;color:#6F6A63;margin-top:22px;padding-top:16px;border-top:.5px solid #E6E1DA">ปิดหน้านี้แล้วกลับไปแชทได้เลย</div>'
    + '</div></body></html>';
}

// ════════════════════════════════════════════════════════════════
// หน้าเว็บ "จัดบิล" — SPA เบาๆ วานิลลา JS, ข้อมูลฝัง SSR ตอนโหลด
// mutations ยิง fetch() กลับมาที่ /?act=assign|update|delete|confirm-web
// ════════════════════════════════════════════════════════════════
export function sortPageHtml(openId, tok, workerUrl, state) {
  const bills = state.bills.map(b => ({
    id: b.id, expense_date:b.expense_date||'',pay_type:b.pay_type||'',purpose_confirmed:b.purpose_confirmed===true, company_id:b.company_id||null, receipt_requested:b.receipt_requested===true, amount: b.amount, category: b.category, ai_detail: b.ai_detail,
    warn: b.warn, memberIds: b.memberIds, no_receipt_reason: b.no_receipt_reason || null,
  }));
  const pool = state.pool;
  const itemsMeta = {};
  Object.keys(state.itemsById).forEach(id => {
    const it = state.itemsById[id];
    itemsMeta[id] = { role: it.role, amount: it.amount, vendor: it.vendor };
  });
  const initData = JSON.stringify({ bills, pool, itemsMeta, openId, tok, workerUrl, companies: COMPANIES, cats: CAT_TABLE.map(c=>c.n) });

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>จัดบิล</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Anuphan:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html { color-scheme:light; background:#FFFFFF; }
  :root{ color-scheme:light;
    --bg:#FFFFFF; --card:#FFFFFF; --ink:#2B2B2B; --sub:#8A857D; --line:#ECE8E1; --fill:#F4F1EC;
    --red:#8B1E1E; --green:#2F7D4F; --amber:#B7791F;
    --num:'Plus Jakarta Sans'; }
  body { margin:0; font-family:'Plus Jakarta Sans','Anuphan',-apple-system,BlinkMacSystemFont,sans-serif;
    background:var(--bg); color:var(--ink); padding-bottom:calc(220px + env(safe-area-inset-bottom)); -webkit-font-smoothing:antialiased;
    letter-spacing:-0.011em; font-feature-settings:'tnum' 1, 'cv01' 1; }
  .num { font-variant-numeric:tabular-nums; font-feature-settings:'tnum' 1; }

  /* HERO — ยอดรวมเป็นพระเอก */
  .hero { padding:34px 24px 26px; text-align:center; }
  .hero .eyebrow { font-size:12px; font-weight:600; color:var(--sub); text-transform:uppercase; letter-spacing:.08em; margin-bottom:12px; }
  .hero .total { font-size:52px; font-weight:800; letter-spacing:-0.035em; line-height:1; color:var(--ink); }
  .hero .total .cur { font-size:24px; font-weight:600; color:var(--sub); vertical-align:6px; margin-right:4px; letter-spacing:-0.02em; }
  .hero .meta { margin-top:14px; font-size:14px; color:var(--sub); display:inline-flex; gap:8px; align-items:center; }
  .hero .dot { width:3px; height:3px; border-radius:50%; background:var(--sub); opacity:.5; }
  .hero .pill-warn { display:inline-block; margin-top:14px; font-size:12.5px; font-weight:600; color:var(--amber);
    background:rgba(183,121,31,.10); padding:5px 12px; border-radius:100px; }

  .group-label { font-size:12px; font-weight:600; color:var(--sub); text-transform:uppercase; letter-spacing:.05em;
    padding:0 28px 10px; display:flex; justify-content:space-between; align-items:center; }
  .group-label .act { color:var(--red); font-weight:600; cursor:pointer; text-transform:none; letter-spacing:0; font-size:13px; }

  .list { background:var(--card); margin:0 16px 26px; border-radius:20px; overflow:hidden; border:.5px solid var(--line); }
  .row { padding:16px 18px; border-top:.5px solid var(--line); }
  .row:first-child { border-top:none; }
  .row-head { display:flex; align-items:center; gap:14px; }
  .row-main { flex:1; min-width:0; }
  .row-cat { font-size:15.5px; font-weight:600; color:var(--ink); }
  .row-cat.empty { color:var(--sub); font-weight:500; }
  .row-desc { font-size:13px; color:var(--sub); margin-top:3px; }
  .row-amt { font-size:17px; font-weight:700; color:var(--ink); white-space:nowrap; }
  .row-flag { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--amber); margin-left:6px; vertical-align:2px; }

  /* รายละเอียดโชว์ตลอด (เห็นทุกอย่างในตาเดียว) */
  .detail { }
  .detail-inner { padding:14px 2px 2px; }
  .field { margin-bottom:12px; }
  .field label { display:block; font-size:12px; font-weight:600; color:var(--sub); margin:0 0 6px 2px; }
  .detail input:not([type="checkbox"]):not([type="file"]), .detail select { border:none; background:var(--fill); border-radius:12px; padding:13px 14px; font-size:16px;
    width:100%; font-family:inherit; color:var(--ink); -webkit-appearance:none; appearance:none; }
  .detail select { background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238A857D' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat:no-repeat; background-position:right 14px center; padding-right:36px; }
  .detail input:focus, .detail select:focus { outline:none; box-shadow:0 0 0 2px rgba(139,30,30,.22); }
  .check-row { display:flex; align-items:flex-start; gap:10px; margin:12px 0 18px; font-size:14px; line-height:1.5; cursor:pointer; }
  .detail .check-row input[type="checkbox"] { appearance:auto; -webkit-appearance:checkbox; width:22px; height:22px; flex:0 0 22px; margin:0; padding:0; accent-color:var(--red); }
  .two .field { min-width:0; }
  .confirm-hint { width:100%; font-size:12px; line-height:1.5; color:var(--sub); margin:0; }
  .btn-confirm:disabled { background:#D5D1CC; color:#625D57; box-shadow:none; cursor:not-allowed; }
  .two { display:flex; gap:10px; }
  .two .field:first-child { flex:0 0 42%; }
  .two .field:last-child { flex:1; }
  .flag-line { font-size:13px; color:var(--amber); margin:2px 2px 12px; }
  .norc-line { font-size:13px; color:var(--sub); margin:2px 2px 12px; }
  .thumbs { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  .thumb { position:relative; width:58px; height:58px; border-radius:12px; overflow:hidden; background:var(--fill); }
  .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .thumb .rm { position:absolute; top:3px; right:3px; background:rgba(43,43,43,.55); color:#fff; font-size:11px;
    width:19px; height:19px; border-radius:50%; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px); }
  .detail-actions { display:flex; gap:8px; }
  .chip { font-size:13px; font-weight:600; padding:9px 15px; border-radius:100px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; }
  .chip-photo { background:rgba(139,30,30,.08); color:var(--red); }
  .chip-del { background:var(--fill); color:var(--sub); }
  .chip:active { transform:scale(.96); }

  .pool-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(104px,1fr)); gap:12px; padding:0 16px; }
  .pool-item { background:var(--card); border-radius:16px; padding:8px; border:.5px solid var(--line); }
  .pool-item img { width:100%; height:82px; object-fit:cover; border-radius:11px; margin-bottom:8px; background:var(--fill); }
  .pool-item select { width:100%; font-size:13px; padding:9px 8px; border:none; background:var(--fill); border-radius:10px;
    -webkit-appearance:none; appearance:none; color:var(--ink); font-family:inherit; }

  footer { position:fixed; bottom:0; left:0; right:0; padding:14px 16px calc(14px + env(safe-area-inset-bottom));
    background:linear-gradient(to top, #FFFFFF 62%, rgba(255,255,255,0)); display:flex; flex-wrap:wrap; gap:10px; z-index:10; }
  footer button { flex:1; padding:16px; font-size:16px; font-weight:700; border:none; border-radius:16px; font-family:inherit; cursor:pointer; letter-spacing:-0.01em; }
  footer button:active { transform:scale(.985); }
  .btn-confirm { flex:1.6; background:var(--red); color:#fff; box-shadow:0 6px 18px rgba(139,30,30,.24); }
  .btn-add { background:#FFFFFF; color:var(--ink); border:.5px solid var(--line); }

  .empty { color:var(--sub); font-size:14px; padding:22px; text-align:center; }
  .toast { position:fixed; top:16px; left:50%; transform:translateX(-50%) translateY(-10px); background:rgba(43,43,43,.95); color:#fff;
    padding:12px 20px; border-radius:100px; font-size:14px; font-weight:500; opacity:0; transition:opacity .25s, transform .25s; z-index:30;
    backdrop-filter:blur(12px); box-shadow:0 10px 30px rgba(43,43,43,.24); max-width:88%; text-align:center; }
  .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
</style></head>
<body>
<div class="hero">
  <div class="eyebrow">ยอดรวมทั้งหมด</div>
  <div class="total num"><span class="cur">฿</span><span id="heroTotal">0</span></div>
  <div class="meta"><span id="heroCount">0 รายการ</span><span class="dot" id="heroDot"></span><span id="heroPool"></span></div>
  <div id="heroWarn"></div>
</div>
<div class="group-label"><span>รายการ</span></div>
<div class="field"><label>ตั้งบริษัทให้ทุกบิลในชุดนี้</label><select id="allCompany" onchange="setAllCompany(this.value)"><option value="">เลือกบริษัท</option>${COMPANIES.map(c=>`<option value="${c.id}">${c.label}</option>`).join('')}</select></div>
<div id="bills" class="list"></div>
<div class="group-label"><span id="poolLabel">รูปที่ยังไม่ได้จัด</span> <label class="act">＋ อัปโหลดรูป<input type="file" accept="image/*" style="display:none" onchange="uploadEvidence(this.files[0],'pool')"></label></div>
<div id="pool" class="pool-grid"></div>
<footer>
  <p id="confirmHint" class="confirm-hint" role="status" aria-live="polite"></p>
  <button class="btn-add" onclick="addBlank()">＋ เปล่า</button>
  <button id="confirmButton" class="btn-confirm" disabled aria-describedby="confirmHint" onclick="doConfirm()">ยืนยันบันทึก</button>
</footer>
<div class="toast" id="toast"></div>
<script>
let D = ${initData};

function imgUrl(id){ return D.workerUrl + '?act=img&u=' + encodeURIComponent(D.openId) + '&k=' + D.tok + '&id=' + encodeURIComponent(id); }
function toast(msg, isError){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.style.background = isError ? 'rgba(183,121,31,.96)' : 'rgba(43,43,43,.94)';
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>t.classList.remove('show'), isError?3500:1600);
}

let apiQueue=Promise.resolve(), pendingRequests=0, submitting=false;
function api(act,body){pendingRequests++;updateConfirmState();const run=async()=>{const res=await fetch(D.workerUrl+'?act='+act+'&u='+encodeURIComponent(D.openId)+'&k='+D.tok,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});return res.json();};const next=apiQueue.then(run).finally(()=>{pendingRequests--;updateConfirmState();});apiQueue=next.catch(()=>{});return next;}
async function refresh(){
  const r = await api('state');
  if (!r.ok) { toast(r.error || 'โหลดไม่สำเร็จ', true); return; }
  D.bills = r.bills; D.pool = r.pool; D.itemsMeta = r.itemsMeta;
  render();
}

function reviewFields(b){return '<div class="field"><label>วันที่ใช้จ่ายจริง</label><input type="date" data-review="expense_date" data-bill="'+b.id+'" value="'+(b.expense_date||'')+'"></div><div class="field"><label>วิธีจ่าย</label><select data-review="pay_type" data-bill="'+b.id+'"><option value="">เลือกวิธีจ่าย</option>'+['เงินสด','เงินโอน','บัตรเครดิต'].map(v=>'<option'+(b.pay_type===v?' selected':'')+'>'+v+'</option>').join('')+'</select></div>';}
function purposeCheck(b){return '<label class="check-row"><input type="checkbox" data-review="purpose_confirmed" data-bill="'+b.id+'" '+(b.purpose_confirmed?'checked':'')+'><span>ตรวจรายละเอียดแล้ว ตรงกับวัตถุประสงค์ที่จ่ายจริง</span></label>';}
document.addEventListener('change',e=>{const t=e.target;if(t.dataset.review)updateField(t.dataset.bill,t.dataset.review,t.type==='checkbox'?t.checked:t.value);});
function billOptionsHtml(excludeId){
  let h = '<option value="pool">-- ไม่ระบุ (พักไว้) --</option><option value="new">➕ สร้างรายการใหม่</option>';
  D.bills.forEach((b,i)=>{ if(b.id===excludeId) return;
    h += '<option value="'+b.id+'">'+(i+1)+'. '+(b.category||'ยังไม่มีหมวด')+' ('+(b.amount||0)+' บ.)</option>'; });
  return h;
}

function fmt(n){ return (n==null?0:Number(n)).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2}); }

function companySelect(b){
 return '<div class="field"><label>บริษัทที่เบิก</label><select data-company-bill="'+b.id+'"><option value="">เลือกบริษัท</option>'+D.companies.map(c=>'<option value="'+c.id+'"'+(c.id===b.company_id?' selected':'')+'>'+c.label+'</option>').join('')+'</select></div><label class="check-row"><input type="checkbox" data-receipt-bill="'+b.id+'"'+(b.receipt_requested?' checked':'')+'><span>ขอใบแทนใบเสร็จ</span></label>';
}
async function setAllCompany(value){if(!value)return;const r=await api('company-all',{company_id:value});if(!r.ok)toast(r.error,true);await refresh();}
document.addEventListener('change',e=>{if(e.target.dataset.receiptBill)updateField(e.target.dataset.receiptBill,'receipt_requested',e.target.checked);if(e.target.dataset.companyBill)updateField(e.target.dataset.companyBill,'company_id',e.target.value);});
function missingDetails(){
 if(!D.bills.length)return 'เพิ่มรายการก่อนบันทึก';
 for(let i=0;i<D.bills.length;i++){const b=D.bills[i],m=[];
 if(!D.companies.some(c=>c.id===b.company_id))m.push('บริษัท');
 if(!String(b.ai_detail||'').trim())m.push('ชื่อรายการ');
 if(!Number.isFinite(Number(b.amount))||Number(b.amount)<=0)m.push('ยอดมากกว่า 0');
 if(!D.cats.includes(b.category))m.push('หมวด');
 const date=new Date((b.expense_date||'')+'T00:00:00Z');
 if(!b.expense_date||isNaN(date)||date.toISOString().slice(0,10)!==b.expense_date)m.push('วันที่ใช้จ่าย');
 if(!['เงินสด','เงินโอน','บัตรเครดิต'].includes(b.pay_type))m.push('วิธีจ่าย');
 if(b.purpose_confirmed!==true)m.push('ติ๊กยืนยันรายละเอียด');
 if(m.length)return 'บิล '+(i+1)+': ยังขาด '+m.join(', ');
 }return '';
}
function updateConfirmState(){
 const button=document.getElementById('confirmButton'),hint=document.getElementById('confirmHint');if(!button||!hint)return;
 const missing=missingDetails();button.disabled=!!missing||pendingRequests>0||submitting;
 hint.textContent=submitting?'กำลังส่งรายการ…':pendingRequests?'กำลังบันทึกการแก้ไข…':missing||'ตรวจครบแล้ว พร้อมยืนยันบันทึก';
}
function render(){
  updateConfirmState();
  const total = D.bills.reduce((a,b)=>a+(b.amount||0),0);
  const nWarn = D.bills.filter(b=>b.warn).length;
  document.getElementById('heroTotal').textContent = fmt(total);
  document.getElementById('heroCount').textContent = D.bills.length + ' รายการ';
  document.getElementById('heroPool').textContent = D.pool.length ? D.pool.length + ' รูปรอจัด' : 'จัดครบแล้ว';
  document.getElementById('heroDot').style.display = '';
  document.getElementById('heroWarn').innerHTML = nWarn ? '<div class="pill-warn">⚠️ '+nWarn+' รายการต้องตรวจ</div>' : '';
  document.getElementById('poolLabel').textContent = 'รูปที่ยังไม่ได้จัด' + (D.pool.length?' ('+D.pool.length+')':'');

  const billsEl = document.getElementById('bills');
  if (!D.bills.length) { billsEl.innerHTML = '<div class="empty">ยังไม่มีรายการ — โยนบิลเข้ามาได้เลย</div>'; }
  else {
    billsEl.innerHTML = '';
    D.bills.forEach((b,i)=>{
      const div = document.createElement('div');
      div.className = 'row';
      const cat = b.category ? '<div class="row-cat">'+b.category+'</div>' : '<div class="row-cat empty">ยังไม่ระบุหมวด</div>';
      const desc = (b.ai_detail||'') + (b.memberIds.length?' · '+b.memberIds.length+' รูป':'');
      div.innerHTML =
        '<div class="row-head">'+
          '<div class="row-main">'+cat+'<div>🏢 '+(D.companies.find(c=>c.id===b.company_id)?.label||'ยังไม่เลือกบริษัท')+'</div>'+
            (b.warn?'<span class="row-flag"></span>':'')+
            '<div class="row-desc">'+ (desc||'—') +'</div>'+
          '</div>'+
          '<div class="row-amt num">฿'+fmt(b.amount)+'</div>'+
        '</div>'+
        '<div class="detail"><div class="detail-inner">'+companySelect(b)+reviewFields(b)+
          '<div class="field"><label>ชื่อรายการ</label>'+
            '<input type="text" value="'+(b.ai_detail||'').replace(/"/g,'&quot;')+'" placeholder="เช่น ค่ากาแฟรับรองลูกค้า" '+
            'onchange="updateField(\\''+b.id+'\\',\\'ai_detail\\',this.value)"></div>'+
          '<div class="two">'+
            '<div class="field"><label>ยอด (บาท)</label>'+
              '<input type="number" inputmode="decimal" value="'+(b.amount!=null?b.amount:'')+'" placeholder="0.00" '+
              'onchange="updateField(\\''+b.id+'\\',\\'amount\\',this.value)"></div>'+
            '<div class="field"><label>หมวด</label>'+
              '<select onchange="updateField(\\''+b.id+'\\',\\'category\\',this.value)">'+
                '<option value="">เลือกหมวด</option>'+
                D.cats.map(c=>'<option value="'+c+'"'+(c===b.category?' selected':'')+'>'+c+'</option>').join('')+
              '</select></div>'+
          '</div>'+
          purposeCheck(b)+
          (b.warn?'<div class="flag-line">⚠️ '+b.warn+'</div>':'')+
          (b.no_receipt_reason?'<div class="norc-line">📝 ไม่มีใบเสร็จ: '+b.no_receipt_reason.replace(/</g,'&lt;')+'</div>':'')+
          '<div class="thumbs">'+ b.memberIds.map(id=>thumbHtml(id,b.id)).join('') +'</div>'+
          '<div class="detail-actions">'+
            '<label class="chip chip-photo">📎 เพิ่มรูป<input type="file" accept="image/*" style="display:none" onchange="uploadEvidence(this.files[0],\\''+b.id+'\\')"></label>'+
            '<span class="chip chip-del" onclick="delBill(\\''+b.id+'\\')">🗑️ ลบ</span>'+
          '</div>'+
        '</div></div>';
      billsEl.appendChild(div);
    });
  }

  const poolEl = document.getElementById('pool');
  poolEl.innerHTML = D.pool.length ? '' : '<div class="empty">ไม่มีรูปค้าง 🎉</div>';
  D.pool.forEach(id=>{
    const div = document.createElement('div'); div.className='pool-item';
    div.innerHTML = '<img src="'+imgUrl(id)+'" loading="lazy" onerror="this.style.opacity=.3">'+
      '<select onchange="assign(\\''+id+'\\', this.value)">' +
      '<option value="">จัดเข้า…</option>' + billOptionsNoPool() + '</select>';
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

function resizeImage(file, maxDim, quality){
  maxDim = maxDim || 1600; quality = quality || 0.82;
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = function(e){
      img.onload = function(){
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(function(blob){ blob ? resolve(blob) : reject(new Error('resize failed')); }, 'image/jpeg', quality);
      };
      img.onerror = function(){ reject(new Error('image load failed')); };
      img.src = e.target.result;
    };
    reader.onerror = function(){ reject(new Error('read failed')); };
    reader.readAsDataURL(file);
  });
}

async function uploadEvidence(file, target){
  if (!file) return;
  toast('กำลังย่อรูป...');
  let blob;
  try { blob = await resizeImage(file); } catch(e) { blob = file; }   // ย่อไม่ได้ก็ส่งไฟล์เดิม ไม่ให้ค้าง
  toast('กำลังอัปโหลด... (' + Math.round(blob.size/1024) + ' KB)');
  let res;
  try {
    res = await fetch(D.workerUrl + '?act=upload&u=' + encodeURIComponent(D.openId) + '&k=' + D.tok + '&target=' + encodeURIComponent(target),
      { method:'POST', body: blob });
  } catch(e) { toast('เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง', true); return; }
  if (!res.ok) { toast('อัปโหลดไม่สำเร็จ (HTTP ' + res.status + ')', true); return; }
  let r;
  try { r = await res.json(); } catch(e) { toast('เซิร์ฟเวอร์ตอบกลับผิดปกติ', true); return; }
  if (!r.ok) { toast(r.error || 'อัปโหลดไม่สำเร็จ', true); return; }
  await refresh();
  toast('เพิ่มรูปแล้ว 📎');
}
async function assign(msgId, target){
  const r = await api('assign', { msgId, target });
  if (!r.ok) { toast(r.error||'ทำไม่สำเร็จ', true); return; }
  await refresh(); toast('จัดแล้ว');
}
async function updateField(billId, field, value){
  const patch = {}; patch[field] = value;
  const r = await api('update', { billId, patch });
  if (!r.ok) { toast(r.error||'บันทึกไม่สำเร็จ', true); return; }
  await refresh();
}
async function delBill(billId){
  if (!confirm('ลบรายการนี้? รูปจะย้ายกลับไปกองพัก')) return;
  const r = await api('delete', { billId });
  if (!r.ok) { toast(r.error||'ลบไม่สำเร็จ', true); return; }
  await refresh(); toast('ลบแล้ว');
}
async function addBlank(){
  const r = await api('newblank', {});
  if (!r.ok) { toast(r.error||'สร้างไม่สำเร็จ', true); return; }
  await refresh();
}
async function doConfirm(){
  await apiQueue;
  if(submitting)return;
  const missing=missingDetails();if(missing){toast(missing,true);return;}
  if (!confirm('ยืนยันบันทึก '+D.bills.length+' รายการเข้าระบบ?')) return;
  submitting=true;updateConfirmState();
  let r;try{r=await api('confirm-web', {});}catch(e){submitting=false;updateConfirmState();toast('เชื่อมต่อไม่สำเร็จ ตรวจสถานะในแชทก่อนลองใหม่',true);return;}
  if (!r.ok) { submitting=false;updateConfirmState();toast(r.error||'บันทึกไม่สำเร็จ', true); return; }
  document.body.innerHTML = '<div style="padding:70px 24px;text-align:center;font-family:inherit;background:#F5F3EF;min-height:100vh">'+
    '<div style="width:64px;height:64px;border-radius:50%;background:#2F7D4F1a;display:flex;align-items:center;justify-content:center;'+
    'font-size:30px;margin:0 auto 16px">✅</div>'+
    '<div style="font-size:20px;font-weight:700;color:#2B2B2B;margin-top:8px">กำลังบันทึก '+r.count+' รายการ</div>'+
    '<div style="color:#6F6A63;margin-top:8px;font-size:14px">กลับไปแชทได้เลย</div></div>';
}
render();
</script></body></html>`;
}
