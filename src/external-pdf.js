import {PDFDocument,PDFName,PDFHexString,PDFOperator,rgb,beginText,endText,setFontAndSize,setTextMatrix,showText,setFillingRgbColor} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {SARABUN_BASE64} from './sarabun-font.js';
import {appendPdfAttachments} from './attachment-pdf.js';

export const EXTERNAL_PDF_TEMPLATE_VERSION=4;

const bytes=Uint8Array.from(atob(SARABUN_BASE64),c=>c.charCodeAt(0));
const face=fontkit.create(bytes);
const navy=[.10,.16,.25],teal=[.02,.40,.42],grey=[.36,.42,.48];
const clean=v=>String(v??'').replace(/[\u0000-\u0008\u000B-\u001F]/g,'').normalize('NFC');
const date=v=>v?new Date(v).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'medium',timeStyle:'short'}):'-';
export async function renderExternalPdf(m){
 if(m.stage!=='request'&&(!m.signing?.name||(!m.signing?.signature&&m.signing?.mode!=='lark-delegate')||!m.signing?.stamp||m.signing.at!==m.may?.at))throw Error('ไม่มีข้อมูลลงนามที่ตรงกับการอนุมัติ');
 const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
 const font=await doc.embedFont(bytes,{subset:false});doc.setTitle(m.title+' '+m.number);doc.setAuthor(m.company.name);doc.setCreationDate(new Date(m.generatedAt));doc.setModificationDate(new Date(m.generatedAt));
 let page,y,key;const pages=[];const left=42,width=511;
 const measure=(s,size=10)=>face.layout(clean(s)).positions.reduce((n,p)=>n+p.xAdvance,0)*size/face.unitsPerEm;
 function line(s,x,at,size=10,color=navy){
  s=clean(s);if(!s)return;const run=face.layout(s),scale=size/face.unitsPerEm;
  // Preserve Thai mark offsets from the font's shaping engine and a searchable Unicode text span.
  page.pushOperators(PDFOperator.of('BDC',[PDFName.of('Span'),doc.context.obj({ActualText:PDFHexString.fromText(s)})]),beginText(),setFontAndSize(key,size),setFillingRgbColor(...color));
  let cursor=0;for(let i=0;i<run.glyphs.length;i++){const p=run.positions[i];page.pushOperators(setTextMatrix(1,0,0,1,x+(cursor+p.xOffset)*scale,at+p.yOffset*scale),showText(PDFHexString.of(run.glyphs[i].id.toString(16).padStart(4,'0'))));cursor+=p.xAdvance;}
  page.pushOperators(endText(),PDFOperator.of('EMC',[]));
 }
 function wrap(s,max=width,size=10){
  const result=[];for(const paragraph of clean(s).split('\n')){let current='';const words=[...new Intl.Segmenter('th',{granularity:'word'}).segment(paragraph)].map(x=>x.segment);
   for(const word of words){if(measure(current+word,size)<=max){current+=word;continue;}if(current.trim())result.push(current.trimEnd());current='';if(measure(word,size)>max){for(const g of new Intl.Segmenter('th',{granularity:'grapheme'}).segment(word)){if(measure(current+g.segment,size)>max&&current){result.push(current);current='';}current+=g.segment;}}else current=word.trimStart();}result.push(current.trimEnd());}return result;
 }
 function newPage(){page=doc.addPage([595.28,841.89]);pages.push(page);key=page.node.newFontDictionary(font.name,font.ref);y=782;page.drawRectangle({x:left,y:808,width:width,height:4,color:rgb(...teal)});}
 function room(h){if(y-h<65){newPage();line(m.number+' | '+m.title,left,y,9,grey);y-=28;}}
 function text(s,{size=10,color=navy,max=width,x=left,gap=15}={}){const lines=wrap(s,max,size);for(const t of lines){room(gap);line(t,x,y,size,color);y-=gap;}return lines.length*gap;}
 function section(s){room(40);y-=7;page.drawRectangle({x:left,y:y-7,width,height:23,color:rgb(.93,.96,.96)});line(s,left+9,y,10,teal);y-=27;}
 function pair(a,b){const half=(width-22)/2,la=wrap(a[1]||'-',half,10),lb=wrap(b[1]||'-',half,10),h=Math.max(la.length,lb.length)*15+23;room(h);line(a[0],left,y,8,grey);line(b[0],left+half+22,y,8,grey);y-=17;const top=y;la.forEach((t,i)=>line(t,left,top-i*15));lb.forEach((t,i)=>line(t,left+half+22,top-i*15));y-=Math.max(la.length,lb.length)*15+8;}
 function link(label,url){room(18);line(label,left,y,9,teal);const ann=doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[left,y-3,left+Math.min(width,measure(label,9)),y+11],Border:[0,0,0],A:{Type:'Action',S:'URI',URI:PDFHexString.fromText(url)}});page.node.addAnnot(doc.context.register(ann));y-=18;}
 newPage();text(m.company.name,{size:15,gap:21});text(m.company.address,{size:9,color:grey,gap:14});text('เลขประจำตัวผู้เสียภาษี '+(m.company.taxId||'-'),{size:9,color:grey,gap:14});y-=12;
 text(m.title,{size:20,gap:28,color:teal});text(m.stage==='paid'?'ฉบับปิดรายการ - มีหลักฐานโอนแนบ':m.stage==='approved'?'ฉบับอนุมัติแล้ว - รอดำเนินการโอน':'ฉบับขออนุมัติ - ตรวจสถานะล่าสุดในรายการ',{size:10,gap:18,color:grey});
 pair(['เลขเอกสาร / ฉบับที่',m.number+' / '+m.revision],['วันที่จัดทำ',date(m.generatedAt)]);
 section('01  ผู้ตั้งเบิกและผู้รับเงินจริง');
 pair(['พนักงานผู้ตั้งเบิก',m.requester],['ผู้รับเงินภายนอก',m.payee]);
 pair(['วันที่ตั้งรายการ',date(m.requestedAt)],['ธนาคาร / เลขบัญชีผู้รับ',m.bank+' / '+m.account]);
 section('02  รายละเอียดขอจ่าย');
 text(m.detail,{gap:16});if(m.machine)text('ประเภทตู้: '+m.machine,{color:grey,gap:16});
 text('เหตุผล: '+(m.reason||'ตามรายละเอียดและหลักฐานประกอบ'),{gap:16});
 room(45);y-=8;line('ยอดขอ'+(m.kind==='dealpay'?'คืนเงิน':'จ่าย'),left,y,10,grey);const total=Number(m.amount).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2})+' '+m.currency;line(total,left+width-measure(total,21),y-2,21,teal);y-=30;
 section('03  หลักฐานประกอบ');
 text(m.evidence.length?m.evidence.map((v,i)=>(i+1)+'. '+v).join('\n'):'เอกสารประกอบอ้างอิงตามลิงก์รายการต้นทาง',{size:9,gap:14});
 if(m.peak)link('เปิดเอกสาร PEAK เดิม',m.peak);link('เปิดรายการต้นทางและหลักฐานแนบทั้งหมด',m.sourceUrl);
 if(m.stage==='paid'){section('04  หลักฐานการโอน');text('แนบและตรวจหลักฐานเมื่อ '+date(m.paid.at),{size:9,gap:16});text('เลขอ้างอิงธนาคาร: '+m.paid.ref,{size:9,gap:16});text('ผู้บันทึก: '+m.paid.name,{size:9,gap:16});text('สลิปการโอนผูกอยู่ในรายการต้นทาง',{size:9,gap:16});}
 // Formal signing area. The request copy remains unsigned; only verified approval copies carry images.
 room(185);const top=y-10,half=(width-22)/2,centres=[left+half/2,left+half+22+half/2];
 const centre=(s,c,at,size=9,color=navy)=>line(s,c-measure(s,size)/2,at,size,color);
 for(const c of centres)page.drawLine({start:{x:c-92,y:top-38},end:{x:c+92,y:top-38},thickness:.5,color:rgb(...grey)});
 centre(m.requester,centres[0],top-54);centre('ผู้จัดทำคำขอ',centres[0],top-69);centre('วันที่ '+date(m.requestedAt),centres[0],top-84,8,grey);
 centre(m.stage==='request'?'(................................................)':m.signing.name,centres[1],top-54);
 centre('ผู้อนุมัติ',centres[1],top-69);centre(m.stage==='request'?'วันที่ ........................................':'วันที่ '+date(m.signing.at),centres[1],top-84,8,grey);
 if(m.stage!=='request'){
  const seal=await doc.embedPng(m.signing.stamp),zs=seal.scaleToFit(80,66);
  if(m.signing.mode==='lark-delegate')centre('อนุมัติแทนผ่าน Lark',centres[1],top-27);
  else {const sig=await doc.embedPng(m.signing.signature),ss=sig.scaleToFit(116,42);page.drawImage(sig,{x:centres[1]-ss.width/2,y:top-36,width:ss.width,height:ss.height});}
  page.drawImage(seal,{x:centres[1]-zs.width/2,y:top-156,width:zs.width,height:zs.height});
 }else page.drawRectangle({x:centres[1]-42,y:top-156,width:84,height:62,borderWidth:.4,borderColor:rgb(.8,.83,.85)});
 centre('ตราประทับบริษัท',centres[1],top-169,8,grey);y=top-180;
 for(let i=0;i<pages.length;i++){page=pages[i];key=page.node.newFontDictionary(font.name,font.ref);line('เอกสารขออนุมัติภายใน - ไม่ใช่ใบเสร็จรับเงินหรือใบกำกับภาษี',left,38,8,grey);line(m.number+' | '+(i+1)+'/'+pages.length,left,24,7,grey);}
 await appendPdfAttachments(doc,m.attachments||[]);
 return doc.save();
}
