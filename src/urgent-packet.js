import {PDFDocument,PDFName,PDFDict,PDFArray} from 'pdf-lib';
import {api,recordsPath,SUMMARY,digest,financeProblem} from './finance.js';
import {uploadExternalPdf} from './external-documents.js';
import {CFG} from './config.js';

const output='ชุดตรวจเบิกด่วน PDF';
// Membership of the historical batch was verified against the original vouchers.
const historical=new Set(["ee6a49615bd08d23ffb4", "6fb199b6a6e5f843326d", "bbb43a504f9d1e7c25e8", "8da96aad75e69c72b63e", "56760e89d77fffb8dcff", "d28a39866c974254f2ef", "7c58fc6da75a36832974", "a5b8cfd5a5b3ab3fe6e0", "6c2bd43894d01a1524ce", "0a82fbb7de3d4a0a6724", "3f64616c2f5675312a80", "c768e2dc7302dc1729d8", "9d16a8bc38e29f73eb5a", "53ee551494d8cbb20b96", "42b92905fc9d83255608", "e951d1869e0fc7bf4e43", "8656011a632c79e7cbdc"]);
function driveId(url){
 const u=new URL(url);
 if(u.protocol!=='https:'||u.hostname!=='drive.google.com')throw Error('Unexpected evidence host');
 const id=u.pathname.match(/^\/file\/d\/([\w-]+)/)?.[1]||u.searchParams.get('id');
 if(!id||!/^[-\w]+$/.test(id))throw Error('Invalid evidence link');
 return id;
}
async function fetchPdf(id){
 const r=await fetch('https://drive.google.com/uc?export=download&id='+encodeURIComponent(id),{signal:AbortSignal.timeout(45000)});
 if(!r.ok)throw Error('PDF download failed '+r.status);
 return PDFDocument.load(await r.arrayBuffer());
}
export async function mergePacket(rows,load=fetchPdf){
 const out=await PDFDocument.create(),seen=new Set(),starts=[];
 const covers=Array.from({length:Math.ceil(rows.length/32)},()=>out.addPage([595,842]));
 for(const {j} of rows){
  starts.push(out.getPageCount()+1);
  const doc=await load(driveId(j.pdfUrl));
  const pages=await out.copyPages(doc,doc.getPageIndices());
  for(const [i,page] of pages.entries()){
   out.addPage(page);
   const annotations=doc.getPage(i).node.lookupMaybe(PDFName.of('Annots'),PDFArray);
   for(const ref of annotations?.asArray()||[]){
    const annotation=doc.context.lookup(ref,PDFDict),action=annotation.lookupMaybe(PDFName.of('A'),PDFDict);
    const url=action?.lookup(PDFName.of('URI'))?.decodeText?.();
    if(!url||!/^https:\/\/drive\.google\.com\/file\/d\//.test(url))continue;
    const id=driveId(url);if(seen.has(id))continue;
    const evidence=await load(id);
    for(const extra of await out.copyPages(evidence,evidence.getPageIndices()))out.addPage(extra);
    seen.add(id);
   }
  }
 }
 for(const [i,cover] of covers.entries()){
  cover.drawText('Urgent reimbursement review',{x:40,y:795,size:20});
  cover.drawText(rows.length+' vouchers  |  '+rows.reduce((n,x)=>n+Math.round(100*Number(x.r?.fields?.['ยอดรวม']||0)),0)/100+' '+rows[0].j.currency,{x:40,y:767,size:13});
  cover.drawText('Voucher',{x:40,y:730,size:12});cover.drawText('Amount',{x:337,y:730,size:12});cover.drawText('Page',{x:480,y:730,size:12});
  for(const [n,row] of rows.slice(32*i,32*i+32).entries()){
   const y=705-20*n;
   cover.drawText(row.j.docNo,{x:40,y,size:11});
   cover.drawText(Number(row.r.fields['ยอดรวม']).toFixed(2),{x:337,y,size:11});
   cover.drawText(String(starts[32*i+n]),{x:480,y,size:11});
  }
 }
 return out.save();
}
export async function syncUrgentPacket(owner,all){
 const groups=new Map(),recent=[];
 for(const x of all){
  if(!x.j||financeProblem(x.r.fields,x.j,x.r.record_id))continue;
  const {j}=x,employee=j.employee.recordId,date=j.docNo?.match(/^[^-]+-(\d{8})-/)?.[1];
  if(!employee||!date)continue;
  const key=[employee,date,j.currency].join(':');
  if(!historical.has((await digest(j.docNo)).slice(0,20))){
   if(j.items.length!==1||Number(x.r.fields['วันที่สร้าง'])<Date.now()-7*86400000)continue;
   recent.push({x,key});continue;
  }
  if(!groups.has('backfill:'+key))groups.set('backfill:'+key,[]);
  groups.get('backfill:'+key).push(x);
 }
 // The expense table owns the urgent flag. Never infer urgency from amount or name.
 if(recent.length){
  const ids=[...new Set(recent.map(({x})=>x.j.items[0].record_id).filter(Boolean))],urgent=new Set();
  for(let start=0;start<ids.length;start+=100){
   const result=await api(owner.env,recordsPath(CFG.T_EXPENSE)+'/batch_get','POST',{record_ids:ids.slice(start,start+100)});
   for(const r of result.records||[])if(r.fields?.['สรุปรอบเบิกด่วน']===true)urgent.add(r.record_id);
  }
  for(const {x,key} of recent){
   const k='urgent-member:'+x.j.key;
   if(urgent.has(x.j.items[0].record_id))await owner.ctx.storage.put(k,true);
   else if(!await owner.ctx.storage.get(k))continue;
   if(!groups.has(key))groups.set(key,[]);groups.get(key).push(x);
  }
 }
 for(const [group,rows] of groups){
  if(rows.length<2||group.startsWith('backfill:')&&rows.length!==historical.size)continue;
  rows.sort((a,b)=>a.j.docNo.localeCompare(b.j.docNo));
  const signature=await digest(rows.map(({j})=>[j.key,j.pdfUrl,j.items.map(i=>i.record_id)]));
  const filename='Urgent-review-'+signature.slice(0,12)+'.pdf';
  const missing=rows.filter(({r})=>!r.fields[output]?.some(a=>a.name===filename));
  if(!missing.length)continue;
  const key='urgent-pdf:'+signature;
  let file=await owner.ctx.storage.get(key);
  if(!file){
   const bytes=await mergePacket(rows);
   file=await uploadExternalPdf(owner.env,bytes,filename);await owner.ctx.storage.put(key,file);
  }
  const records=missing.map(({r})=>({record_id:r.record_id,fields:{[output]:[...(r.fields[output]||[]).filter(a=>!/^Urgent-review-[a-f0-9]+\.pdf$/.test(a.name||'')).map(a=>({file_token:a.file_token})),{file_token:file}]}}));
  for(let i=0;i<records.length;i+=100)await api(owner.env,recordsPath(SUMMARY)+'/batch_update','POST',{records:records.slice(i,i+100)});
  return;
 }
}
