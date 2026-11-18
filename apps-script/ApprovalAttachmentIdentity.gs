// Compare persisted bill content, not Lark download permission revisions.
// Keep every other field and attachment order. A URL remains significant when
// an attachment has no stable file_token, so URL-only evidence fails closed.
function mcApprovalComparableItems_(items) {
  if (!Array.isArray(items)) throw new Error('ไม่พบข้อมูลรายการสำหรับตรวจสอบ');
  var copy = JSON.parse(JSON.stringify(items));
  copy.forEach(function(item) {
    if (!item || !Array.isArray(item.attachments)) return;
    item.attachments.forEach(function(attachment) {
      if (attachment && typeof attachment.file_token === 'string' && attachment.file_token.trim()) {
        delete attachment.url;
      }
    });
  });
  return copy;
}

function mcAssertApprovalItems_(saved, current) {
  var a = mcApprovalComparableItems_(saved), b = mcApprovalComparableItems_(current);
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  var labels = {amount:'จำนวนเงิน', detail:'รายละเอียด', date:'วันที่ใช้จ่าย',
    doc_no:'เลขคำขอ', record_id:'รายการต้นทาง', category:'หมวดค่าใช้จ่าย',
    pay_type:'วิธีจ่าย', needsReceipt:'ทำใบแทนใบเสร็จ',
    noReceiptReason:'เหตุผลไม่มีใบเสร็จ', note:'หมายเหตุ', attachments:'ไฟล์แนบ'};
  var changes = [];
  if (a.length !== b.length) changes.push('จำนวนรายการ');
  a.forEach(function(item, i) {
    if (!b[i]) return;
    var keys = Object.keys(item).concat(Object.keys(b[i])).filter(function(k, n, all) { return all.indexOf(k) === n; });
    keys.forEach(function(key) {
      if (JSON.stringify(item[key]) !== JSON.stringify(b[i][key])) {
        changes.push((item.doc_no || item.record_id || ('รายการ '+(i+1))) + ': ' + (labels[key] || key));
      }
    });
  });
  throw new Error('ข้อมูลบิลไม่ตรงกับฉบับที่ตรวจ: ' + changes.slice(0,6).join(', ') + ' — ตรวจสอบก่อนอนุมัติ');
}
