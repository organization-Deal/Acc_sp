const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?String(v.text??v.name??v.value??''):String(v??'');
// Use only the submitted purposes. Keep meaningful whole entries and Thai marks.
export function expenseSummary(items,fallback=''){
 const details=[...new Set((items||[]).map(x=>text(typeof x==='string'?x:x.detail).normalize('NFC').replace(/\s+/g,' ').trim()).filter(Boolean))];
 if(!details.length)details.push(text(fallback).replace(/\s+/g,' ').trim()||'ดูรายละเอียดในเอกสาร');
 const full=details.join(', ');if(full.length<=100)return full;
 let out='';for(const value of details){const next=out?out+', '+value:value;if((next+'…').length>100)break;out=next;}
 if(out)return out+'…';
 for(const {segment} of new Intl.Segmenter('th',{granularity:'grapheme'}).segment(details[0])){if((out+segment+'…').length>100)break;out+=segment;}
 return out+'…';
}
