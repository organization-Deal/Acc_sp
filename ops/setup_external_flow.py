"""Add external review fields/views. Credentials come from operator environment.
Does not approve, send review requests, change payees, or mark any record paid.
"""
import json,os,urllib.request
from pathlib import Path

ROOT='https://open.larksuite.com/open-apis/'
BASE='VykPbo0YqaLql8sqLo2jTAJOpqT'
SNAPSHOT=Path(os.environ.get('FLOW_SNAPSHOT_DIR','/tmp/external-flow-schema'))
SNAPSHOT.mkdir(parents=True,exist_ok=True)
def request(path,data=None,method=None,token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    with urllib.request.urlopen(urllib.request.Request(ROOT+path,headers=headers,data=json.dumps(data).encode() if data is not None else None,method=method),timeout=45) as response:result=json.load(response)
    if result.get('code')!=0:raise RuntimeError(str(result))
    return result.get('data',result)
def main():
    token=request('auth/v3/tenant_access_token/internal',{'app_id':os.environ['LARK_APP_ID'],'app_secret':os.environ['LARK_APP_SECRET']})['tenant_access_token']
    plan={
      'partner':{'table':'tbldczVhrFWfJ5ze','view':'vewGM5EyXW','main':['รายการเบิก','ชื่อบริษัท','ชื่อรายการ','ชื่อบริษัทคู่ค้าผู้รับเงิน','ยอดโอนเงิน','ลงบันทึกค่าใช้จ่ายใน PEAK','บัญชีเช็กแล้ว → ส่งให้นอต','หลักฐานส่งให้นอต','นอตตรวจผ่าน','เมย์อนุมัติ','สถานะงาน'],
       'transfer':['รายการเบิก','ชื่อบริษัท','ชื่อบริษัทคู่ค้าผู้รับเงิน','ยอดโอนเงิน','ธนาคาร','เลขบัญชีผู้รับเงิน','สถานะงาน','ลงบันทึกค่าใช้จ่ายใน PEAK','หลักฐานการโอน','รายการสำเร็จ']},
      'dealpay':{'table':'tblQ1irGp6iyz0Mc','view':'vew9jpmCWA','main':['Case Number','บริษัท','ชื่อสถานที่ตั้งตู้','ชื่อบัญชีผู้รับเงิน','จำนวนเงิน','สลิปโอนเงินที่ใช้บริการกับตู้','บัญชีเช็กแล้ว → ส่งให้นอต','หลักฐานส่งให้นอต','นอตตรวจผ่าน','เมย์อนุมัติ','สถานะงาน'],
       'transfer':['Case Number','บริษัท','ชื่อบัญชีผู้รับเงิน','จำนวนเงิน','ธนาคาร','เลขที่บัญชีธนาคาร','สถานะงาน','หลักฐานการโอน','รายการสำเร็จ']}
    }
    results={}
    for kind,p in plan.items():
        root='bitable/v1/apps/'+BASE+'/tables/'+p['table']
        fields=request(root+'/fields?page_size=100',token=token)['items']
        before=request(root+'/views/'+p['view'],token=token)
        backup=SNAPSHOT/(kind+'-before.json')
        if not backup.exists():backup.write_text(json.dumps({'fields':fields,'view':before},ensure_ascii=False,indent=2))
        byname={f['field_name']:f for f in fields}
        specs=[('บัญชีเช็กแล้ว → ส่งให้นอต',7),('สถานะงาน',1),('นอตตรวจผ่าน',7),('เมย์อนุมัติ',7),('หลักฐานส่งให้นอต',1),('ข้อมูล Flow (ระบบ)',1)]
        if kind=='dealpay':specs.insert(0,('บริษัท',3))
        for name,typ in specs:
            if name in byname:
                assert byname[name]['type']==typ,(name,'type differs');continue
            body={'field_name':name,'type':typ}
            if name=='บริษัท':body['property']={'options':[{'name':n} for n in ['บริษัท โปรเซอร์วิส โฮม โซลูชั่น จำกัด','บริษัท พรอสเพอร์ เวลธี่ เอสเซท จำกัด','บริษัท ออมนิ แดช เพย์ วอลเล็ต จำกัด']]}
            f=request(root+'/fields',body,'POST',token)['field'];byname[name]=f;print('CREATED',kind,name,flush=True)
        ids={name:f['field_id'] for name,f in byname.items()}
        prop=dict(before['view'].get('property') or {});prop['hidden_fields']=[fid for name,fid in ids.items() if name not in p['main']]
        # Preserve existing filters/hierarchy. The live UI controls column ordering.
        request(root+'/views/'+p['view'],{'view_name':'1 • บัญชีตรวจและอนุมัติ','property':prop},'PATCH',token)
        existing=request(root+'/views?page_size=100',token=token)['items']
        queue=next((v for v in existing if v['view_name']=='2 • รอนอตโอน'),None)
        if not queue:queue=request(root+'/views',{'view_name':'2 • รอนอตโอน','view_type':'grid'},'POST',token)['view']
        queue_prop={'hidden_fields':[fid for name,fid in ids.items() if name not in p['transfer']], 'filter_info':{'conjunction':'and','conditions':[{'field_id':ids['สถานะงาน'],'operator':'is','value':json.dumps(['เมย์อนุมัติแล้ว • รอนอตโอน'],ensure_ascii=False)}]} }
        request(root+'/views/'+queue['view_id'],{'property':queue_prop},'PATCH',token)
        results[kind]={'table':p['table'],'main_view':p['view'],'transfer_view':queue['view_id'],'fields':ids}
        print('READY',kind,json.dumps(results[kind],ensure_ascii=False),flush=True)
    (SNAPSHOT/'result.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
