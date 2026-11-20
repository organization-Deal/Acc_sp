import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,PDFName,PDFDict,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {appendPdfAttachments} from '../src/attachment-pdf.js';
import {expenseSummary} from '../src/expense-summary.js';
import {internalTransferDocument} from '../src/internal-transfer-document.js';
import {CFG} from '../src/config.js';
import {SUMMARY,LEDGER} from '../src/finance.js';
const pixel=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));

function embeddedFiles(pdf){
 const names=pdf.catalog.lookup(PDFName.of('Names'),PDFDict).lookup(PDFName.of('EmbeddedFiles'),PDFDict).lookup(PDFName.of('Names'));
 const files=[];for(let i=1;i<names.size();i+=2){const spec=names.lookup(i,PDFDict),stream=spec.lookup(PDFName.of('EF'),PDFDict).lookup(PDFName.of('F'),PDFRawStream);files.push(decodePDFRawStream(stream).decode());}return files;
}
test('merged PDFs retain all original pages, dimensions and exact downloadable source bytes',async()=>{
 const original=await PDFDocument.create();original.addPage([200,350]);original.addPage([400,200]);const input=await original.save();
 const result=await PDFDocument.create();result.addPage();await appendPdfAttachments(result,[{name:'ใบแจ้งหนี้.pdf',bytes:input},{name:'qr.png',bytes:pixel},{name:'source.csv',mime:'text/csv',bytes:new TextEncoder().encode('original file')}]);
 const pdf=await PDFDocument.load(await result.save());assert.equal(pdf.getPageCount(),5);
 assert.deepEqual(pdf.getPages().slice(1,3).map(p=>[p.getWidth(),p.getHeight()]),[[200,350],[400,200]]);
 const files=embeddedFiles(pdf);assert.equal(files.length,3);assert.deepEqual(files[0],input);assert.deepEqual(files[1],pixel);assert.equal(new TextDecoder().decode(files[2]),'original file');
});
test('invalid PDF evidence fails instead of silently publishing missing pages',async()=>{
 const doc=await PDFDocument.create();await assert.rejects(()=>appendPdfAttachments(doc,[{name:'broken.pdf',bytes:new TextEncoder().encode('%PDF- corrupt')} ]));
});
test('100-character purpose summaries deduplicate actual entries and preserve Thai graphemes',()=>{
 assert.equal(expenseSummary([{detail:'น้ำมัน'},{detail:'ทางด่วน'},{detail:'น้ำมัน'},{detail:'ไปดูตู้ชกมวย'},{detail:'ค่าซ่อมตู้ชก'}]),'น้ำมัน, ทางด่วน, ไปดูตู้ชกมวย, ค่าซ่อมตู้ชก');
 assert.equal(expenseSummary([], 'ค่าไฟ ais รอบบิลตุลาคม 2569'),'ค่าไฟ ais รอบบิลตุลาคม 2569');
 for(const details of [Array.from({length:10},(_,i)=>({detail:'ค่าน้ำมันรถไปดูตู้ชกมวย สาขา '+i})),[{detail:'น้ำมัน '.repeat(100)}],[{detail:'😀'.repeat(100)}]]){const summary=expenseSummary(details);assert.ok(summary.length<=100);assert.ok(!/[\uD800-\uDBFF]$/.test(summary));assert.ok(summary.endsWith('…'));}
});

test('internal transfer bundle includes approved PDF and each approved evidence token; changed or private sources fail',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage([300,500]);const approved=await pdf.save();
 const j={key:'job',summaryId:'recsummary',state:'APPROVED',company:{id:'PSH',name:'Company'},employee:{name:'Employee',accountName:'Employee',accountNo:'1234567890',bankName:'SCB'},currency:'THB',docId:'document',docNo:'INT-001',pdfUrl:'https://drive.google.com/file/d/request/view',approvedPdf:'https://drive.google.com/file/d/approved/view',items:[{record_id:'recexpense',detail:'น้ำมัน',amount:231,attachments:[{file_token:'evidence',name:'qr.png'}]}]};
 const r={record_id:'recsummary',fields:{'รหัสงานระบบ':j.key,'บริษัท':'Company','รหัสบริษัท':'PSH','ชื่อพนักงาน':'Employee','ชื่อบัญชี':'Employee','เลขบัญชี':'1234567890','ธนาคาร':'SCB','Doc ID':j.docId,'เลขใบขอเบิก':j.docNo,'ใบขอเบิก PDF':{link:j.pdfUrl},'PDF อนุมัติแล้ว':{link:j.approvedPdf},'ยอดรวม':231,'จำนวนรายการ':1,'สถานะ':'อนุมัติแล้ว',Approve:true,'นอตตรวจผ่าน':true,'ผู้ตรวจสอบก่อนอนุมัติ':'NOT','เวลานอตตรวจผ่าน':123}};
 const real=globalThis.fetch;let changed=false,privatePdf=false;
 const owner={env:{KV:{get:async()=> 'token'}}};
 globalThis.fetch=async(url,opt={})=>{
  const u=new URL(url);if(u.hostname==='drive.google.com'){assert.equal(u.searchParams.get('id'),'approved');return new Response(privatePdf?'sign in':approved);}
  if(u.pathname.endsWith('/download')){const extra=JSON.parse(u.searchParams.get('extra'));assert.deepEqual(extra.bitablePerm.attachments,{fldreceipt:{recexpense:['evidence']}});return new Response(pixel,{headers:{'content-type':'image/png'}});}
  let data;if(u.pathname.includes(LEDGER))data={items:[{fields:{'ข้อมูลงาน JSON':JSON.stringify(j)}}]};
  else if(u.pathname.includes(SUMMARY))data={items:[r]};
  else if(u.pathname.endsWith('/fields'))data={items:[{field_name:CFG.F.ATT_RECEIPT,field_id:'fldreceipt',type:17}]};
  else if(u.pathname.endsWith('/recexpense'))data={record:{fields:{[CFG.F.ATT_RECEIPT]:changed?[]:[{file_token:'evidence'}]}}};
  else throw Error('Unexpected URL');
  return Response.json({code:0,data});
 };
 try{
  const result=await internalTransferDocument(owner,'recsummary'),merged=await PDFDocument.load(result.bytes);assert.equal(merged.getPageCount(),2);assert.deepEqual(embeddedFiles(merged)[0],pixel);
  changed=true;await assert.rejects(()=>internalTransferDocument(owner,'recsummary'),/ต้นทางเปลี่ยน/);changed=false;
  privatePdf=true;await assert.rejects(()=>internalTransferDocument(owner,'recsummary'),/สิทธิ์ไฟล์/);
 }finally{globalThis.fetch=real;}
});
