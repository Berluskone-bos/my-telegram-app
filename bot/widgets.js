'use strict';
// Интерактивные карточки Telegram (Bot API 10.4, «виджеты»): трекер заказа, маршрутный лист, сводка дня.
//
// Как это устроено:
//   • HTML карточки статичный и маленький (сжатый ≤ 4096 байт — лимит Telegram), всё меняющееся лежит в chat_data (≤ 1024 байт JSON).
//   • Бот меняет карточку методом editMessageWidgetData — уведомление клиенту при этом НЕ приходит (поэтому «приехал» и «доставлен» по-прежнему идут обычным сообщением).
//   • Нажатие в карточке приходит боту как update.widget_query с короткой строкой (например "rate:5").
//   • Выключатель: переменная Railway WIDGETS_ENABLED=0 возвращает старые обычные сообщения.
//   • Если Telegram отклонил карточку, отправка автоматически заменяется обычным сообщением (см. notify-queue.js).
//
// Ограничения виджетов (из руководства Telegram): нет color-mix(), vh/vw, прокрутки, полей ввода, сети, SVG в data-URL, только системные шрифты.
// Цвета берём из темы пользователя (--tg-theme-*), акцент фирменный бирюзовый #00AFC7.
const zlib = require('zlib');

const MAX_HTML = 32768;
const MAX_HTML_ZIPPED = 4096;
const MAX_DATA = 1024;
const BRAND = '#00AFC7';

// Автопауза: с 13.11.2026 Telegram отвечает обычным ботам «INPUT_MEDIA_WIDGET_NOT_ALLOWED» (карточки им пока не разрешены).
// Получив такой ответ, на время паузы не пробуем отправлять карточки (всё идёт обычными сообщениями), потом пробуем снова —
// если Telegram разрешит, карточки заработают сами. Пауза хранится в памяти процесса (после перезапуска — одна лишняя попытка).
const PAUSE_MS = 6 * 3600e3;
let pausedUntil = 0;
const widgetsEnabled = () => String(process.env.WIDGETS_ENABLED || '1').trim() !== '0' && Date.now() >= pausedUntil;
const isNotAllowedError = (e) => /WIDGET_NOT_ALLOWED/i.test(String((e && e.message) || e || ''));
function pauseWidgets(ms = PAUSE_MS) { pausedUntil = Date.now() + ms; }
function resumeWidgets() { pausedUntil = 0; }
const widgetsPausedUntil = () => pausedUntil;

const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const zippedSize = (html) => zlib.deflateSync(Buffer.from(html, 'utf8'), { level: 9 }).length;
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

// Проверка перед отправкой: не превышены ли лимиты Telegram. Бросает понятную ошибку.
function checkWidget(w) {
    if (byteLen(w.html) > MAX_HTML) throw new Error(`виджет: HTML ${byteLen(w.html)} Б > ${MAX_HTML}`);
    const z = zippedSize(w.html);
    if (z > MAX_HTML_ZIPPED) throw new Error(`виджет: HTML в сжатом виде ${z} Б > ${MAX_HTML_ZIPPED}`);
    if (typeof w.chat_data !== 'string') throw new Error('виджет: chat_data должен быть строкой JSON');
    if (byteLen(w.chat_data) > MAX_DATA) throw new Error(`виджет: chat_data ${byteLen(w.chat_data)} Б > ${MAX_DATA}`);
    return { html: byteLen(w.html), zipped: z, data: byteLen(w.chat_data) };
}

// Обрезка строки по байтам (кириллица — 2 байта на символ), чтобы chat_data точно влез
function clip(s, maxChars) {
    s = String(s === null || s === undefined ? '' : s);
    return s.length > maxChars ? s.slice(0, Math.max(0, maxChars - 1)) + '…' : s;
}

// Если данные не влезают — убираем длинные поля по очереди, а не падаем
function fitData(obj, shrinkers = []) {
    let json = JSON.stringify(obj);
    for (const f of shrinkers) {
        if (byteLen(json) <= MAX_DATA) break;
        f(obj);
        json = JSON.stringify(obj);
    }
    if (byteLen(json) > MAX_DATA) throw new Error(`виджет: chat_data ${byteLen(json)} Б не удалось уместить в ${MAX_DATA}`);
    return json;
}

// Общие стили: системный шрифт, цвета темы Telegram, никаких запрещённых функций.
const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;padding:12px;font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.35;
color:var(--tg-theme-text-color,#222);background:var(--tg-theme-bg-color,#fff)}
.t{font-weight:700;font-size:16px}
.s{color:var(--tg-theme-hint-color,#888);font-size:13px}
.b{display:inline-block;padding:3px 10px;border-radius:12px;background:${BRAND};color:#fff;font-weight:600;font-size:13px}
.b.g{background:var(--tg-theme-hint-color,#999)}
.b.r{background:#d64545}
.b.ok{background:#2e9e57}
.row{padding:8px 0;border-top:1px solid var(--tg-theme-section-separator-color,#e5e5e5)}
.bar{height:6px;border-radius:3px;background:var(--tg-theme-section-separator-color,#e5e5e5);margin:10px 0}
.bar i{display:block;height:6px;border-radius:3px;background:${BRAND}}
.st{display:inline-block;font-size:28px;line-height:1;padding:2px 4px;color:var(--tg-theme-hint-color,#bbb)}
.st.on{color:#f5a623}
`.replace(/\n/g, '');

const SHELL = (body, script) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}</style><body>${body}<script>${script}</script>`;

// ───────────────────────── Трекер заказа (клиент) ─────────────────────────
// chat_data: { n: номер, s: шаг 0..4, st: ярлык, c: курьер, e: «через ~20 мин (около 14:35)», r: оценка 0..5, x: 1 если отменён, f: 1 если можно оценивать }
const TRACKER_STEPS = ['Принят', 'Собираем', 'В пути', 'Приехал', 'Доставлен'];

const TRACKER_HTML = SHELL(
    `<div class="t" id="n"></div><div class="s" id="c"></div><div class="bar"><i id="p"></i></div>` +
    `<div><span class="b" id="b"></span></div><div class="s" id="e" style="margin-top:6px"></div><div id="r" class="row" style="display:none"><div class="s">Оцените доставку</div><div id="stars"></div></div>`,
    `var W=window.TelegramWidget,N=['Принят','Собираем','В пути','Приехал','Доставлен'];` +
    `function g(i){return document.getElementById(i)}` +
    `function draw(){var d=W.chatData||{};if(typeof d==='string'){try{d=JSON.parse(d)}catch(e){d={}}}` +
    `g('n').textContent='Заказ '+(d.n||'');g('c').textContent=d.c?'Курьер: '+d.c:'';` +
    `var s=d.s||0;g('p').style.width=(d.x?0:Math.min(100,(s+1)*20))+'%';` +
    `var b=g('b');b.textContent=d.x?'Отменён':(d.st||N[s]);b.className='b'+(d.x||d.z?' r':(s>=4?' ok':''));` +
    `g('e').textContent=d.x?'':(d.e||'');` +
    `var r=g('r');r.style.display=d.f&&!d.x?'block':'none';var h='';` +
    `for(var i=1;i<=5;i++){h+='<span class="st'+(i<=(d.r||0)?' on':'')+'" data-i="'+i+'">★</span>'}` +
    `g('stars').innerHTML=h;}` +
    `document.addEventListener('click',function(ev){var t=ev.target;if(t&&t.getAttribute&&t.getAttribute('data-i')){W.request('rate:'+t.getAttribute('data-i'))}});` +
    `draw();W.onEvent('chatDataChanged',draw);`
);

// extra — { stage, courier, eta, rating, canRate }
// stage: 'accepted' | 'assembling' | 'shipping' | 'enroute' | 'arrived' | 'delivered' | 'failed' | 'cancelled'
function trackerState(orderNumber, extra = {}) {
    const stageIdx = { accepted: 0, assembling: 1, shipping: 2, enroute: 2, arrived: 3, delivered: 4, cancelled: 0, failed: 2 };
    const stage = extra.stage || 'accepted';
    const labels = { accepted: 'Принят', assembling: 'Собираем', shipping: 'Курьер назначен', enroute: 'В пути', arrived: 'Курьер приехал', delivered: 'Доставлен', cancelled: 'Отменён', failed: 'Не доставлен' };
    const d = { n: clip(orderNumber, 20), s: stageIdx[stage] ?? 0, st: labels[stage] || labels.accepted };
    if (extra.courier) d.c = clip(extra.courier, 30);
    if (extra.eta) d.e = clip(extra.eta, 50);
    if (extra.rating) d.r = Number(extra.rating) || 0;
    if (stage === 'cancelled') d.x = 1;
    if (stage === 'failed') d.z = 1;
    if (stage === 'delivered' && extra.canRate !== false) d.f = 1;
    return d;
}

function trackerWidget(orderNumber, extra = {}) {
    const d = trackerState(orderNumber, extra);
    return {
        html: TRACKER_HTML,
        chat_data: fitData(d, [(o) => delete o.e, (o) => delete o.c]),
        caption: `Заказ ${clip(orderNumber, 20)}: ${d.st}`,
        allow_queries: true
    };
}

// Текст-запасной вариант (если виджеты выключены или Telegram отклонил карточку)
function trackerFallbackText(orderNumber, extra = {}) {
    const d = trackerState(orderNumber, extra);
    const lines = [`<b>Заказ ${esc(orderNumber)}</b>`, '', `Статус: <b>${esc(d.st)}</b>`];
    if (d.c) lines.push(`Курьер: ${esc(d.c)}`);
    if (d.e) lines.push(esc(d.e));
    return lines.join('\n');
}

// ───────────────────────── Маршрутный лист (курьер) ─────────────────────────
// chat_data: { r: номер рейса, d: сделано, t: всего, k: [[n, адрес, время "14:35", статус 0 ждёт/1 едем/2 готово/3 не вручён/4 отменён], ...] }
const ROUTE_HTML = SHELL(
    `<div class="t" id="h"></div><div class="bar"><i id="p"></i></div><div id="l"></div>`,
    `var W=window.TelegramWidget;function g(i){return document.getElementById(i)}` +
    `function E(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}` +
    `function draw(){var d=W.chatData||{};if(typeof d==='string'){try{d=JSON.parse(d)}catch(e){d={}}}` +
    `g('h').textContent='Рейс '+(d.r||'')+' · '+(d.d||0)+' из '+(d.t||0);` +
    `g('p').style.width=(d.t?Math.round(100*(d.d||0)/d.t):0)+'%';var k=d.k||[],h='',M=['ждёт','едем','готово','не вручён','отменён'],C=['g','','ok','r','g'];` +
    `for(var i=0;i<k.length;i++){var s=k[i];h+='<div class="row"><div><b>'+(i+1)+'. '+E(s[0])+'</b> <span class="b '+C[s[3]]+'">'+M[s[3]|0]+'</span></div><div class="s">'+E(s[1])+(s[2]?' · '+E(s[2]):'')+'</div></div>'}` +
    `g('l').innerHTML=h;}draw();W.onEvent('chatDataChanged',draw);`
);

function routeSheetData(routeNumber, stops) {
    const st = { pending: 0, in_progress: 1, delivered: 2, failed: 3, cancelled: 4 };
    const done = stops.filter(s => s.status === 'delivered' || s.status === 'failed' || s.status === 'cancelled').length;
    const d = {
        r: clip(routeNumber, 16), d: done, t: stops.length,
        k: stops.map(s => [clip(s.order_number || '', 12), clip(s.address || '', 38), s.clock || '', st[s.status] ?? 0])
    };
    return d;
}

function routeSheetWidget(routeNumber, stops) {
    const d = routeSheetData(routeNumber, stops);
    const shrink = [
        (o) => o.k.forEach(x => { x[1] = clip(x[1], 26); }),
        (o) => o.k.forEach(x => { x[1] = clip(x[1], 16); }),
        (o) => o.k.forEach(x => { x[2] = ''; })
    ];
    return { html: ROUTE_HTML, chat_data: fitData(d, shrink), caption: `Рейс ${clip(routeNumber, 16)}: ${d.d} из ${d.t}`, allow_queries: true };
}

// ───────────────────────── Сводка дня (админ) ─────────────────────────
// chat_data: { a: дата, o: заказов, s: сумма, n: новые, w: в сборке, p: в пути, v: доставлено, x: отменено, u: «обновлено 14:35» }
const SUMMARY_HTML = SHELL(
    `<div class="t" id="h"></div><div class="s" id="u"></div><div id="l"></div>`,
    `var W=window.TelegramWidget;function g(i){return document.getElementById(i)}` +
    `function draw(){var d=W.chatData||{};if(typeof d==='string'){try{d=JSON.parse(d)}catch(e){d={}}}` +
    `g('h').textContent='Сводка за '+(d.a||'');g('u').textContent=d.u||'';` +
    `var R=[['Заказов',d.o],['Сумма, ₽',d.s],['Новые',d.n],['В сборке',d.w],['В пути',d.p],['Доставлено',d.v],['Отменено',d.x]],h='';` +
    `for(var i=0;i<R.length;i++){h+='<div class="row"><b>'+(Number(R[i][1])||0)+'</b> <span class="s">'+R[i][0]+'</span></div>'}` +
    `g('l').innerHTML=h;}draw();W.onEvent('chatDataChanged',draw);`
);

function summaryWidget(sum) {
    const d = {
        a: clip(sum.date, 12), o: Number(sum.orders) || 0, s: Math.round(Number(sum.revenue) || 0),
        n: Number(sum.new) || 0, w: Number(sum.assembling) || 0, p: Number(sum.shipping) || 0,
        v: Number(sum.delivered) || 0, x: Number(sum.cancelled) || 0, u: clip(sum.updated || '', 30)
    };
    return { html: SUMMARY_HTML, chat_data: fitData(d), caption: `Сводка за ${d.a}: заказов ${d.o}, на сумму ${d.s} ₽`, allow_queries: true };
}

function summaryFallbackText(sum) {
    return `<b>Сводка за ${esc(sum.date)}</b>\nЗаказов: ${Number(sum.orders) || 0}, сумма: ${Math.round(Number(sum.revenue) || 0)} ₽\n` +
        `Новые: ${sum.new || 0} · В сборке: ${sum.assembling || 0} · В пути: ${sum.shipping || 0} · Доставлено: ${sum.delivered || 0} · Отменено: ${sum.cancelled || 0}`;
}

module.exports = {
    widgetsEnabled, pauseWidgets, resumeWidgets, widgetsPausedUntil, isNotAllowedError, checkWidget, zippedSize, clip, fitData, esc,
    trackerWidget, trackerState, trackerFallbackText, TRACKER_HTML, TRACKER_STEPS,
    routeSheetWidget, routeSheetData, ROUTE_HTML,
    summaryWidget, summaryFallbackText, SUMMARY_HTML,
    MAX_HTML_ZIPPED, MAX_DATA, BRAND
};
