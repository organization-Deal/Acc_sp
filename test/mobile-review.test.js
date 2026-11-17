import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {sortPageHtml,newState} from '../src/domain.js';
const html=()=>sortPageHtml('test','token','https://example.invalid',newState());
test('review button blocks incomplete and pending edits, enables reviewed bill',()=>{
 const nodes={confirmButton:{},confirmHint:{}};
 const ctx={document:{addEventListener(){},getElementById:id=>nodes[id]},fetch:async()=>({json:async()=>({ok:true})})};vm.createContext(ctx);
 const script=html().match(/<script>([\s\S]*?)<\/script>/)[1].replace(/render\(\);\s*$/,'');vm.runInContext(script,ctx);
 vm.runInContext("D.bills=[{company_id:'PSH',amount:45,ai_detail:'',category:'',expense_date:'2026-11-16',pay_type:'เงินโอน',purpose_confirmed:false}];updateConfirmState()",ctx);
 assert.equal(nodes.confirmButton.disabled,true);assert.match(nodes.confirmHint.textContent,/ชื่อรายการ/);
 vm.runInContext("Object.assign(D.bills[0],{ai_detail:'น้ำดื่ม',category:D.cats[0],purpose_confirmed:true});updateConfirmState()",ctx);
 assert.equal(nodes.confirmButton.disabled,false);
 vm.runInContext('pendingRequests=1;updateConfirmState()',ctx);assert.equal(nodes.confirmButton.disabled,true);
 vm.runInContext('pendingRequests=0;submitting=true;updateConfirmState()',ctx);assert.equal(nodes.confirmButton.disabled,true);
});
