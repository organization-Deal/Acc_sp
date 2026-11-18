import {api,recordsPath,textOf,digest} from './finance.js';
import {larkToken} from './lark.js';
import {CFG} from './config.js';
import {renderExternalPdf,EXTERNAL_PDF_TEMPLATE_VERSION} from './external-pdf.js';

export const ED={number:'เลขเอกสารขอจ่าย',request:'ใบขอจ่าย PDF',approved:'PDF อนุมัติแล้ว',paid:'PDF ปิดรายการ',history:'ประวัติเอกสาร PDF',status:'สถานะเอกสาร',meta:'ข้อมูลเอกสาร (ระบบ)'};
export const documentMeta=x=>{try{return JSON.parse(textOf(x.r.fields[ED.meta]))||{};}catch{return {};}};
export const documentSignature=(x,hash,stage)=>digest([hash,stage,...(stage==='request'?[]:[x.audit?.epoch,x.audit?.accounting,x.audit?.not,x.audit?.may]),...(stage==='paid'?[x.audit?.paid]:[])]);
export async function documentReady(x,stage,hash){const meta=documentMeta(x),v=meta[stage];return !!(v?.file&&v.fingerprint===hash&&v.signature===await documentSignature(x,hash,stage)&&(x.r.fields[ED[stage]]||[]).some(a=>a.file_token===v.file));}
// Layout changes refresh the attachment without invalidating financial approvals or active cards.
export async function documentCurrent(x,stage,hash){return await documentReady(x,stage,hash)&&documentMeta(x)[stage].templateVersion===EXTERNAL_PDF_TEMPLATE_VERSION;}
async function documentContext(owner){
 if(owner.documentContext?.expires>Date.now())return owner.documentContext;
 const [companies,employees]=await Promise.all([api(owner.env,recordsPath('tblbRI6Rwo8giism')+'?page_size=100'),api(owner.env,recordsPath(CFG.T_EMPLOYEE)+'?page_size=500')]);
 const out={expires:Date.now()+60000,companies:new Map(),names:new Map()};
 for(const r of companies.items||[]){const f=r.fields;if(f['เปิดใช้']===true)out.companies.set(textOf(f['รหัสบริษัท']),{name:textOf(f['ชื่อบริษัท']),taxId:textOf(f['เลขผู้เสียภาษี']),address:textOf(f['ที่อยู่'])});}
 for(const r of employees.items||[]){const id=textOf(r.fields['Lark open_id']);if(id)out.names.set(id,textOf(r.fields['Name (TH)']));}
 owner.documentContext=out;return out;
}
export async function uploadExternalPdf(env,data,name){
 const form=new FormData();form.append('file_name',name);form.append('parent_type','bitable_file');form.append('parent_node',CFG.BASE_TOKEN);form.append('size',String(data.byteLength));form.append('file',new Blob([data],{type:'application/pdf'}),name);
 const response=await fetch(CFG.LARK_HOST+'/open-apis/drive/v1/medias/upload_all',{method:'POST',headers:{Authorization:'Bearer '+await larkToken(env)},body:form});const result=await response.json();
 if(!response.ok||result.code!==0||!result.data?.file_token)throw Error('อัปโหลด PDF ไม่สำเร็จ ('+response.status+'/'+result.code+')');return result.data.file_token;
}
export async function ensureExternalDocument(owner,x,stage,services){
 const hash=await services.fingerprint(x);if(await documentCurrent(x,stage,hash))return x;
 if(stage!=='request'&&(!x.audit?.not?.actor||!x.audit?.may?.actor||x.audit.fingerprint!==hash))throw Error('ยังไม่มีผลอนุมัติที่ตรงกับข้อมูล');
 if(stage==='paid'&&(!x.audit?.paid?.ref||!(x.r.fields['หลักฐานการโอน']||[]).some(a=>a.file_token===x.audit.paid.file)))throw Error('ยังไม่มีหลักฐานโอนที่ยืนยันแล้ว');
 const signature=await documentSignature(x,hash,stage),store=owner.ctx.storage,key='external:document:'+x.id+':'+signature+':pdf:'+EXTERNAL_PDF_TEMPLATE_VERSION,seqKey='external:document-seq:'+x.id;
 let job=await store.get(key);
 if(!job){
  const c=await documentContext(owner),requestKey='external:document:'+x.id+':'+await documentSignature(x,hash,'request'),requestJob=await store.get(requestKey+':pdf:'+EXTERNAL_PDF_TEMPLATE_VERSION)||await store.get(requestKey),company=requestJob?.model?.company||c.companies.get(x.company.id);if(!company||company.name!==x.company.name||!company.taxId||!company.address)throw Error('ทะเบียนบริษัทสำหรับออกเอกสารไม่ครบ');
  const actor=a=>a?{at:a.at,name:c.names.get(a.actor)||'ผู้อนุมัติในระบบ'}:null;
  const sequence=await store.get(seqKey)||{number:(x.kind==='partner'?'PAY':'REF')+'-'+x.company.id+'-'+(await digest(x.id)).slice(0,12).toUpperCase(),revision:0};sequence.revision++;await store.put(seqKey,sequence);
  const evidence=[];for(const [field,tokens] of x.evidence){if(tokens.length)evidence.push(field+' ('+tokens.length+' ไฟล์)');}
  const model={title:x.kind==='partner'?'ใบขออนุมัติจ่ายคู่ค้า':'ใบขออนุมัติคืนเงินลูกค้า',kind:x.kind,number:sequence.number,revision:sequence.revision,stage,generatedAt:Date.now(),requestedAt:x.createdAt,company,requester:x.requesters.map(p=>p.name||c.names.get(p.id)||'').filter(Boolean).join(', '),payee:x.name,bank:x.bank,account:x.account,amount:x.amount,currency:x.currency,detail:x.detail,reason:x.note,machine:x.machine,peak:x.peak,sourceUrl:services.url(x),evidence,accounting:x.audit?.fingerprint===hash?x.audit.accounting:null,not:x.audit?.fingerprint===hash?actor(x.audit.not):null,may:x.audit?.fingerprint===hash?actor(x.audit.may):null,paid:stage==='paid'?{...x.audit.paid,name:c.names.get(x.audit.paid.actor)||'นอต'}:null};
  if(!model.requester)throw Error('ไม่พบชื่อพนักงานผู้ตั้งเบิก');
  job={version:1,templateVersion:EXTERNAL_PDF_TEMPLATE_VERSION,signature,fingerprint:hash,model,filename:sequence.number+'-v'+sequence.revision+'-'+stage+'.pdf'};await store.put(key,job);
 }
 if(!job.file){const pdf=await renderExternalPdf(job.model);job.file=await uploadExternalPdf(owner.env,pdf,job.filename);await store.put(key,job);}
 // Re-read after expensive rendering/upload. Never publish an approved document for changed data.
 const current=await services.fresh(x),currentHash=await services.fingerprint(current);
 if(currentHash!==hash||await documentSignature(current,currentHash,stage)!==signature)throw Error('ข้อมูลเปลี่ยนระหว่างสร้าง PDF จะสร้างใหม่ในรอบถัดไป');
 const meta=documentMeta(current),history=[...(current.r.fields[ED.history]||[])].map(a=>({file_token:a.file_token}));
 const fields={};const retire=field=>{for(const a of current.r.fields[field]||[])if(a.file_token!==job.file&&!history.some(h=>h.file_token===a.file_token))history.push({file_token:a.file_token});};
 retire(ED[stage]);
 if(stage==='request'&&meta.request?.fingerprint!==hash){for(const s of ['approved','paid']){retire(ED[s]);fields[ED[s]]=[];delete meta[s];}}
 meta.number=job.model.number;meta[stage]={file:job.file,fingerprint:hash,signature,revision:job.model.revision,generatedAt:job.model.generatedAt,templateVersion:EXTERNAL_PDF_TEMPLATE_VERSION};
 Object.assign(fields,{[ED.number]:job.model.number,[ED[stage]]:[{file_token:job.file}],[ED.history]:history,[ED.meta]:JSON.stringify(meta),[ED.status]:stage==='request'?'ใบขอจ่ายพร้อมตรวจ':stage==='approved'?'PDF อนุมัติแล้วพร้อมโอน':'PDF ปิดรายการพร้อมหลักฐาน'});
 await services.write(current,fields);return current;
}
export async function readExternalDocument(owner,saved,x,stage,hash){
 if(!saved||!['request','approved','paid'].includes(stage)||!(saved.signatures.some(s=>s.id===x.id&&s.fingerprint===hash&&s.epoch===x.audit?.epoch)||(saved.stage==='transfer'&&stage==='approved'&&x.audit?.stage==='transfer'&&x.audit.fingerprint===hash))||!await documentReady(x,stage,hash))throw Error('ไม่มีสิทธิ์หรือเอกสารเปลี่ยน');
 const meta=documentMeta(x);owner.documentFieldIds=owner.documentFieldIds||{};
 if(!owner.documentFieldIds[x.table]){const fields=await api(owner.env,recordsPath(x.table).replace(/\/records$/,'/fields')+'?page_size=100');owner.documentFieldIds[x.table]=Object.fromEntries(fields.items.filter(f=>f.type===17).map(f=>[f.field_name,f.field_id]));}
 const field=owner.documentFieldIds[x.table][ED[stage]];if(!field)throw Error('ไม่พบช่องเอกสาร');
 const extra={bitablePerm:{tableId:x.table,attachments:{[field]:{[x.r.record_id]:[meta[stage].file]}}}};
 const response=await fetch(CFG.LARK_HOST+'/open-apis/drive/v1/medias/'+encodeURIComponent(meta[stage].file)+'/download?extra='+encodeURIComponent(JSON.stringify(extra)),{headers:{Authorization:'Bearer '+await larkToken(owner.env)}});
 if(!response.ok)throw Error('เปิด PDF ไม่สำเร็จ ('+response.status+')');const bytes=await response.arrayBuffer();
 if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw Error('ไฟล์ตอบกลับไม่ใช่ PDF');return {bytes,filename:meta.number+'-'+stage+'.pdf'};
}
