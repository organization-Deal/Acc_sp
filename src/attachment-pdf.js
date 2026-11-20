import {PDFDocument,StandardFonts} from 'pdf-lib';
import {api,recordsPath} from './finance.js';
import {larkToken} from './lark.js';
import {CFG} from './config.js';

export async function downloadBitableAttachment(owner,{table,record,field,token,name}){
 owner.documentFieldIds=owner.documentFieldIds||{};
 if(!owner.documentFieldIds[table]){
  const fields=await api(owner.env,recordsPath(table).replace(/\/records$/,'/fields')+'?page_size=100');
  owner.documentFieldIds[table]=Object.fromEntries(fields.items.filter(f=>f.type===17).map(f=>[f.field_name,f.field_id]));
 }
 const id=owner.documentFieldIds[table][field];if(!id)throw Error('ไม่พบช่องไฟล์แนบ '+field);
 const extra={bitablePerm:{tableId:table,attachments:{[id]:{[record]:[token]}}}};
 const r=await fetch(CFG.LARK_HOST+'/open-apis/drive/v1/medias/'+encodeURIComponent(token)+'/download?extra='+encodeURIComponent(JSON.stringify(extra)),{signal:AbortSignal.timeout(45000),headers:{Authorization:'Bearer '+await larkToken(owner.env)}});
 if(!r.ok)throw Error('ดึงไฟล์แนบไม่สำเร็จ: '+(name||token)+' ('+r.status+')');
 const bytes=new Uint8Array(await r.arrayBuffer());if(!bytes.length||bytes.length>30*1024*1024)throw Error('ไฟล์แนบว่างหรือใหญ่เกิน 30 MB: '+(name||token));
 const mime=r.headers.get('content-type')||'application/octet-stream';
 return {bytes,mime,name:name||token};
}

// Copy PDF pages verbatim; embed original image bytes without JPEG recompression.
// Every source is also an embedded file, including formats a PDF cannot display.
export async function appendPdfAttachments(doc,files){
 let total=0;for(let i=0;i<files.length;i++){
  const f=files[i],b=f.bytes instanceof Uint8Array?f.bytes:new Uint8Array(f.bytes);total+=b.byteLength;
  if(total>70*1024*1024)throw Error('ไฟล์แนบรวมใหญ่เกิน 70 MB');
  const pdf=new TextDecoder().decode(b.slice(0,5))==='%PDF-',png=b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71,jpg=b[0]===255&&b[1]===216;
  const name=String(i+1).padStart(3,'0')+'-'+f.name+(pdf&&!/\.pdf$/i.test(f.name)?'.pdf':png&&!/\.png$/i.test(f.name)?'.png':jpg&&!/\.jpe?g$/i.test(f.name)?'.jpg':'');
  await doc.attach(b,name,{mimeType:pdf?'application/pdf':png?'image/png':jpg?'image/jpeg':f.mime,description:'Original supporting evidence '+(i+1)});
  if(pdf){
   const source=await PDFDocument.load(b);if(source.isEncrypted||!source.getPageCount())throw Error('PDF แนบเปิดไม่ได้: '+f.name);
   for(const page of await doc.copyPages(source,source.getPageIndices()))doc.addPage(page);
  }else if(png||jpg){
   const image=png?await doc.embedPng(b):await doc.embedJpg(b),landscape=image.width>image.height;
   const page=doc.addPage(landscape?[841.89,595.28]:[595.28,841.89]),size=image.scaleToFit(page.getWidth()-24,page.getHeight()-24);
   page.drawImage(image,{x:(page.getWidth()-size.width)/2,y:(page.getHeight()-size.height)/2,...size});
  }else{
   const page=doc.addPage([595.28,841.89]),font=await doc.embedFont(StandardFonts.Helvetica);
   page.drawText('Supporting file '+(i+1)+' is included as an original attachment.',{x:35,y:780,size:12,font});
   page.drawText('Open the PDF attachments panel in a PDF reader to save this file.',{x:35,y:756,size:11,font});
  }
 }
 return doc;
}
