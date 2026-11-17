// Append once to the existing unified Apps Script. No triggers/deployment are created here.
// Keep CONFIG.EXP_DATE as request creation time for mcPoll cutover checks.
var auditOriginalParseExpenseRecord_ = parseExpenseRecord;
parseExpenseRecord = function(rec) {
  var out = auditOriginalParseExpenseRecord_(rec);
  var actual = rec && rec.fields && rec.fields['วันที่ใช้จ่าย'];
  if (actual) out.date = extractDate(actual);
  return out;
};
