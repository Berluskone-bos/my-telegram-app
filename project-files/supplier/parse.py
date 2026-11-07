import openpyxl,glob,re,json,collections
f=glob.glob('/mnt/user-data/attachments/*/*.xlsx')[0]
ws=openpyxl.load_workbook(f,data_only=True).active
rows=list(ws.iter_rows(values_only=True))
SECT={ 'Моторные масла для дизельных и бензиновых двигателей':('motor_oil','Моторные масла'),
'Моторные масла для бензиновых и дизельных двигателей':('motor_oil','Моторные масла'),
'Моторные масла для 4х тактной техники':('moto4t','Масла для 4-тактной техники'),
'Моторные масла для 2-х тактных двигателей':('moto2t','Масла для 2-тактных двигателей'),
'Трансмиссионные масла':('transmission','Трансмиссионные масла'),
'Трансмиссионные масла для внедорожной техники':('transmission_offroad','Трансмиссионные для внедорожной техники'),
'Жидкости для автоматических трансмиссий':('atf','Жидкости для АКПП'),
'Гидравлические масла':('hydraulic','Гидравлические масла'),
'Компрессорные масла':('compressor','Компрессорные масла'),
'Турбинные масла':('turbine','Турбинные масла'),
'Редукторные масла':('gearbox_ind','Редукторные масла'),
'Антифризы':('coolant','Антифризы'),
'Гидроусилитель руля':('ps_fluid','Жидкость ГУР'),
'Тормозная жидкость':('brake','Тормозная жидкость'),
'Смазки':('grease','Смазки'),'AdBlue':('adblue','AdBlue'),
'Специализированные продукты':('special','Специализированные продукты'),
'Присадки для двигателя':('additive_engine','Присадки для двигателя'),
'Присадки для топлива':('additive_fuel','Присадки для топлива')}
sec=None;prod=None;out=[]
def pack(p):
    s=str(p).replace('\xa0',' ').lower().replace(',','.')
    m=re.match(r'\s*([\d.]+)\s*(л|кг)\.?\s*(?:х\s*(\d+)\s*шт)?',s)
    if not m: return None,None,None
    return float(m.group(1)),m.group(2),int(m.group(3)) if m.group(3) else 1
for i,r in enumerate(rows[3:],start=4):
    a,b,c,d,e,fp,g=r[:7]
    if a is None: continue
    a=str(a).strip()
    if a in SECT and d is None and e is None: sec=a; continue
    if d is None and e is None:   # заголовок товара (с описанием или без)
        prod=dict(name=a,specs=g); continue
    size,unit,box=pack(d)
    w=e if isinstance(e,(int,float)) else None
    out.append(dict(row=i,article=a,sae=(b or '').strip() if isinstance(b,str) else None,pack_raw=str(d).strip(),size=size,unit=unit,box=box,
        cost=w,sheet_retail=fp if isinstance(fp,(int,float)) else None,note=None if w else str(e).strip(),
        product=prod['name'],specs=(prod['specs'] or '').strip(),section=sec,cat=SECT[sec][0],cat_ru=SECT[sec][1]))
print(len(out),collections.Counter(o['cat'] for o in out))
print([o for o in out if o['size'] is None][:5])
json.dump(out,open('rows.json','w'),ensure_ascii=False)
