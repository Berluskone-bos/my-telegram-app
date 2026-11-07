import json,re,collections
rows=json.load(open('rows.json'))
MARKUP=0.5
def tokens(specs):
    m=re.search(r'Спецификации\s*:\s*(.*)$',specs,re.S|re.I)
    if not m: return []
    hm=str.maketrans('АВСЕКМНОРТХ','ABCEKMHOPTX'); txt=re.sub(r'(?<=[A-Za-z0-9 ])[АВСЕКМНОРТХ](?=[0-9])',lambda x:x.group(0).translate(hm),m.group(1))
    txt=re.sub(r'\([^)]*\)?','',txt)
    txt=re.sub(r'\bMERCEDES[- ]BENZ(\s+SHEET)?\b','MB',txt,flags=re.I); txt=re.sub(r'\bVOLKSWAGEN\b','VW',txt,flags=re.I)
    txt=re.sub(r'(\d)\s*/\s*(?=\d)',r'\1,',txt)
    txt=re.sub(r'\s+',' ',txt).strip().rstrip('.')
    out=[]
    for seg in re.split(r'[;.](?=\s+[A-Za-zА-Я])|;',txt):
        seg=seg.strip().rstrip('.')
        if not seg: continue
        mm=re.match(r'^(API|ACEA|ILSAC|JASO|ISO|DIN|NSF|AGMA|NLGI|SAE)\s+(.*)$',seg,re.I)
        if mm:
            pre=mm.group(1).upper()
            for p in re.split(r'[,/]',mm.group(2)):
                p=p.strip()
                if p: out.append(f'{pre} {p}' if not re.match(r'^[A-Za-z]{3,}\b',p) or pre=='ACEA' and re.match(r'^[A-Z]\d',p) else p)
            continue
        parts=[x.strip() for x in seg.split(',') if x.strip()]
        if not parts: continue
        out.append(parts[0]); pre=' '.join(parts[0].split()[:-1])
        for p in parts[1:]:
            out.append(p if re.match(r'^[A-Za-zА-Я]{2,}',p) and ' ' in p else (pre+' '+p).strip())
    out=[t for t in out if len(re.findall(r'[А-Яа-я]',t))<3]
    seen=[];[seen.append(t) for t in out if t not in seen]
    return seen
issues=[]
for r in rows:
    r['approvals']=tokens(r['specs'])
    c=r['cost']
    r['price']=round(c*(1+MARKUP)) if c else None
    r['active']=bool(c and r['size'] and r['size']<=20 and r['article'] not in ('30013','60120','40890','304369'))  # позиции с ошибками прайса владельцу не нужны
    if c and r['sheet_retail'] and abs(r['sheet_retail']-c*1.5)>c*0.01:
        issues.append((r['row'],r['article'],r['product'],r['pack_raw'],c,r['sheet_retail'],r['price'],'Розница в прайсе не равна оптовая ×1,5; взята формула'))
    if not c: issues.append((r['row'],r['article'],r['product'],r['pack_raw'],None,None,None,'Цена «по запросу» — в магазин не включена'))
    if r['size'] is None: issues.append((r['row'],r['article'],r['product'],r['pack_raw'],c,r['sheet_retail'],r['price'],'Не распознана фасовка («мл»? опечатка) — товар неактивен'))
    r['name']=f"{r['product']} {r['pack_raw'].replace(' х ',' × ').replace('шт.','шт')}".replace('  ',' ').strip()
json.dump(rows,open('final.json','w'),ensure_ascii=False)
def q(s): return "'"+str(s).replace("'","''")+"'"
n=lambda v:'NULL' if v is None else str(v)
L=["-- Каталог ООО «Сан Трип» (прайс от 24.09.2026). Запуск: sudo -u postgres psql -d avtopromoyl_shop -f catalog-import.sql",
"-- Можно запускать повторно: цены обновятся, дублей не будет. Остатки НЕ трогает.","BEGIN;"]
cat2=dict()
for r in rows:
    L.append("INSERT INTO products (article,name,brand,category,price,cost_price,section,viscosity,pack_size,pack_unit,box_qty,specs_text,pack_label,is_active) VALUES (%s,%s,'Gulf Western Oil',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (article) DO UPDATE SET name=EXCLUDED.name,price=EXCLUDED.price,cost_price=EXCLUDED.cost_price,category=EXCLUDED.category,section=EXCLUDED.section,viscosity=EXCLUDED.viscosity,pack_size=EXCLUDED.pack_size,pack_unit=EXCLUDED.pack_unit,box_qty=EXCLUDED.box_qty,specs_text=EXCLUDED.specs_text,pack_label=EXCLUDED.pack_label;"%(
      q(r['article']),q(r['name'][:200]),q(r['cat']),n(r['price'] if r['price'] else 0),n(r['cost']),q(r['cat_ru']),q(r['sae']) if r['sae'] else 'NULL',n(r['size']),q(r['unit']) if r['unit'] else 'NULL',n(r['box']),q(r['specs']) if r['specs'] else 'NULL',q(r['pack_raw']),'true' if r['active'] else 'false'))
L.append("COMMIT;")
open('catalog-import.sql','w',encoding='utf-8').write('\n'.join(L)+'\n')
A=["-- ЧЕРНОВИК допусков из описаний прайса Сан Трип. Запускать ТОЛЬКО после проверки таблицы catalog-santrip.xlsx (лист «Допуски»).",
"-- sudo -u postgres psql -d avtopromoyl_shop -f approvals-import.sql","BEGIN;"]
cnt=0
for r in rows:
    if r['cat'] in ('motor_oil','atf','transmission','coolant','brake','ps_fluid','moto4t','moto2t'):
        for t in r['approvals']:
            A.append(f"INSERT INTO product_approvals (product_id,approval) SELECT id,{q(t[:100])} FROM products WHERE article={q(r['article'])} ON CONFLICT DO NOTHING;"); cnt+=1
A.append("COMMIT;"); open('approvals-import.sql','w',encoding='utf-8').write('\n'.join(A)+'\n')
print(cnt,len(issues))
import openpyxl
from openpyxl.styles import Font,PatternFill,Alignment
wb=openpyxl.Workbook(); w=wb.active; w.title='Товары'
w.append(['Артикул','Название в магазине','Раздел','Вязкость','Фасовка','Закупка (опт), ₽','Цена в магазине, ₽ (+50%)','Активен в магазине'])
for r in rows: w.append([r['article'],r['name'],r['cat_ru'],r['sae'],r['pack_raw'],r['cost'],r['price'],'да' if r['active'] else 'нет'])
w2=wb.create_sheet('Допуски'); w2.append(['Артикул','Товар','Допуски, как разобраны (проверьте!)','Исходный текст спецификаций'])
for r in rows:
    if r['approvals']: w2.append([r['article'],r['name'],'; '.join(r['approvals']),r['specs'][-600:]])
w3=wb.create_sheet('Ошибки прайса'); w3.append(['Строка в прайсе','Артикул','Товар','Фасовка','Опт','Розница в прайсе','Взято в магазин','Что не так'])
for i in issues: w3.append(list(i))
for s in wb:
    for c in s[1]: c.font=Font(bold=True,color='FFFFFF'); c.fill=PatternFill('solid',fgColor='101B4D')
    s.freeze_panes='A2'
    for col,wd in zip('ABCDEFGH',[12,55,28,16,20,18,22,40]): s.column_dimensions[col].width=wd
w2.column_dimensions['C'].width=70; w2.column_dimensions['D'].width=70
for row in w2.iter_rows(min_row=2):
    for c in row: c.alignment=Alignment(wrap_text=True,vertical='top')
wb.save('catalog-santrip.xlsx')
for i in issues: print(i)
for r in rows[85:92:2]+rows[150:152]: print(r['name'],r['approvals'])
