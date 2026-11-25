import {PDFDocument} from 'pdf-lib';
import {groupedInternalTransfers} from './transfer.js';
import {api,recordsPath,fingerprint} from './finance.js';
import {CFG} from './config.js';
import {appendPdfAttachments,downloadBitableAttachment} from './attachment-pdf.js';

async function approvedPdfBytes(value){
 const u=new URL(value);
 if(u.protocol!=='https:'||!['drive.google.com','docs.google.com'].includes(u.hostname))throw Error('ลิงก์ PDF อนุมัติไม่ใช่ Google Drive');
 const id=u.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1]||u.searchParams.get('id');
 if(!id||!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('ไม่พบรหัส PDF อนุมัติ');
 const r=await fetch('https://drive.google.com/uc?export=download&id='+encodeURIComponent(id),{signal:AbortSignal.timeout(45000)});
 const bytes=new Uint8Array(await r.arrayBuffer());
 if(!r.ok||new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw Error('ดึง PDF อนุมัติไม่ได้ ให้ตรวจสิทธิ์ไฟล์ต้นฉบับ');
 return bytes;
}

// Called only after the existing transfer-session authorization has succeeded.
export async function internalTransferDocument(owner,id){
 const row=(await groupedInternalTransfers(owner)).find(x=>x.id===id);if(!row)throw Error('รายการไม่อยู่ในคิวรอโอน');
 let out;
 for(const {j} of row.members||[row.source]){
  const files=[],seen=new Set();
  for(const item of j.items){
   const attachments=item.attachments||[];if(!attachments.length)continue;
   if(!/^rec[a-zA-Z0-9]+$/.test(item.record_id))throw Error('ไม่พบรายการต้นทางของไฟล์แนบ');
   const current=(await api(owner.env,recordsPath(CFG.T_EXPENSE)+'/'+item.record_id)).record;
   for(const a of attachments){
    if(!a.file_token)throw Error('ไฟล์แนบไม่มีรหัสถาวร กรุณาตรวจต้นทาง');
    if(seen.has(a.file_token))continue;seen.add(a.file_token);
    const field=Object.keys(current.fields).find(k=>Array.isArray(current.fields[k])&&current.fields[k].some(v=>v.file_token===a.file_token));
    if(!field)throw Error('ไฟล์แนบต้นทางเปลี่ยน กรุณาตรวจรายการ');
    files.push(await downloadBitableAttachment(owner,{table:CFG.T_EXPENSE,record:item.record_id,field,token:a.file_token,name:a.name||a.file_token}));
   }
  }
  const doc=await PDFDocument.load(await approvedPdfBytes(row.pendingSignedPdf?j.pdfUrl:j.approvedPdf));
  if(!out)out=doc;
  else for(const page of await out.copyPages(doc,doc.getPageIndices()))out.addPage(page);
  await appendPdfAttachments(out,files);
 }
 const fresh=(await groupedInternalTransfers(owner)).find(x=>x.id===id);
 if(!fresh||fresh.pdf!==row.pdf||await fingerprint(fresh.source.r,fresh.source.j)!==await fingerprint(row.source.r,row.source.j))throw Error('ข้อมูลเปลี่ยนระหว่างรวมเอกสาร');
 return {bytes:await out.save(),filename:(row.members?row.id:row.source.j.docNo)+'-with-evidence.pdf'};
}
