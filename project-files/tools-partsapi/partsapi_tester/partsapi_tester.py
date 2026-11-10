#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Проверка PartsAPI: мини-приложение для подбора масла по своей машине.

Зачем: отдельно от магазина проверить ключи PartsAPI и примеры кода с их сайта.
Запуск:  py partsapi_tester.py   (Windows)   или   python3 partsapi_tester.py
Откроется страница в браузере (адрес 127.0.0.1 — только на вашем компьютере).

Безопасность:
 - ключи вводятся в форму и хранятся ТОЛЬКО в памяти, пока программа запущена; на диск не пишутся;
 - в отчёте и на экране ключи заменены на «abc…yz»;
 - сервер слушает только 127.0.0.1 и требует случайный токен запуска;
 - используется только стандартная библиотека Python, ничего устанавливать не нужно.
"""
import json, os, re, secrets, shutil, subprocess, sys, threading, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse
from urllib.request import Request, urlopen

BASE = os.environ.get('PARTSAPI_BASE', 'https://api.partsapi.ru')   # переменная нужна только для автотестов
METHODS = ['VINdecode', 'getMakes', 'getModels', 'getCars', 'GetFillVolumes', 'toDopusk']
KEYS = {}            # метод -> ключ (только в памяти)
TOKEN = secrets.token_urlsafe(16)
REPORT = []          # строки отчёта (ключи замаскированы)
COUNTS = {}          # сколько запросов отправлено в этом запуске
LOCK = threading.Lock()


# ---------- вспомогательное ----------
def mask_value(v):
    v = str(v)
    return v if len(v) <= 6 else v[:3] + '…' + v[-2:]


def mask(text):
    """Прячет ключи в любом тексте: известные значения и параметр key=..."""
    text = str(text)
    for k in set(KEYS.values()):
        if k and len(k) >= 6:
            text = text.replace(k, mask_value(k))
    return re.sub(r'(?i)(\bkey=)([^&\s"\'<>]+)', lambda m: m.group(1) + mask_value(m.group(2)), text)


def log(line):
    with LOCK:
        REPORT.append(mask(line))


def fetch_text(url, method):
    """GET с повторами: PartsAPI иногда обрывает соединение (SSL EOF). 3 попытки, затем запасной способ через curl."""
    last, tries = None, 0
    for i in range(3):
        tries += 1
        with LOCK:
            COUNTS[method] = COUNTS.get(method, 0) + 1
        try:
            with urlopen(Request(url, headers={'User-Agent': 'partsapi-tester/1.0', 'Connection': 'close'}), timeout=40) as r:
                return r.status, r.read().decode('utf-8', 'replace'), tries, 'python', None
        except HTTPError as e:
            return e.code, e.read().decode('utf-8', 'replace'), tries, 'python', None
        except (URLError, TimeoutError, OSError) as e:
            last = e
            log(f'{method}: попытка {tries} из 3 не удалась: {e}')
            time.sleep(1 + i)
    exe = shutil.which('curl') or shutil.which('curl.exe')
    if exe:
        tries += 1
        with LOCK:
            COUNTS[method] = COUNTS.get(method, 0) + 1
        try:
            p = subprocess.run([exe, '-sS', '--max-time', '40', '-w', '\n%{http_code}', url], capture_output=True, timeout=60)
            out = p.stdout.decode('utf-8', 'replace')
            body, _, code = out.rpartition('\n')
            if code.strip().isdigit() and int(code) > 0:
                return int(code), body, tries, 'curl', None
            last = p.stderr.decode('utf-8', 'replace').strip() or last
        except (OSError, subprocess.SubprocessError) as e:
            last = e
    return None, '', tries, None, last


def call(method, params, key=None):
    """Один запрос к PartsAPI. Возвращает словарь с кодом, временем и ответом."""
    key = key or KEYS.get(method)
    if not key:
        return {'ok': False, 'error': f'Не задан ключ для метода {method}. Введите его на вкладке «Ключи».'}
    q = {'method': method, 'key': key, **{k: v for k, v in params.items() if k not in ('method', 'key') and v not in (None, '')}}
    url = BASE + '?' + urlencode(q)
    t0 = time.time()
    status, body, tries, via, err = fetch_text(url, method)
    if status is None:
        hint = ('Сервер PartsAPI несколько раз оборвал соединение (SSL EOF). Это сбой на их стороне или в вашей сети: '
                'попробуйте через минуту, с другого интернета (например, мобильного) или при отключённом антивирусе/VPN.')
        res = {'ok': False, 'url': mask(url), 'tries': tries, 'error': mask(f'Нет связи с PartsAPI после {tries} попыток: {err}. {hint}')}
        log(f'{method} {mask(url)} -> ОШИБКА СЕТИ после {tries} попыток: {mask(err)}')
        return res
    ms = int((time.time() - t0) * 1000)
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    res = {'ok': status == 200 and data is not None, 'status': status, 'ms': ms, 'url': mask(url), 'data': data, 'tries': tries, 'via': via,
           'text': None if data is not None else mask(body[:2000]), 'shape': shape(data)}
    log(f'{method} {mask(url)} -> HTTP {status}, {ms} мс, {res["shape"]}' + (f', попыток: {tries}' if tries > 1 else '') + (', через curl' if via == 'curl' else ''))
    return res


def shape(d):
    if d is None: return 'не JSON'
    if isinstance(d, list): return f'список из {len(d)}'
    if isinstance(d, dict): return 'объект: ' + (', '.join(list(d.keys())[:8]) or 'пустой')
    return str(d)[:80]


# ---------- разбор ответов ----------
UNITS = {'liter': 'л', 'л.': 'л', 'gramme': 'г', 'гр.': 'г', 'cm³': 'см³'}


def summarize_fill(d):
    rows, seen = [], set()
    for r in d if isinstance(d, list) else []:
        unit = UNITS.get(r.get('fillUnit'), r.get('fillUnit') or '')
        row = (r.get('fillTitle') or '', r.get('fillInfo') or '', unit, str(r.get('fillVolume', '')).strip())
        if row not in seen:
            seen.add(row); rows.append(row)
    return [{'title': a, 'info': b, 'unit': c, 'value': v} for a, b, c, v in rows]


def summarize_dop(d):
    d = d if isinstance(d, dict) else {}
    specs = []
    for s in d.get('specifications') or []:
        vals = []
        for p in s.get('properties') or []:
            vals += [str(v) for v in p.get('values') or []]
        specs.append({'name': s.get('name'), 'values': vals})
    oils = []
    for g in d.get('oils') or []:
        oils.append({'group': g.get('group'), 'items': [
            {'article': i.get('artNumber'), 'brand': i.get('manufactureName'), 'name': i.get('originalName'), 'volume': i.get('volume')}
            for i in g.get('items') or []]})
    return {'specifications': specs, 'oils': oils}


def check_id(car_id):
    """Главная проверка: объёмы заправки и допуски для одного номера машины."""
    f = call('GetFillVolumes', {'carId': car_id})
    d = call('toDopusk', {'typeId': car_id})
    keep = ('ok', 'status', 'ms', 'url', 'shape', 'error', 'text', 'tries', 'via')
    out = {'car_id': car_id, 'fill_call': {k: f.get(k) for k in keep}, 'dop_call': {k: d.get(k) for k in keep}}
    out['fill'] = summarize_fill(f.get('data')) if f.get('ok') else []
    out['dopusk'] = summarize_dop(d.get('data')) if d.get('ok') else {'specifications': [], 'oils': []}
    n_f, n_s, n_o = len(out['fill']), len(out['dopusk']['specifications']), len(out['dopusk']['oils'])
    if not f.get('ok') or not d.get('ok'):
        out['verdict'] = 'ОШИБКА ЗАПРОСА: смотрите коды и сообщения ниже (возможно, неверный ключ, исчерпан лимит 50 в сутки или нет связи).'
    elif n_f == 0 and n_s == 0 and n_o == 0:
        out['verdict'] = 'PartsAPI ответил, но данных по этому номеру нет (пустой ответ на оба метода).'
    else:
        out['verdict'] = f'Данные есть: объёмов {n_f}, групп допусков {n_s}, групп масел {n_o}.'
    log(f'ПРОВЕРКА ID {car_id}: {out["verdict"]}')
    return out


def parse_pasted(text):
    """Достаёт адреса api.partsapi.ru из любого вставленного кода (curl, JS, PHP, Python, ссылка)."""
    found = []
    for u in re.findall(r'https?://api\.partsapi\.ru/?\?[^\s"\'`<>)\\]*', text or ''):
        q = dict(parse_qsl(urlparse(u).query, keep_blank_values=True))
        if 'method' in q:
            found.append(q)
    if not found:   # просто строка параметров: method=...&carId=...
        m = re.search(r'method=[^\s"\'`<>]+', text or '')
        if m:
            found.append(dict(parse_qsl(text[m.start():].split()[0], keep_blank_values=True)))
    out = []
    for q in found:
        key = q.pop('key', None)
        out.append({'method': q.pop('method', ''), 'params': q, 'has_key': bool(key), 'key_masked': mask_value(key) if key else '',
                    '_key': key})
    return out


# ---------- веб-сервер ----------
HTML = r"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Проверка PartsAPI</title><style>
:root{--navy:#101B4D;--cy:#00AFC7;--line:#E1E5EE;--mut:#6B7390;--bg:#F3F5F9}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 Inter,Arial,sans-serif;background:var(--bg);color:#25282B}
header{background:var(--navy);color:#fff;padding:14px 20px}header b{font-size:18px}header span{color:#9fb0e6;margin-left:10px;font-size:13px}
main{max-width:980px;margin:0 auto;padding:16px}
nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}nav button{border:1.5px solid var(--line);background:#fff;border-radius:10px;padding:9px 14px;font-weight:600;cursor:pointer;color:var(--navy)}
nav button.on{background:var(--navy);color:#fff;border-color:var(--navy)}
section{display:none;background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px}section.on{display:block}
label{display:block;font-size:13px;color:var(--mut);margin:10px 0 4px}input,select,textarea{width:100%;padding:10px 12px;border:1.5px solid var(--line);border-radius:10px;font:inherit}
textarea{min-height:110px;font-family:Consolas,monospace;font-size:13px}
.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:220px}
button.go{margin-top:12px;background:var(--navy);color:#fff;border:0;border-radius:10px;padding:11px 18px;font-weight:700;cursor:pointer}button.go.alt{background:#fff;color:var(--navy);border:1.5px solid var(--navy)}
.note{font-size:13px;color:var(--mut)}.ok{background:#E8F6EF;color:#155E3B;padding:10px 12px;border-radius:10px;margin-top:12px}.bad{background:#FDECEA;color:#8C1D18;padding:10px 12px;border-radius:10px;margin-top:12px}.warn{background:#FFF6E5;color:#6B4A00;padding:10px 12px;border-radius:10px;margin-top:12px}
table{border-collapse:collapse;width:100%;margin-top:8px;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--mut);font-weight:600}
pre{background:#101B4D;color:#d8e2ff;padding:12px;border-radius:10px;overflow:auto;max-height:340px;font-size:12.5px}
.chip{display:inline-block;background:#E5F7FA;color:#00707F;border-radius:99px;padding:2px 10px;margin:2px 4px 2px 0;font-size:13px}
h3{margin:18px 0 4px;color:var(--navy)}details{margin-top:10px}
</style></head><body>
<header><b>Проверка PartsAPI</b><span>запросов в этом запуске: <i id="cnt">0</i> (лимит сайта — 50 в сутки на метод)</span></header>
<main>
<nav id="nav"></nav>

<section id="t-keys"><p class="note">Каждый метод PartsAPI имеет свой ключ. Ключи хранятся только в памяти этой программы и не сохраняются на диск.</p>
<label><input type="checkbox" id="one" style="width:auto"> один и тот же ключ для всех методов</label>
<div id="keyf"></div><button class="go" onclick="saveKeys()">Сохранить ключи</button><div id="keymsg"></div></section>

<section id="t-vin"><label>VIN (17 символов)</label><input id="vin" maxlength="17" placeholder="Z94PF814DNR028869" style="text-transform:uppercase">
<button class="go" onclick="byVin()">Найти машину по VIN</button><div id="vinout"></div></section>

<section id="t-car"><div class="row"><div><label>Марка</label><select id="mk" onchange="loadModels()"></select></div>
<div><label>Модель</label><select id="md" onchange="loadCars()"></select></div></div>
<div id="carmsg"></div><label>Модификация</label><select id="cr"></select>
<button class="go" onclick="loadMakes()">Загрузить марки</button> <button class="go alt" onclick="checkSel()">Проверить объёмы и допуски</button>
<div id="carout"></div></section>

<section id="t-id"><label>Номер машины (CAR_ID из каталога / carId из VIN)</label><input id="cid" placeholder="например, 145603">
<button class="go" onclick="checkId(val('cid'),'idout')">Проверить объёмы и допуски</button>
<p class="note">Запросит GetFillVolumes (carId) и toDopusk (typeId) — 2 запроса.</p><div id="idout"></div></section>

<section id="t-code"><p class="note">Вставьте сюда пример кода или ссылку с сайта PartsAPI (curl, JavaScript, PHP, Python — что угодно, где есть адрес api.partsapi.ru). Программа достанет метод и параметры, а ключ возьмёт из вставленного кода или со вкладки «Ключи».</p>
<textarea id="code" placeholder="curl 'https://api.partsapi.ru/?method=GetFillVolumes&key=...&carId=145603'"></textarea>
<button class="go" onclick="parseCode()">Разобрать</button><div id="codeparsed"></div><div id="codeout"></div></section>

<section id="t-rep"><p class="note">Ход всех запросов (ключи скрыты). Скопируйте и пришлите мне в чат.</p>
<button class="go" onclick="loadReport()">Обновить</button> <button class="go alt" onclick="copyReport()">Скопировать</button><pre id="rep"></pre></section>
</main>
<script>
const TOKEN="__TOKEN__", M=["VINdecode","getMakes","getModels","getCars","GetFillVolumes","toDopusk"];
const TABS=[["keys","1. Ключи"],["vin","2. По VIN"],["car","3. По марке и модели"],["id","4. По номеру машины"],["code","5. Код с сайта PartsAPI"],["rep","Отчёт"]];
const $=id=>document.getElementById(id), val=id=>$(id).value.trim();
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function api(path,body){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-Token":TOKEN},body:JSON.stringify(body||{})});const j=await r.json();$("cnt").textContent=j._count??$("cnt").textContent;return j}
function tab(n){TABS.forEach(([k])=>{$("t-"+k).classList.toggle("on",k===n)});[...$("nav").children].forEach((b,i)=>b.classList.toggle("on",TABS[i][0]===n));if(n==="rep")loadReport()}
$("nav").innerHTML=TABS.map(([k,t])=>`<button onclick="tab('${k}')">${t}</button>`).join("");
$("keyf").innerHTML=M.map(m=>`<label>${m}</label><input type="password" id="k_${m}" autocomplete="off" placeholder="ключ метода ${m}">`).join("");
$("one").onchange=()=>{ if($("one").checked){const f=M.map(m=>val("k_"+m)).find(Boolean)||"";M.forEach(m=>$("k_"+m).value=f)} };
async function saveKeys(){const k={};M.forEach(m=>{const v=val("k_"+m);if(v)k[m]=v});if($("one").checked){const f=Object.values(k)[0];if(f)M.forEach(m=>k[m]=f)}
 const j=await api("/api/keys",{keys:k});$("keymsg").innerHTML=`<div class="ok">Сохранено ключей: ${j.saved.length} (${esc(j.saved.map(x=>x[0]+": "+x[1]).join(", "))})</div>`}
function showCall(c){const cls=c.ok?"ok":"bad";const extra=(c.tries>1?` · попыток: ${c.tries}`:"")+(c.via==="curl"?" · через curl":"");return `<div class="${cls}">${c.ok?"Ответ получен":"Проблема"}: ${esc(c.error||("HTTP "+c.status+", "+c.ms+" мс, "+c.shape))}${esc(extra)}</div>`}
function table(rows,cols){if(!rows.length)return'<p class="note">пусто</p>';return"<table><tr>"+cols.map(c=>`<th>${c[1]}</th>`).join("")+"</tr>"+rows.map(r=>"<tr>"+cols.map(c=>`<td>${esc(r[c[0]])}</td>`).join("")+"</tr>").join("")+"</table>"}
function renderCheck(o){let h=`<div class="${/Данные есть/.test(o.verdict)?"ok":/пустой/.test(o.verdict)?"warn":"bad"}"><b>${esc(o.verdict)}</b></div>`;
 h+=`<h3>GetFillVolumes (carId=${esc(o.car_id)})</h3>`+showCall(o.fill_call)+table(o.fill,[["title","Что"],["info","Уточнение"],["value","Объём"],["unit","Ед."]]);
 h+=`<h3>toDopusk (typeId=${esc(o.car_id)})</h3>`+showCall(o.dop_call);
 h+=table(o.dopusk.specifications.map(s=>({name:s.name,values:s.values.join(", ")})),[["name","Жидкость"],["values","Допуски"]]);
 if(o.dopusk.oils.length)h+="<h3>Рекомендованные масла и артикулы</h3>"+o.dopusk.oils.map(g=>`<p><b>${esc(g.group)}</b></p>`+table(g.items,[["brand","Бренд"],["article","Артикул"],["name","Название"],["volume","Фасовка"]])).join("");
 return h}
async function checkId(id,out){if(!/^\d+$/.test(id)){$(out).innerHTML='<div class="bad">Нужен номер из цифр.</div>';return}
 $(out).innerHTML='<p class="note">Запрашиваю…</p>';const j=await api("/api/check",{id});$(out).innerHTML=renderCheck(j)}
async function byVin(){const v=val("vin").toUpperCase();if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)){$("vinout").innerHTML='<div class="bad">VIN: 17 символов, латиница и цифры, без I, O, Q.</div>';return}
 $("vinout").innerHTML='<p class="note">Запрашиваю…</p>';const j=await api("/api/call",{method:"VINdecode",params:{vin:v,lang:"ru"}});let h=showCall(j);
 const r=j.data&&j.data.result&&j.data.result["0"];
 if(r){h+=`<div class="ok"><b>${esc(r.manuName)} ${esc(r.modelName)} ${esc(r.typeName)}</b><br>carId: ${esc(r.carId)}, typeNumber: ${esc(r.typeNumber)}, годы: ${esc(r.yearOfConstrFrom)}–${esc(r.yearOfConstrTo)}</div><div id="vinchk"></div>`;$("vinout").innerHTML=h;await checkId(String(r.carId||r.typeNumber),"vinchk")}
 else{h+=`<div class="warn">PartsAPI не знает этот VIN${/^Z94|^XTA|^X7|^XW|^XU/.test(v)?" (российская сборка — это ожидаемо)":""}. Выберите машину на вкладке «По марке и модели».</div><details><summary>Сырой ответ</summary><pre>${esc(JSON.stringify(j.data,null,2)||j.text)}</pre></details>`;$("vinout").innerHTML=h}}
function fill(sel,items,v,l,ph){$(sel).innerHTML=`<option value="">${ph}</option>`+items.map(i=>`<option value="${esc(i[v])}">${esc(i[l])}</option>`).join("")}
async function loadMakes(){$("carmsg").innerHTML='<p class="note">Загружаю марки…</p>';const j=await api("/api/call",{method:"getMakes",params:{carType:"PC"}});$("carmsg").innerHTML=showCall(j);if(Array.isArray(j.data))fill("mk",j.data,"makeId","makeName","Выберите марку")}
async function loadModels(){if(!val("mk"))return;$("carmsg").innerHTML='<p class="note">Загружаю модели (до 40 секунд)…</p>';const j=await api("/api/call",{method:"getModels",params:{carType:"PC",makeId:val("mk"),lang:"16"}});$("carmsg").innerHTML=showCall(j);if(Array.isArray(j.data))fill("md",j.data.map(m=>({id:m.modelId,n:m.modelName||m.shortModelName||m.modelname})),"id","n","Выберите модель")}
async function loadCars(){if(!val("md"))return;$("carmsg").innerHTML='<p class="note">Загружаю модификации…</p>';const j=await api("/api/call",{method:"getCars",params:{carType:"PC",makeId:val("mk"),modelId:val("md")}});$("carmsg").innerHTML=showCall(j);
 if(Array.isArray(j.data))fill("cr",j.data.map(c=>({id:c.CAR_ID,n:`${c.CAR_NAME}, ${c.CAPACITY||""}, ${Math.round(c.POWER_PS||0)} л.с. [CAR_ID ${c.CAR_ID}]`})),"id","n","Выберите модификацию")}
function checkSel(){if(!val("cr")){$("carout").innerHTML='<div class="bad">Выберите марку, модель и модификацию.</div>';return}$("carout").innerHTML='<div id="carchk"></div>';checkId(val("cr"),"carchk")}
async function parseCode(){const j=await api("/api/parse",{text:$("code").value});
 if(!j.items.length){$("codeparsed").innerHTML='<div class="bad">Не нашёл адрес api.partsapi.ru с параметром method. Вставьте ссылку или код целиком.</div>';return}
 window._items=j.items;$("codeparsed").innerHTML=j.items.map((it,i)=>`<h3>Найден запрос: ${esc(it.method)}</h3><label>Параметры (по одному в строке, без ключа)</label>
 <textarea id="p${i}" style="min-height:70px">${esc(Object.entries(it.params).map(([k,v])=>k+"="+v).join("\n"))}</textarea>
 <p class="note">Ключ: ${it.has_key?"взят из кода ("+esc(it.key_masked)+")":"в коде не найден — будет использован ключ из вкладки «Ключи»"}</p>
 <button class="go" onclick="runItem(${i})">Выполнить</button>`).join("")}
async function runItem(i){const it=window._items[i];const params={};$("p"+i).value.split("\n").forEach(l=>{const m=l.match(/^\s*([^=\s]+)\s*=(.*)$/);if(m)params[m[1]]=m[2].trim()});
 $("codeout").innerHTML='<p class="note">Запрашиваю…</p>';const j=await api("/api/call",{method:it.method,params,item:i,use_pasted_key:true});
 let h=showCall(j);if(j.data!==undefined&&j.data!==null)h+=`<pre>${esc(JSON.stringify(j.data,null,2).slice(0,20000))}</pre>`;else if(j.text)h+=`<pre>${esc(j.text)}</pre>`;$("codeout").innerHTML=h}
async function loadReport(){const j=await api("/api/report");$("rep").textContent=j.text||"(пока пусто)"}
function copyReport(){navigator.clipboard.writeText($("rep").textContent)}
tab("keys");
</script></body></html>"""


class H(BaseHTTPRequestHandler):
    server_version = 'PartsApiTester'
    pasted = {}   # индекс найденного запроса -> ключ из вставленного кода (только в памяти)

    def log_message(self, *a):
        pass

    def _host_ok(self):
        host = (self.headers.get('Host') or '').split(':')[0]
        return host in ('127.0.0.1', 'localhost')

    def _send(self, code, body, ctype='application/json; charset=utf-8'):
        b = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, 'forbidden', 'text/plain')
        if self.path.split('?')[0] != '/':
            return self._send(404, 'not found', 'text/plain')
        self._send(200, HTML.replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8')

    def do_POST(self):
        if not self._host_ok() or self.headers.get('X-Token') != TOKEN:
            return self._send(403, '{"error":"forbidden"}')
        try:
            n = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(min(n, 1_000_000)) or b'{}')
        except ValueError:
            return self._send(400, '{"error":"bad json"}')
        path = self.path
        if path == '/api/keys':
            for m, k in (body.get('keys') or {}).items():
                if m in METHODS and isinstance(k, str) and k.strip():
                    KEYS[m] = k.strip()
            out = {'saved': [[m, mask_value(k)] for m, k in KEYS.items()]}
        elif path == '/api/call':
            method = str(body.get('method') or '')
            params = {str(k): str(v) for k, v in (body.get('params') or {}).items()}
            key = H.pasted.get(body.get('item')) if body.get('use_pasted_key') else None
            out = call(method, params, key)
        elif path == '/api/check':
            out = check_id(str(body.get('id') or ''))
        elif path == '/api/parse':
            items = parse_pasted(str(body.get('text') or ''))
            H.pasted = {i: it.pop('_key') for i, it in enumerate(items) if it.get('_key')}
            for it in items:
                it.pop('_key', None)
            out = {'items': items}
        elif path == '/api/report':
            out = {'text': '\n'.join(REPORT)}
        else:
            return self._send(404, '{"error":"not found"}')
        out['_count'] = sum(COUNTS.values())
        self._send(200, json.dumps(out, ensure_ascii=False))


def main():
    port = int(os.environ.get('PORT', '8765'))
    srv = None
    for p in range(port, port + 20):
        try:
            srv = ThreadingHTTPServer(('127.0.0.1', p), H)
            port = p
            break
        except OSError:
            continue
    if not srv:
        sys.exit('Не удалось занять порт. Закройте другие копии программы.')
    url = f'http://127.0.0.1:{port}/'
    print('Проверка PartsAPI запущена:', url)
    print('Чтобы остановить — закройте это окно или нажмите Ctrl+C.')
    if not os.environ.get('NO_BROWSER'):
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
