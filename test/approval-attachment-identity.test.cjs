const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/ApprovalAttachmentIdentity.gs'), 'utf8'), ctx);
const original = [{record_id:'record1', doc_no:'RR_TEST', date:'18/11/2026',
  amount:100, detail:'Expense', category:'Travel', pay_type:'Transfer',
  needsReceipt:true, noReceiptReason:'No receipt', note:'Note', unit:'-',
  attachments:[{file_token:'file1', name:'receipt.jpg', type:'Receipt',
    url:'https://example.invalid/download?rev=7065'}]}];
const clone = value => JSON.parse(JSON.stringify(value));

test('Lark download URL revision is not a bill edit; inputs stay unchanged', () => {
  const next=clone(original); next[0].attachments[0].url='https://example.invalid/download?rev=7121';
  const snapshot=JSON.stringify([original,next]);
  assert.equal(ctx.mcAssertApprovalItems_(original,next),true);
  assert.equal(JSON.stringify([original,next]),snapshot);
});
for(const key of ['record_id','doc_no','date','amount','detail','category','pay_type','needsReceipt','noReceiptReason','note','unit']) {
  test(`still blocks change to ${key}`,()=>{
    const next=clone(original); next[0][key]=key==='amount'?101:key==='needsReceipt'?false:'changed';
    assert.throws(()=>ctx.mcAssertApprovalItems_(original,next),/ข้อมูลบิลไม่ตรง/);
  });
}
for(const key of ['file_token','name','type']) {
  test(`still blocks attachment ${key} change`,()=>{
    const next=clone(original); next[0].attachments[0][key]='changed';
    assert.throws(()=>ctx.mcAssertApprovalItems_(original,next),/RR_TEST: ไฟล์แนบ/);
  });
}
test('blocks added, removed and reordered attachments',()=>{
  const next=clone(original); next[0].attachments.push({...next[0].attachments[0],file_token:'file2'});
  assert.throws(()=>ctx.mcAssertApprovalItems_(original,next));
  const swapped=clone(next); swapped[0].attachments.reverse();
  assert.throws(()=>ctx.mcAssertApprovalItems_(next,swapped));
  assert.throws(()=>ctx.mcAssertApprovalItems_(next,original));
});
test('URL changes without a stable token remain blocked',()=>{
  for(const token of [undefined,null,'',' ']) {
    const old=clone(original); old[0].attachments[0].file_token=token;
    const next=clone(old); next[0].attachments[0].url='changed';
    assert.throws(()=>ctx.mcAssertApprovalItems_(old,next));
  }
});
test('blocks removed or added bills and unknown data changes',()=>{
  assert.throws(()=>ctx.mcAssertApprovalItems_(original,[]),/จำนวนรายการ/);
  assert.throws(()=>ctx.mcAssertApprovalItems_([],original),/จำนวนรายการ/);
  const next=clone(original); next[0].futureField='new data';
  assert.throws(()=>ctx.mcAssertApprovalItems_(original,next),/futureField/);
});
