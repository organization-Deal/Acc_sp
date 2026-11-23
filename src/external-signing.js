// Original signing assets stay in private Worker KV, never in the public source bundle.
export const SIGNING_ASSET_KEY='external:signing-assets:v1';
export const SIGNING_VERSION=1;
const sameName=(a,b)=>String(a||'').normalize('NFC').replace(/\s/g,'')===String(b||'').normalize('NFC').replace(/\s/g,'');
const sha256=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
async function assetBundle(owner){
 if(owner.signingAssetCache?.expires>Date.now())return owner.signingAssetCache.value;
 const value=await owner.env.KV.get(SIGNING_ASSET_KEY,'json');
 if(value?.version!==1||!value.assets)throw Error('ยังไม่ได้ตั้งค่าไฟล์ลงนามสำหรับเอกสาร');
 owner.signingAssetCache={value,expires:Date.now()+60000};return value;
}
async function imageAsset(bundle,id,expected){
 const a=bundle.assets[id];if(!a||a.mime!=='image/png'||!a.base64||a.base64.length>3000000)throw Error('ไม่พบไฟล์ลงนามที่ตรงกับทะเบียนบริษัท');
 const bytes=Uint8Array.from(atob(a.base64),c=>c.charCodeAt(0));
 if(bytes.length<8||![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))throw Error('ไฟล์ลงนามไม่ใช่ PNG');
 const hash=await sha256(bytes);if(hash!==a.sha256||(expected&&hash!==expected))throw Error('ไฟล์ลงนามเปลี่ยนจากฉบับที่บันทึก');
 return {bytes,hash};
}
export async function prepareSigningProfile(owner,x,context){
 const a=x.audit,p=context.signing?.get(x.company.id),name=context.names.get(a?.may?.actor);
 if(a?.stage!=='transfer'||!a.not?.actor||!a.not?.at||!a.may?.actor||!a.may?.at)throw Error('ยังไม่มีการอนุมัติจริงสำหรับลงนาม');
 if(a.may.delegated){
  const decision=await owner.ctx.storage.get('external:delegate-decision:'+a.epoch);
  if(!decision||decision.actor!==a.may.actor||decision.at!==a.may.at||decision.id!==x.id||decision.fingerprint!==a.fingerprint||!name||!p?.stampId)throw Error('ไม่พบการยืนยันตัวผู้อนุมัติแทนสำหรับเอกสารนี้');
  const stamp=await imageAsset(await assetBundle(owner),p.stampId);
  return {version:SIGNING_VERSION,mode:'lark-delegate',name,actor:decision.actor,at:decision.at,company:x.company.id,stampId:p.stampId,stampHash:stamp.hash};
 }
 if(!p?.approver||!name||!sameName(p.approver,name)||!p.signatureId||!p.stampId)throw Error('ผู้อนุมัติหรือลายเซ็นไม่ตรงทะเบียนบริษัท');
 const bundle=await assetBundle(owner),signature=await imageAsset(bundle,p.signatureId),stamp=await imageAsset(bundle,p.stampId);
 return {version:SIGNING_VERSION,name,actor:a.may.actor,at:a.may.at,company:x.company.id,signatureId:p.signatureId,stampId:p.stampId,signatureHash:signature.hash,stampHash:stamp.hash};
}
export async function signingImages(owner,profile){
 if(profile?.version!==SIGNING_VERSION)throw Error('ข้อมูลลงนามไม่ครบ');
 const bundle=await assetBundle(owner);
 if(profile.mode==='lark-delegate')return {stamp:(await imageAsset(bundle,profile.stampId,profile.stampHash)).bytes};
 return {signature:(await imageAsset(bundle,profile.signatureId,profile.signatureHash)).bytes,stamp:(await imageAsset(bundle,profile.stampId,profile.stampHash)).bytes};
}
