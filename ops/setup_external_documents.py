"""Provision PDF fields. Does not approve requests, send messages, or change payees."""
import json,os,urllib.request
from pathlib import Path
ROOT='https://open.larksuite.com/open-apis/'
BASE='VykPbo0YqaLql8sqLo2jTAJOpqT'
def request(path,data=None,method=None,token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    with urllib.request.urlopen(urllib.request.Request(ROOT+path,headers=headers,data=json.dumps(data).encode() if data is not None else None,method=method),timeout=45) as r:d=json.load(r)
    if d.get('code')!=0:raise RuntimeError(str(d))
    return d.get('data',d)
def main():
    token=request('auth/v3/tenant_access_token/internal',{'app_id':os.environ['LARK_APP_ID'],'app_secret':os.environ['LARK_APP_SECRET']})['tenant_access_token']
    backup=Path(os.environ.get('FLOW_SNAPSHOT_DIR','/tmp/external-documents-schema'));backup.mkdir(parents=True,exist_ok=True)
    plan=[('partner','tbldczVhrFWfJ5ze','vewGM5EyXW'),('dealpay','tblQ1irGp6iyz0Mc','vew9jpmCWA')]
    for kind,table,mainview in plan:
        root='bitable/v1/apps/'+BASE+'/tables/'+table
        fields=request(root+'/fields?page_size=100',token=token)['items'];views=request(root+'/views?page_size=100',token=token)['items']
        before=backup/(kind+'-before.json')
        if not before.exists():before.write_text(json.dumps({'fields':fields,'views':views},ensure_ascii=False))
        byname={f['field_name']:f for f in fields}
        specs=[('เลขเอกสารขอจ่าย',1),('ใบขอจ่าย PDF',17),('PDF อนุมัติแล้ว',17),('PDF ปิดรายการ',17),('ประวัติเอกสาร PDF',17),('สถานะเอกสาร',1),('ข้อมูลเอกสาร (ระบบ)',1)]
        if kind=='dealpay':specs.append(('เหตุผลขอคืนเงิน',1))
        for name,typ in specs:
            if name in byname:assert byname[name]['type']==typ;continue
            byname[name]=request(root+'/fields',{'field_name':name,'type':typ},'POST',token)['field']
            print('CREATED',kind,name,flush=True)
        for v in views:
            if v['view_id']!=mainview and v['view_name']!='2 • รอนอตโอน':continue
            current=request(root+'/views/'+v['view_id'],token=token)['view'];prop=dict(current.get('property') or {})
            hidden=set(prop.get('hidden_fields') or [])
            for name in ['ข้อมูลเอกสาร (ระบบ)','ประวัติเอกสาร PDF']:hidden.add(byname[name]['field_id'])
            for name in ['เลขเอกสารขอจ่าย','ใบขอจ่าย PDF','PDF อนุมัติแล้ว','PDF ปิดรายการ','สถานะเอกสาร','การเงินที่ทำเรื่องเบิก']:hidden.discard(byname[name]['field_id'])
            prop['hidden_fields']=sorted(hidden);request(root+'/views/'+v['view_id'],{'property':prop},'PATCH',token)
        (backup/(kind+'-fields.json')).write_text(json.dumps(byname,ensure_ascii=False));print('READY',kind,flush=True)
if __name__=='__main__':main()
