import {financeTick,financeCallback,verifiedCallback} from './finance.js';
import {validateBills} from './validation.js';
import { companyOf, companyError } from './companies.js';
// ════════════════════════════════════════════════════════════════
// index.js — Worker entry + SessionDO
//
//  v2: รองรับโยนรูปทีเดียวหลายสิบใบ
//  • processImage เข้าคิวเรียงกันเองใน DO (กันชนกัน) แล้ว "จับคู่สะสม"
//    ไม่รีเซ็ตทุกครั้ง — รูปที่จับคู่ไม่ได้เก็บใน pool ให้จัดเองทีหลัง
//  • Debounce ด้วย ctx.storage.setAlarm — รอรูปหยุดไหลก่อนอัปเดตการ์ด
//    (โยน 50 รูปพร้อมกัน การ์ดจะอัปเดตครั้งเดียวตอนรูปหยุดมา ไม่กระพริบรัว)
//  • หน้าเว็บ "จัดบิล" (act=sort) ให้ดูรูปทุกใบ ลากเข้าเรื่อง/แก้ยอด-หมวด-ชื่อ
//    ได้ยืดหยุ่นเต็มที่ ไม่ต้องกลับมาแชท
// ════════════════════════════════════════════════════════════════
import { DurableObject } from 'cloudflare:workers';
import { CFG } from './config.js';
import {
  claudeOCR, downloadImage, downloadMediaByToken, reply, sendInteractive, patchMessage, patchSimple,
  saveBills, findEmployee, weeklySummary, uploadBytesToBitable, listAllOpenIds, broadcastMessage,
} from './lark.js';
import {
  newState, mergeItem, assignItem, updateBill, deleteBill, materializeBills,
  buildCard, buildResultCard, htmlPage, sortPageHtml, num, money,
  parseExpenseText, attachItemToBill,
} from './domain.js';
// ── ฟีเจอร์ "แมตยอด" (แยกไฟล์ ไม่ชน flow เดิม) ──
import {
  matchCard, matchPageHTML, matchApi, signMatchToken, verifyMatchToken,
} from './match.js';

const RX_NO_RECEIPT_BARE = /^(ไม่มี|ไม่|no|none)$/i;
const RX_CANCEL_DRAFT    = /^(ยกเลิก|cancel|ทิ้ง)$/i;

// เฉพาะ open_id นี้เท่านั้นที่สั่ง broadcast ได้ (กันพนักงานคนอื่นสแปมทีม)
const ADMIN_OPENID = 'ou_d1265794fc40ed011b129297f1c3b5cf';

const RX_CONFIRM = /^(ยืนยัน|ยืนยน|บันทึก|save|confirm|y|yes|ok|โอเค|ใช่|ตกลง|1|👍|✅|✔️|🆗)$/i;
const RX_DISCARD = /^(ทิ้ง|ยกเลิก|cancel|no|ไม่|x|❌|🗑️|0)$/i;
const RX_EDIT    = /^(แก้|แก้ไข|edit|e|✏️|2)$/i;
const DEBOUNCE_MS = 1800;   // รอรูปหยุดไหลกี่ ms ก่อนอัปเดตการ์ด

const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
const html = (s) => new Response(s, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const doStub = (env, openId) => env.SESSION.get(env.SESSION.idFromName(openId));

// ════════════════════════════════════════════════════════════════
export default {
  async scheduled(event,env,ctx) {
    if(env.FINANCE_ENABLED === 'true') ctx.waitUntil(doStub(env,'finance-coordinator-v1').financePoll());
  },
  async fetch(request, env, ctx) {
    if (request.method === 'GET')  return handleGet(request, env, ctx);
    if (request.method === 'POST') return handlePost(request, env, ctx);
    return json({ ok: true, bot: 'ReceiptBot', version: 'CF_WORKER_v2' });
  },
};

// ── GET: ปุ่มในการ์ด (open_url) + หน้าเว็บจัดบิล + proxy รูป ──
async function handleGet(request, env, ctx) {
  const url = new URL(request.url);
  const p = Object.fromEntries(url.searchParams);
  const act = p.act || '';
  if (!act) return json({ ok: true, bot: 'ReceiptBot', version: 'CF_WORKER_v2', note: 'ส่งบิลในแชท Lark' });

  // ── หน้าเว็บ "แมตยอด" (gate ด้วย token, ไม่ผูกกับ session บิล) ──
  if (act === 'matchpage') {
    const v = await verifyMatchToken(env, p.k || '');
    if (!v) return html(htmlPage('⚠️ ลิงก์หมดอายุ', 'พิมพ์ "แมตยอด" ในแชทใหม่'));
    return html(matchPageHTML(p.k || ''));
  }

  const openId = p.u || '';
  if (!openId) return html(htmlPage('⚠️ ลิงก์ใช้ไม่ได้', 'ลิงก์ไม่ถูกต้อง'));

  if (act === 'img') {
    const check = await doStub(env, openId).checkTokAndGetImage(openId, p.k || '', p.id || '');
    if (!check.ok) return new Response('not found', { status: 404 });
    try {
      const buf = check.fileToken
        ? await downloadMediaByToken(env, check.fileToken)
        : await downloadImage(env, p.id, check.imageKey);
      return new Response(buf, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } });
    } catch (e) { return new Response('download failed', { status: 502 }); }
  }

  if (act === 'sort') {
    const out = await doStub(env, openId).renderSortPage(openId, p.k || '', env.WORKER_URL);
    return html(out);
  }

  const out = await doStub(env, openId).handleButton(act, openId, p.k || '');
  if (out.needsFlush) ctx.waitUntil(doStub(env, openId).flush());
  return html(out.page);
}

// ── POST: Lark webhook (event/card) + หน้าเว็บจัดบิล (assign/update/delete/confirm-web) ──
async function handlePost(request, env, ctx) {
  const url = new URL(request.url);
  const act = url.searchParams.get('act');

  // อัปโหลดรูปหลักฐานจากหน้าเว็บ (body = raw bytes ของรูป ไม่ใช่ JSON)
  if (act === 'upload') {
    const openId = url.searchParams.get('u') || '';
    const k = url.searchParams.get('k') || '';
    const target = url.searchParams.get('target') || 'pool';
    const buf = await request.arrayBuffer();
    const res = await doStub(env, openId).uploadEvidence(openId, k, target, buf);
    return json(res);
  }

  // ── API ฟีเจอร์ "แมตยอด" (token อยู่ใน body ไม่ใช่ u/k) ──
  if (act === 'match-rows' || act === 'match-ocr' || act === 'match-commit') {
    return matchApi(act, request, env);
  }

  // mutations จากหน้าเว็บจัดบิล
  if (act) {
    const openId = url.searchParams.get('u') || '';
    const k = url.searchParams.get('k') || '';
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const res = await doStub(env, openId).webAction(act, openId, k, body);
    if (res._flush) ctx.waitUntil(doStub(env, openId).flush());
    return json(res);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: true }); }
  if (body.event?.action?.value?.finance === true) {
    if (env.FINANCE_ENABLED !== 'true' || !verifiedCallback(env,body)) return new Response('Unauthorized',{status:403});
    ctx.waitUntil(doStub(env,'finance-coordinator-v1').financeDecide(body));
    return json({toast:{type:'info',content:'กำลังตรวจและบันทึกผล โปรดรอข้อความผลจากผู้ช่วยบัญชี'}});
  }
  if (body.type === 'url_verification') return json({ challenge: body.challenge });

  if (body.action || (body.event && body.event.action)) {
    const cardAct = body.action || body.event.action || {};
    const value = cardAct.value || {};
    const openId = value.open_id;
    if (!openId) return json({ ok: true });
    const res = await doStub(env, openId).cardAction(openId, value);
    if (res.flush) ctx.waitUntil(doStub(env, openId).flush());
    return json(res.toast || { ok: true });
  }

  const h = body.header || {};
  if (h.event_type === 'im.message.receive_v1') {
    const evtId = h.event_id;
    if (evtId) {
      if (await env.KV.get('evt_' + evtId)) return json({ ok: true });
      await env.KV.put('evt_' + evtId, '1', { expirationTtl: 600 });
    }
    ctx.waitUntil(handleMessage(body.event, env));
  }
  return json({ ok: true });
}

// ── OCR (ขนานกันได้ทุกรูป) → ส่งผลเข้า DO (เรียงคิวเอง + debounce) ──
async function handleMessage(event, env) {
  const msg = event.message;
  const openId = (event.sender && event.sender.sender_id && event.sender.sender_id.open_id) || '';
  if (!openId || !msg) return;

  if (msg.message_type === 'text') {
    const t = (JSON.parse(msg.content).text || '').trim();

    // ── คำสั่ง broadcast (เฉพาะแอดมิน) — "broadcast <ข้อความ>" หรือ "ประกาศ <ข้อความ>" ──
    const bc = t.match(/^(?:broadcast|ประกาศ)\s+([\s\S]+)/i);
    if (bc) {
      if (openId !== ADMIN_OPENID) { await reply(env, openId, '⛔ คำสั่งนี้ใช้ได้เฉพาะแอดมิน'); return; }
      const body = bc[1].trim();
      const ids = await listAllOpenIds(env);
      const targets = ids.filter(id => id !== openId);   // ไม่ส่งหาตัวเอง
      await reply(env, openId, `📤 กำลังส่งประกาศหา ${targets.length} คน...`);
      const res = await broadcastMessage(env, targets, body);
      await reply(env, openId, `✅ ส่งเสร็จ: สำเร็จ ${res.ok} · ล้มเหลว ${res.fail} (จากทั้งหมด ${res.total} คน)`);
      return;
    }

    // ── ฟีเจอร์ "แมตยอด" (เฉพาะฝ่ายบัญชีใน whitelist) ──
    if (/^myid$/i.test(t)) { await reply(env, openId, 'open_id: ' + openId); return; }
    if (/แมตยอด/.test(t)) {
      const wl = (env.ACCOUNTING_OPENIDS || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!wl.includes(openId)) {
        await reply(env, openId, '⛔ คำสั่ง "แมตยอด" ใช้ได้เฉพาะฝ่ายบัญชี\nพิมพ์ "id" เอา open_id ให้แอดมินเพิ่มสิทธิ์');
        return;
      }
      const token = await signMatchToken(env, openId);
      const link = (env.WORKER_URL || '') + '/?act=matchpage&k=' + encodeURIComponent(token);
      await sendInteractive(env, openId, matchCard(link));
      return;
    }

    await doStub(env, openId).handleText(t, openId);
    return;
  }
  if (msg.message_type !== 'image') return;

  const content = JSON.parse(msg.content);
  let ocr;
  try {
    const bytes = await downloadImage(env, msg.message_id, content.image_key);
    ocr = await claudeOCR(env, bytes);
  } catch (err) {
    await reply(env, openId, '⚠️ อ่านรูปนี้ไม่ได้ (' + (content.image_key || '?').slice(0, 8) + '...): ' + err.message);
    return;
  }
  await doStub(env, openId).processImage(openId, msg.message_id, content.image_key, ocr);
}

// ════════════════════════════════════════════════════════════════
// SessionDO
// storage 'session' = { openId, state:{itemsById,bills,pool}, cardmsg, tok, tosave }
// ════════════════════════════════════════════════════════════════
export class SessionDO extends DurableObject {
  async financePoll() {
    const run=(this.financeSerial||Promise.resolve()).then(()=>financeTick(this));
    this.financeSerial=run.catch(()=>{});return run;
  }
  async financeDecide(body) {
    const run=(this.financeSerial||Promise.resolve()).then(()=>financeCallback(this,body));
    this.financeSerial=run.catch(()=>{});return run;
  }

  async #load()  {
    const s = (await this.ctx.storage.get('session')) || {};
    if (!s.state) s.state = newState();
    return s;
  }
  async #save(s) { await this.ctx.storage.put('session', s); }
  #tok(s)  { if (!s.tok) s.tok = crypto.randomUUID().replace(/-/g, '').substring(0, 12); return s.tok; }
  #opts(s) { return { tok: this.#tok(s), workerUrl: this.env.WORKER_URL }; }
  #checkTok(s, k) { return !!s.tok && s.tok === k; }

  // ── รูปเข้ามาทีละใบ (เรียงคิวเองเพราะเป็น DO เดียว) → จับคู่สะสม + debounce card ──
  async processImage(openId, messageId, imageKey, ocr) {
    const s = await this.#load();
    s.openId = openId;
    const item = { message_id: messageId, image_key: imageKey,
      role: ocr.role, vendor: ocr.vendor, date: ocr.date, amount: ocr.amount,
      tax_id: ocr.tax_id, invoice_no: ocr.invoice_no,
      pay_type: ocr.pay_type, ai_detail: ocr.ai_detail, confidence: ocr.confidence };

    if (s.pendingText && s.pendingText.awaiting) {
      // มีรายการที่พิมพ์ค้างรออยู่ (ถามว่ามีใบเสร็จไหม) — รูปนี้คือคำตอบ แนบเข้ารายการนั้นตรงๆ
      attachItemToBill(s.state, s.pendingText.billId, item);
      s.pendingText = null;
      await this.#save(s);
      await reply(this.env, openId, '📎 แนบรูปเข้ารายการที่พิมพ์ไว้แล้ว');
    } else {
      mergeItem(s.state, item);
      this.#opts(s); // ensure tok exists
      await this.#save(s);
    }
    // debounce: setAlarm ซ้ำจะเลื่อนเวลาให้เอง (native) — รูปมาถี่ๆ การ์ดจะอัปเดตครั้งเดียวตอนหยุดไหล
    await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
  }

  async alarm() {
    const s = await this.#load();
    if (!s.openId || !s.state.bills.length) return;
    const opts = this.#opts(s);
    const card = buildCard(s.openId, s.state, opts);
    if (s.cardmsg) {
      await patchMessage(this.env, s.cardmsg, card);
    } else {
      const mId = await sendInteractive(this.env, s.openId, card);
      if (mId) { s.cardmsg = mId; await this.#save(s); }
    }
  }

  // ── ข้อความในแชท ──
  async handleText(t, openId) {
    const s = await this.#load();
    s.openId = openId;

    const companyCommand=t.match(/^(?:บิล\s*(\d+)\s+)?บริษัท\s+(PSH|PWA|ODP|PROSERVICE|PROSPER|OMNI)$/i);
    if(companyCommand){
      const aliases={PROSERVICE:'PSH',PROSPER:'PWA',OMNI:'ODP'};
      const raw=companyCommand[2].toUpperCase(),id=aliases[raw]||raw;
      const targets=companyCommand[1]?[s.state.bills[Number(companyCommand[1])-1]].filter(Boolean):s.state.bills;
      if(!targets.length){await reply(this.env,openId,'ไม่พบบิล กรุณาส่งบิลก่อน');return;}
      targets.forEach(b=>updateBill(s.state,b.id,{company_id:id}));await this.#save(s);
      if(s.cardmsg)await patchMessage(this.env,s.cardmsg,buildCard(openId,s.state,this.#opts(s)));
      await reply(this.env,openId,'ตั้งบริษัท '+companyOf(id).label+' ให้ '+targets.length+' บิลแล้ว');return;
    }
    if (t === 'id') { await reply(this.env, openId, 'open_id: ' + openId); return; }

    // ── ตอบคำถาม "มีใบเสร็จไหม" ของรายการที่พิมพ์ไว้ก่อนหน้า ──
    if (s.pendingText && s.pendingText.awaiting) {
      const reExpense = parseExpenseText(t);
      if (reExpense) { await this.#createPendingText(s, openId, reExpense); return; }
      if (RX_CANCEL_DRAFT.test(t)) {
        const bills = s.state.bills;
        const idx = bills.findIndex(b => b.id === s.pendingText.billId);
        if (idx >= 0) deleteBill(s.state, bills[idx].id);
        s.pendingText = null;
        await this.#save(s);
        await reply(this.env, openId, 'ยกเลิกรายการที่พิมพ์ไว้แล้ว');
        return;
      }
      if (RX_NO_RECEIPT_BARE.test(t)) {
        await reply(this.env, openId, '📝 ขอเหตุผลด้วยนะ เช่น "ซื้อจากแผงลอยไม่มีบิล" หรือ "จ่ายเงินสดร้านไม่ออกใบเสร็จ"');
        return;
      }
      // ข้อความอื่นๆ ถือเป็นเหตุผลที่ไม่มีใบเสร็จ
      const bill = s.state.bills.find(b => b.id === s.pendingText.billId);
      if (bill) { bill.no_receipt_reason = t.trim(); bill.warn = ''; }
      s.pendingText = null;
      const opts = this.#opts(s);
      await this.#save(s);
      if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, s.state, opts));
      else { const mId = await sendInteractive(this.env, openId, buildCard(openId, s.state, opts)); if (mId) { s.cardmsg = mId; await this.#save(s); } }
      await reply(this.env, openId, `📝 บันทึกเหตุผลแล้ว: "${t.trim()}"\nกดตรวจรายละเอียดและเลือกบริษัทบนการ์ดเพื่อยืนยัน หรือถ่ายบิลเพิ่มได้เลย`);
      return;
    }

    // ── พิมพ์ยอดตรงๆ ไม่มีรูป เช่น "ค่ากาแฟ 65 บาท" → สร้างรายการรอ + ถามหาบิล ──
    const parsed = parseExpenseText(t);
    if (parsed) { await this.#createPendingText(s, openId, parsed); return; }

    if (s.state.bills.length || s.state.pool.length) {
      const bills = s.state.bills;
      if (RX_CONFIRM.test(t)) { const opts=this.#opts(s); await this.#save(s); await reply(this.env, openId, 'กรุณาตรวจรายละเอียดและเลือกบริษัทก่อน แล้วกดยืนยันบันทึกในหน้านี้: '+opts.workerUrl+'?act=sort&u='+encodeURIComponent(openId)+'&k='+encodeURIComponent(opts.tok)); return; }
      if (RX_DISCARD.test(t)) {
        if (s.cardmsg) await patchSimple(this.env, s.cardmsg, 'grey', '🗑️ ทิ้งบิลแล้ว');
        await this.ctx.storage.delete('session');
        await reply(this.env, openId, 'ทิ้งบิลแล้ว — ถ่ายใหม่ส่งได้เลย');
        return;
      }
      if (RX_EDIT.test(t)) {
        const opts = this.#opts(s);
        const link = opts.workerUrl + '?act=sort&u=' + encodeURIComponent(openId) + '&k=' + opts.tok;
        const msg = bills.length > 1
          ? `✏️ มี ${bills.length} บิล ต้องระบุเลขบิล:\n` +
            '• `บิล 2 ยอด 520` — แก้ยอดบิลที่ 2\n' +
            '• `บิล 2 ค่า กาแฟลูกค้า` — แก้ชื่อบิลที่ 2\n' +
            '• `ทิ้งบิล 3` — ทิ้งแค่บิลที่ 3\n\n' +
            `หรือดู/แก้แบบละเอียดทุกรูปที่: ${link}\n\nเสร็จแล้วพิมพ์ \`y\` ยืนยันทั้งหมด`
          : '✏️ พิมพ์แก้ได้เลย:\n• `ค่า กาแฟลูกค้า` — แก้ชื่อรายการ\n• `ยอด 520` — แก้จำนวนเงิน\n\nเสร็จแล้วพิมพ์ `y` ยืนยัน';
        await reply(this.env, openId, msg);
        return;
      }
      if (await this.#discardOneBill(s, t, openId)) return;
      if (await this.#applyTextEdit(s, t, openId)) return;
    }

    if (/^(รายการ|ยอดสะสม|ค้างเบิก)$/.test(t)) { await weeklySummary(this.env, openId); return; }
    await reply(this.env, openId, '📸 ถ่ายบิลส่งเป็นชุดได้เลย (กี่ใบก็ได้) การ์ดจะเด้งให้ตรวจหลังรูปหยุดไหล\nพิมพ์ "รายการ" = ดูยอดที่เบิกแล้วอาทิตย์นี้');
  }

  // ── พิมพ์ "ค่ากาแฟ 65 บาท" → สร้างบิลร่างจากข้อความ (amount+ชื่อ+หมวดเดา) แล้วถามหาบิล ──
  async #createPendingText(s, openId, parsed) {
    // ถ้ามีรายการพิมพ์ค้างไม่ตอบอยู่ก่อน แล้วพิมพ์ยอดใหม่มา = เปลี่ยนใจ ลบตัวเก่าทิ้ง
    if (s.pendingText && s.pendingText.awaiting) {
      const old = s.state.bills.find(b => b.id === s.pendingText.billId);
      if (old) deleteBill(s.state, old.id);
    }
    const virtualId = 'txt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    s.state.itemsById[virtualId] = { message_id: virtualId, image_key: null, role: 'MANUAL',
      amount: parsed.amount, vendor: null, tax_id: null, invoice_no: null,
      ai_detail: parsed.ai_detail, pay_type: null, confidence: null };
    const r = assignItem(s.state, virtualId, 'new');
    const bill = s.state.bills.find(b => b.id === r.billId);
    bill.warn = '⏳ รอตอบ: มีใบเสร็จไหม?';
    s.pendingText = { billId: r.billId, awaiting: true };
    const opts = this.#opts(s);
    await this.#save(s);
    if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, s.state, opts));
    else { const mId = await sendInteractive(this.env, openId, buildCard(openId, s.state, opts)); if (mId) { s.cardmsg = mId; await this.#save(s); } }
    await reply(this.env, openId,
      `บันทึกไว้ก่อน: ${parsed.ai_detail} ${money(parsed.amount)} บาท${bill.category ? ' (' + bill.category + ')' : ''}\n` +
      '📸 มีใบเสร็จ/สลิปไหม? ถ่ายส่งมาได้เลย\n' +
      'ถ้าไม่มี พิมพ์เหตุผลสั้นๆ เช่น "ซื้อจากแผงลอยไม่มีบิล" (พิมพ์ "ยกเลิก" ถ้าไม่เอารายการนี้)');
  }

  async #applyTextEdit(s, text, openId) {
    const bills = s.state.bills;
    if (!bills.length) return false;
    let idx = 0; let rest = text;
    const billRef = text.match(/^บิล\s*(\d+)\s+(.+)/);
    if (billRef) {
      idx = parseInt(billRef[1], 10) - 1; rest = billRef[2];
      if (idx < 0 || idx >= bills.length) {
        await reply(this.env, openId, `⚠️ ไม่มีบิลที่ ${billRef[1]} (มีทั้งหมด ${bills.length} บิล)`);
        return true;
      }
    } else if (bills.length > 1) {
      if (/^(ยอด\s*[\d,\.]+|(?:ชื่อ|รายการ|รายละเอียด|ค่า)\s*.+)$/.test(text)) {
        await reply(this.env, openId, `⚠️ มี ${bills.length} บิล ต้องระบุเลขบิลด้วย เช่น \`บิล 1 ${text}\``);
        return true;
      }
      return false;
    }
    const b = bills[idx]; let done = ''; let m;
    if ((m = rest.match(/^ยอด\s*([\d,\.]+)/)))                       { b.amount = num(m[1]); done += 'ยอด '; }
    if ((m = rest.match(/^(?:ชื่อ|รายการ|รายละเอียด|ค่า)\s*(.+)/))) { b.ai_detail = m[1].trim(); done += 'ชื่อรายการ '; }
    if (!done) return false;
    const opts = this.#opts(s);
    await this.#save(s);
    if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, s.state, opts));
    const tag = bills.length > 1 ? `บิล ${idx + 1} ` : '';
    await reply(this.env, openId, `✏️ แก้ ${tag}${done.trim()} แล้ว — พิมพ์ \`y\` เพื่อยืนยันทั้งหมด`);
    return true;
  }

  async #discardOneBill(s, text, openId) {
    const m = text.match(/^ทิ้งบิล\s*(\d+)/);
    if (!m) return false;
    const bills = s.state.bills;
    const idx = parseInt(m[1], 10) - 1;
    if (idx < 0 || idx >= bills.length) {
      await reply(this.env, openId, `⚠️ ไม่มีบิลที่ ${m[1]} (มีทั้งหมด ${bills.length} บิล)`);
      return true;
    }
    deleteBill(s.state, bills[idx].id);
    const opts = this.#opts(s);
    await this.#save(s);
    if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, s.state, opts));
    await reply(this.env, openId, `🗑️ ทิ้งบิล ${m[1]} แล้ว (รูปย้ายไปกองพัก) เหลือ ${s.state.bills.length} บิล — พิมพ์ \`y\` ยืนยันที่เหลือ`);
    return true;
  }

  // ── เตรียมบันทึก (เร็ว: materialize + เปลี่ยนการ์ดเป็น saving) — ไม่รอ upload/เขียน record จริง ──
  // ผู้เรียกต้องสั่ง flush() ต่อเอง (ผ่าน ctx.waitUntil ถ้าเรียกจาก HTTP boundary กันรอนาน)
  async #prepareConfirm(s) {
    const bills = s.state.bills;
    if (!bills.length) return { ok: false, error: 'ยังไม่มีรายการให้บันทึก' };
    if(s.saving||s.tosave)return {ok:false,error:"รายการนี้กำลังบันทึกหรือรอตรวจผล กรุณาอย่ากดย้ำ"};
    const error=validateBills(materializeBills(s.state));
    if(error)return {ok:false,error};
    const materialized = materializeBills(s.state);
    s.tosave = materialized;
    s.saving=true;
    await this.#save(s);
    if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildResultCard('saving', materialized));
    return { ok: true, count: materialized.length };
  }

  async flush() {
    const s = await this.#load();
    const materialized = s.tosave || [];
    if (!materialized.length) return;
    const openId = s.openId;
    s.tosave = null;
    await this.#save(s);

    const emp = await findEmployee(this.env, openId);
    if (!emp) {
      s.saving=false;await this.#save(s);
      await reply(this.env, openId, '⚠️ ยังไม่ได้ลงทะเบียนพนักงาน\nพิมพ์ "id" เอา open_id ไปใส่คอลัมน์ "Lark open_id" ในตารางพนักงานก่อน แล้วส่งบิลใหม่');
      return;
    }
    let refs;
    try {refs = await saveBills(this.env, emp, materialized, async saved => {
      s.savedRecords = [...(s.savedRecords || []), saved];
      await this.#save(s);
    });}
    catch(err){s.saveError=String(err.message||err);s.failedBills=materialized;await this.#save(s);
      if(s.cardmsg) {try {await patchMessage(this.env,s.cardmsg,buildResultCard('error',materialized,(s.savedRecords||[]).map(r=>r.ref)));}catch(notifyError){console.log('Failed to update error card');}}
      await reply(this.env,openId,'⚠️ บันทึกไม่ครบหรือยังยืนยันผลไม่ได้ กรุณาให้บัญชีตรวจรายการใน Lark ก่อนส่งใหม่ เพื่อไม่ให้ซ้ำ: '+s.saveError);return;}
    if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildResultCard('done', materialized, refs));
    await this.ctx.storage.delete('session');
    await reply(this.env, openId, `✅ บันทึกแล้ว ${materialized.length} รายการ:\n` +
      materialized.map((b, i) => `${refs[i]} · ${b.category || '-'} · ${money(b.amount)} บ.`).join('\n') +
      '\n\nพิมพ์ "รายการ" ดูยอดสะสมอาทิตย์นี้');
  }

  // ── ปุ่ม open_url (GET): confirm / discard — คืน {page, needsFlush} เสมอ ──
  async handleButton(act, openId, k) {
    const s = await this.#load();
    s.openId = openId;
    if (!this.#checkTok(s, k)) return { page: htmlPage('⚠️ ลิงก์ใช้ไม่ได้', 'บิลนี้จัดการไปแล้ว หรือลิงก์หมดอายุ\nถ่ายบิลใหม่ส่งในแชทได้เลย') };

    if (act === 'confirm') {
      return { page: sortPageHtml(openId, k, this.env.WORKER_URL, s.state) };
    }
    if (act === 'discard') {
      if (s.cardmsg) await patchSimple(this.env, s.cardmsg, 'grey', '🗑️ ทิ้งบิลแล้ว');
      await this.ctx.storage.delete('session');
      await reply(this.env, openId, '🗑️ ทิ้งบิลแล้ว — ถ่ายใหม่ส่งได้เลย');
      return { page: htmlPage('🗑️ ทิ้งแล้ว', 'ถ่ายบิลใหม่ส่งในแชทได้เลย') };
    }
    return { page: htmlPage('⚠️', 'ไม่มี handler') };
  }


  // ── รูป proxy: เช็ก tok แล้วคืน image_key/file_token ให้ top-level fetch ไปโหลดจริง ──
  async checkTokAndGetImage(openId, k, msgId) {
    const s = await this.#load();
    if (!this.#checkTok(s, k)) return { ok: false };
    const item = s.state.itemsById[msgId];
    if (!item) return { ok: false };
    if (item.file_token) return { ok: true, fileToken: item.file_token };
    return { ok: true, imageKey: item.image_key };
  }

  // ── อัปโหลดรูปหลักฐานจากหน้าเว็บตรงๆ (ไม่ผ่านแชท Lark) → เข้า Bitable ทันที + แนบเข้าบิล/pool ──
  async uploadEvidence(openId, k, target, buf) {
    const s = await this.#load();
    s.openId = openId;
    if (!this.#checkTok(s, k)) return { ok: false, error: 'ลิงก์หมดอายุ' };
    let fileToken;
    try { fileToken = await uploadBytesToBitable(this.env, buf, 'evidence_' + Date.now() + '.jpg'); }
    catch (e) { return { ok: false, error: 'อัปโหลดรูปไม่สำเร็จ: ' + e.message }; }

    const id = 'web_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const item = { message_id: id, image_key: null, file_token: fileToken, role: 'OTHER',
      amount: null, vendor: null, tax_id: null, invoice_no: null, ai_detail: '', pay_type: null, confidence: null };
    s.state.itemsById[id] = item;

    if (target === 'pool') {
      s.state.pool.push(id);
    } else {
      const r = attachItemToBill(s.state, target, item);
      if (!r.ok) s.state.pool.push(id);   // หาบิลไม่เจอ (ถูกลบไปแล้ว) → พักไว้ก่อน
    }
    const opts = this.#opts(s);
    await this.#save(s);
    if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, s.state, opts));
    return { ok: true, id };
  }

  // ── หน้าเว็บจัดบิล ──
  async renderSortPage(openId, k, workerUrl) {
    const s = await this.#load();
    s.openId = openId;
    const opts = this.#opts(s);
    if (k !== opts.tok) { await this.#save(s); return htmlPage('⚠️ ลิงก์ใช้ไม่ได้', 'ลิงก์หมดอายุ กลับไปกดปุ่มใหม่ในแชท'); }
    await this.#save(s);
    return sortPageHtml(openId, opts.tok, workerUrl, s.state);
  }

  // ── mutations จากหน้าเว็บจัดบิล ──
  async webAction(act, openId, k, body) {
    const s = await this.#load();
    s.openId = openId;
    if (!this.#checkTok(s, k)) return { ok: false, error: 'ลิงก์หมดอายุ' };

    if (act === 'state') {
      const itemsMeta = {};
      Object.keys(s.state.itemsById).forEach(id => {
        const it = s.state.itemsById[id];
        itemsMeta[id] = { role: it.role, amount: it.amount, vendor: it.vendor };
      });
      return { ok: true,
        bills: s.state.bills.map(b => ({ id: b.id, expense_date:b.expense_date||'',pay_type:b.pay_type||'',purpose_confirmed:b.purpose_confirmed===true, company_id:b.company_id||null, receipt_requested:b.receipt_requested===true, amount: b.amount, category: b.category, ai_detail: b.ai_detail, warn: b.warn, memberIds: b.memberIds, no_receipt_reason: b.no_receipt_reason || null })),
        pool: s.state.pool, itemsMeta };
    }
    if(s.saving)return {ok:false,error:'กำลังบันทึกหรือรอตรวจผล ห้ามแก้รายการระหว่างนี้'};
    if (act === 'assign') {
      const r = assignItem(s.state, body.msgId, body.target);
      if (r.ok) await this.#save(s);
      if (r.ok && s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, s.state, this.#opts(s)));
      return r;
    }
    if(act==='company-all'){
      if(!companyOf(body.company_id))return {ok:false,error:'บริษัทไม่ถูกต้อง'};
      s.state.bills.forEach(b=>updateBill(s.state,b.id,{company_id:body.company_id}));
      await this.#save(s);
      if(s.cardmsg)await patchMessage(this.env,s.cardmsg,buildCard(openId,s.state,this.#opts(s)));
      return {ok:true};
    }
    if (act === 'update') {
      const r = updateBill(s.state, body.billId, body.patch || {});
      if (r.ok) await this.#save(s);
      if (r.ok && s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, s.state, this.#opts(s)));
      return r;
    }
    if (act === 'delete') {
      const r = deleteBill(s.state, body.billId);
      if (r.ok) await this.#save(s);
      if (r.ok && s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, s.state, this.#opts(s)));
      return r;
    }
    if (act === 'newblank') {
      const id = 'blank_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      s.state.itemsById[id] = { message_id: id, image_key: null, role: 'RECEIPT', amount: null, vendor: null, tax_id: null, ai_detail: '', pay_type: null };
      const r = assignItem(s.state, id, 'new');
      await this.#save(s);
      return r;
    }
    if (act === 'confirm-web') {
      const r = await this.#prepareConfirm(s);
      return r.ok ? { ok: true, count: r.count, _flush: true } : r;
    }
    return { ok: false, error: 'ไม่รู้จักคำสั่งนี้' };
  }

  // ── card action callback (path สำรอง — ปุ่มหลักใช้ open_url) ──
  async cardAction(openId, value) {
    const s = await this.#load();
    s.openId = openId;
    if (value.action === 'discard') {
      if (s.cardmsg) await patchSimple(this.env, s.cardmsg, 'grey', '🗑️ ทิ้งบิลแล้ว');
      await this.ctx.storage.delete('session');
      return { toast: { toast: { type: 'success', content: 'ทิ้งบิลแล้ว' } } };
    }
    if (value.action === 'confirm') {
      return { toast: { toast: { type: 'info', content: 'กรุณาเปิดตรวจรายละเอียดและเลือกบริษัท แล้วกดยืนยันบันทึกในหน้าเว็บ' } } };
    }
    return { toast: { ok: true } };
  }
}
