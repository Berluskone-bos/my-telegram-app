(() => {
    'use strict';

    const style = document.createElement('style');
    style.textContent = `
      .dashboard-wrap{display:grid;gap:18px}
      .dash-clocks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .dash-clock{background:var(--white,#fff);border:1px solid var(--border,#e7eaf0);border-radius:16px;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
      .dash-clock-label{font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.04em;text-transform:uppercase}
      .dash-clock-time{font-size:clamp(22px,3vw,30px);font-weight:750;letter-spacing:-.04em;color:var(--navy,#101B4D);font-variant-numeric:tabular-nums}
      .dash-clock-date{font-size:12px;color:var(--muted);margin-top:3px}
      .dash-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
      .dash-kpi{background:var(--white,#fff);border:1px solid var(--border,#e7eaf0);border-radius:16px;padding:17px;min-width:0}
      .dash-kpi-label{font-size:12px;color:var(--muted);font-weight:600}
      .dash-kpi-value{font-size:clamp(23px,3vw,31px);font-weight:750;color:var(--text,#25282B);letter-spacing:-.04em;margin-top:9px;overflow-wrap:anywhere}
      .dash-kpi-note{font-size:12px;color:var(--muted);margin-top:5px}
      .dash-columns{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,1fr);gap:16px}
      .dash-panel{background:var(--white,#fff);border:1px solid var(--border,#e7eaf0);border-radius:16px;overflow:hidden;min-width:0}
      .dash-panel-head{padding:16px 18px;border-bottom:1px solid var(--border,#e7eaf0);display:flex;align-items:center;justify-content:space-between;gap:10px}
      .dash-panel-title{font-size:14px;font-weight:700;color:var(--text,#25282B)}
      .dash-panel-body{padding:0 18px}
      .dash-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 0;border-bottom:1px solid var(--line,#edf0f4)}
      .dash-row:last-child{border-bottom:0}
      .dash-main{font-size:13px;font-weight:650;color:var(--text,#25282B)}
      .dash-sub{font-size:11px;color:var(--muted);margin-top:4px}
      .dash-value{font-size:13px;font-weight:700;white-space:nowrap;color:var(--text,#25282B);text-align:right}
      .dash-pill{display:inline-flex;border-radius:20px;padding:4px 8px;font-size:10px;font-weight:700;background:rgba(0,175,199,.1);color:#007f91}
      .dash-empty{padding:22px 0;color:var(--muted);font-size:13px;text-align:center}
      .dash-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .dash-toolbar-date{font-size:13px;color:var(--muted)}
      .dash-refresh{border:1px solid var(--border,#e7eaf0);background:var(--white,#fff);border-radius:10px;padding:8px 12px;font:600 12px Inter,sans-serif;cursor:pointer;color:var(--navy,#101B4D)}
      .dash-refresh:hover{border-color:#00AFC7}
      .dash-error{padding:16px;border-radius:12px;background:rgba(220,60,60,.07);color:#a52b2b;font-size:13px}
      .workcal-panel{background:var(--white,#fff);border:1px solid var(--border,#e7eaf0);border-radius:16px;overflow:hidden}
      .workcal-head{padding:16px 18px;border-bottom:1px solid var(--border,#e7eaf0);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .workcal-title{font-size:16px;font-weight:750;color:var(--text,#25282B)}
      .workcal-controls{display:flex;align-items:center;gap:8px}
      .workcal-controls button,.workcal-action{border:1px solid var(--border,#e7eaf0);background:var(--white,#fff);border-radius:9px;padding:8px 11px;color:var(--text,#25282B);font:600 12px Inter,sans-serif;cursor:pointer}
      .workcal-controls button:hover,.workcal-action:hover{border-color:#00AFC7}
      .workcal-month{min-width:150px;text-align:center;font-size:14px;font-weight:700}
      .workcal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));padding:10px;gap:5px}
      .workcal-weekday{text-align:center;color:var(--muted);font-size:11px;font-weight:700;padding:8px 2px}
      .workcal-day{position:relative;min-height:94px;border:1px solid var(--border,#e7eaf0);border-radius:10px;background:var(--white,#fff);padding:7px;text-align:left;cursor:pointer;min-width:0;color:var(--text,#25282B);transition:border-color .15s,background .15s}
      .workcal-hover{display:none;position:absolute;z-index:30;left:0;top:calc(100% + 3px);width:230px;max-width:min(230px,75vw);padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--white);box-shadow:0 12px 28px rgba(0,0,0,.18);font-size:10px;line-height:1.45;color:var(--text);white-space:normal;pointer-events:none}
      .workcal-day:hover .workcal-hover,.workcal-day:focus-visible .workcal-hover{display:grid;gap:4px}
      .workcal-hover b{font-size:11px}
      .workcal-hover-line{overflow-wrap:anywhere}

      .workcal-day:hover{border-color:#00AFC7;background:rgba(0,175,199,.045)}
      .workcal-day.weekend{background:rgba(220,38,38,.075);border-color:rgba(220,38,38,.16)}
      .workcal-day.weekend:hover{background:rgba(220,38,38,.12);border-color:rgba(220,38,38,.32)}
      .workcal-day.weekend.selected{background:rgba(220,38,38,.14);border-color:#00AFC7}
      .workcal-day.other{opacity:.38}.workcal-day.today{border-color:#00AFC7;box-shadow:inset 0 0 0 1px #00AFC7}
      .workcal-day.selected{background:rgba(0,175,199,.09);border-color:#00AFC7}
      .workcal-daynum{font-size:13px;font-weight:750}
      .workcal-daymetrics{display:grid;gap:3px;margin-top:6px;font-size:10px;color:var(--muted);line-height:1.25}
      .workcal-dots{display:flex;gap:3px;flex-wrap:wrap;margin-top:5px}
      .workcal-dot{display:inline-block;box-sizing:border-box;width:6px!important;height:6px!important;min-width:6px;min-height:6px;max-width:6px;max-height:6px;flex:0 0 6px;border-radius:50%;padding:0;margin:0;vertical-align:middle;background:#00AFC7}.workcal-dot.task{background:#d97706}.workcal-dot.meeting{background:#6366f1}.workcal-dot.contract{background:#0d9488}.workcal-dot.logistics{background:#2563eb}.workcal-dot.kpi{background:#9333ea}
      .workcal-legend{display:flex;gap:12px;flex-wrap:wrap;padding:0 18px 14px;color:var(--muted);font-size:11px}
      .workcal-legend span{display:inline-flex;align-items:center;gap:5px}
      .workcal-detail{border-top:1px solid var(--border,#e7eaf0);padding:16px 18px;display:grid;gap:12px}
      .workcal-detail-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
      .workcal-detail-title{font-size:14px;font-weight:750}
      .workcal-daystats{display:flex;gap:8px;flex-wrap:wrap}
      .workcal-stat{background:var(--tint,rgba(0,0,0,.04));border-radius:9px;padding:7px 10px;font-size:11px;color:var(--muted)}
      .workcal-stat b{color:var(--text)}
      .workcal-items{display:grid;gap:8px}
      .workcal-item{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:10px;align-items:start;padding:10px 0;border-bottom:1px solid var(--border,#e7eaf0)}
      .workcal-item:last-child{border-bottom:0}
      .workcal-item-time{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
      .workcal-item-title{font-size:13px;font-weight:700}
      .workcal-item-meta{font-size:11px;color:var(--muted);margin-top:4px;line-height:1.45}
      .workcal-item-actions{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
      .workcal-item-actions button{border:1px solid var(--border);background:var(--white);border-radius:8px;padding:6px 8px;font-size:10px;cursor:pointer;color:var(--text)}
      .workcal-create{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:14px;background:var(--tint,rgba(0,0,0,.03));border-radius:12px}
      .workcal-create label{display:grid;gap:5px;font-size:11px;font-weight:650;color:var(--muted)}
      .workcal-create input,.workcal-create select,.workcal-create textarea{width:100%;min-width:0;border:1px solid var(--border);border-radius:8px;background:var(--white);color:var(--text);padding:9px;font:12px Inter,sans-serif}
      .workcal-create textarea{min-height:64px;resize:vertical}
      .workcal-create .wide{grid-column:1/-1}
      .workcal-create-actions{display:flex;gap:8px;justify-content:flex-end;grid-column:1/-1}
      .workcal-primary{background:#101B4D!important;color:#fff!important;border-color:#101B4D!important}
      .workcal-empty{padding:14px 0;color:var(--muted);font-size:12px}
      @media(max-width:680px){.workcal-grid{gap:3px;padding:6px}.workcal-day{min-height:75px;padding:5px 3px}.workcal-daymetrics{font-size:9px}.workcal-item{grid-template-columns:48px minmax(0,1fr)}.workcal-item-actions{grid-column:2;justify-content:flex-start}.workcal-create{grid-template-columns:1fr}.workcal-create .wide{grid-column:auto}.workcal-create-actions{grid-column:auto}}
      @media(max-width:900px){.dash-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.dash-columns{grid-template-columns:1fr}}
      @media(max-width:560px){.dash-clocks{grid-template-columns:1fr}.dash-kpi{padding:14px}.dash-panel-body{padding:0 13px}}
    `;
    document.head.appendChild(style);

    const nav = document.getElementById('nav');
    if (nav && !nav.querySelector('[data-view="dashboard"]')) {
        nav.insertAdjacentHTML('afterbegin', `
          <button class="nav-item" data-view="dashboard" title="Обзор" onclick="go('dashboard')">
            <span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></svg></span><span class="lbl">Обзор</span>
          </button>`);
    }

    const deliveryTab = document.getElementById('tab-delivery');
    if (deliveryTab && !document.getElementById('tab-dashboard')) {
        deliveryTab.insertAdjacentHTML('beforebegin', `
          <div class="tab-content" id="tab-dashboard">
            <div class="container dashboard-wrap">
              <div class="dash-toolbar">
                <div class="dash-toolbar-date" id="dashBusinessDate">Сводка за сегодня по Москве</div>
                <button class="dash-refresh" type="button" id="dashRefresh">Обновить данные</button>
              </div>
              <div class="dash-clocks">
                <div class="dash-clock"><div><div class="dash-clock-label">Москва · UTC+3</div><div class="dash-clock-time" id="dashMoscowTime">--:--:--</div><div class="dash-clock-date" id="dashMoscowDate">—</div></div><span class="dash-pill">МСК</span></div>
                <div class="dash-clock"><div><div class="dash-clock-label">Камчатка · UTC+12</div><div class="dash-clock-time" id="dashKamchatkaTime">--:--:--</div><div class="dash-clock-date" id="dashKamchatkaDate">—</div></div><span class="dash-pill">+9 часов</span></div>
              </div>
              <div class="dash-kpis" id="dashKpis"><div class="dash-kpi">Загрузка сводки…</div></div>
              <section class="workcal-panel">
                <div class="workcal-head">
                  <div><div class="workcal-title">Рабочий календарь</div><div class="dash-sub">Показатели, задачи, KPI, встречи, договоры и логистика</div></div>
                  <div class="workcal-controls"><button type="button" id="workcalPrev" aria-label="Предыдущий месяц">‹</button><div class="workcal-month" id="workcalMonth">Загрузка…</div><button type="button" id="workcalNext" aria-label="Следующий месяц">›</button><button type="button" id="workcalToday">Сегодня</button></div>
                </div>
                <div class="workcal-grid" id="workcalGrid"><div class="workcal-empty">Загрузка календаря…</div></div>
                <div class="workcal-legend"><span><i class="workcal-dot task"></i> Задачи</span><span><i class="workcal-dot meeting"></i> Встречи</span><span><i class="workcal-dot contract"></i> Договоры</span><span><i class="workcal-dot logistics"></i> Логистика</span><span><i class="workcal-dot kpi"></i> KPI</span></div>
                <div class="workcal-detail" id="workcalDetail"><div class="workcal-empty">Выберите день в календаре, чтобы увидеть его план и показатели.</div></div>
              </section>
              <section class="dash-panel"><div class="dash-panel-head"><div class="dash-panel-title" id="workcalTaskTitle">Мои задачи</div><span class="dash-pill" id="workcalTaskCount">0</span></div><div class="dash-panel-body" id="workcalTaskOverview"><div class="dash-empty">Загрузка задач…</div></div></section>
              <section class="dash-panel"><div class="dash-panel-head"><div class="dash-panel-title">Контроль остатков склада</div><span class="dash-pill" id="dashLowStockCount">0</span></div><div class="dash-panel-body" id="dashLowStock"><div class="dash-empty">Загрузка…</div></div></section>
              <div hidden><span id="dashOrdersCount">0</span><div id="dashRecentOrders"></div></div>
            </div>
          </div>`);
    }

    const fmtTime = (zone) => new Intl.DateTimeFormat('ru-RU', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const fmtDate = (zone) => new Intl.DateTimeFormat('ru-RU', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    function tickClocks() {
        const now = new Date();
        const values = [
            ['Europe/Moscow', 'dashMoscowTime', 'dashMoscowDate'],
            ['Asia/Kamchatka', 'dashKamchatkaTime', 'dashKamchatkaDate']
        ];
        for (const [zone, timeId, dateId] of values) {
            const t = document.getElementById(timeId);
            const d = document.getElementById(dateId);
            if (t) t.textContent = fmtTime(zone).format(now);
            if (d) d.textContent = fmtDate(zone).format(now);
        }
    }
    tickClocks();
    window.setInterval(tickClocks, 1000);

    const rub = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
    const integer = new Intl.NumberFormat('ru-RU');
    const statusNames = { NEW: 'Новый', CONFIRMED: 'Подтверждён', ASSEMBLING: 'Собирается', SHIPPING: 'В доставке', DELIVERY_FAILED: 'Не доставлен', DELIVERED: 'Доставлен', COMPLETED: 'Завершён', CANCELLED: 'Отменён' };
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
    function moscowDateKey() {
        const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
        const v = Object.fromEntries(p.map(x => [x.type, x.value]));
        return v.year + '-' + v.month + '-' + v.day;
    }
    function renderKpis(s) {
        const cards = [
            ['Заказы сегодня', s.orders, s.newOrders + ' новых'],
            ['Выручка сегодня', rub.format(s.revenue), 'Без отменённых заказов'],
            ['Позиций на складе', s.products, s.lowStockCount + ' с низким остатком'],
            ['Клиенты', s.customers, 'Уникальные покупатели']
        ];
        document.getElementById('dashKpis').innerHTML = cards.map(([label, value, note]) =>
            '<div class="dash-kpi"><div class="dash-kpi-label">' + esc(label) + '</div><div class="dash-kpi-value">' + esc(typeof value === 'number' ? integer.format(value) : value) + '</div><div class="dash-kpi-note">' + esc(note) + '</div></div>'
        ).join('');
    }
    function renderRecent(rows) {
        const el = document.getElementById('dashRecentOrders');
        document.getElementById('dashOrdersCount').textContent = integer.format(rows.length);
        if (!rows.length) { el.innerHTML = '<div class="dash-empty">За этот день заказов пока нет</div>'; return; }
        el.innerHTML = rows.map(o => {
            const number = o.orderNumber || ('#' + o.id);
            const time = o.createdAt ? o.createdAt.slice(11, 16) : '';
            return '<div class="dash-row"><div><div class="dash-main">' + esc(number) + ' · ' + esc(o.customerName || 'Покупатель') + '</div><div class="dash-sub">' + esc(time) + ' · ' + esc(statusNames[o.status] || o.status || 'Статус не указан') + '</div></div><div class="dash-value">' + esc(rub.format(Number(o.total || 0))) + '</div></div>';
        }).join('');
    }
    function renderLowStock(rows, total) {
        const el = document.getElementById('dashLowStock');
        document.getElementById('dashLowStockCount').textContent = integer.format(total);
        if (!rows.length) { el.innerHTML = '<div class="dash-empty">Нет товаров с низким остатком</div>'; return; }
        el.innerHTML = rows.map(p => {
            const name = [p.brand, p.name, p.viscosity, p.volume].filter(Boolean).join(' ');
            return '<div class="dash-row"><div><div class="dash-main">' + esc(name || ('Товар #' + p.id)) + '</div><div class="dash-sub">Минимум: ' + integer.format(Number(p.minStock || 0)) + '</div></div><div class="dash-value">' + integer.format(Number(p.stock || 0)) + ' шт.</div></div>';
        }).join('');
    }

    const WORKCAL_KINDS = { task: 'Задача', meeting: 'Встреча', contract: 'Договор', logistics: 'Логистика', kpi: 'KPI', note: 'Заметка' };
    const WORKCAL_STATUSES = { planned: 'Запланировано', in_progress: 'В работе', done: 'Выполнено', cancelled: 'Отменено' };
    const WORKCAL_PRIORITIES = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный' };
    const WORKCAL_DAYS = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
    const WORKCAL_MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const workcalCanManage = () => typeof window.adminHasPermission === 'function' && window.adminHasPermission('workspace.manage');
    const workcalCanUpdate = () => typeof window.adminHasPermission === 'function' && window.adminHasPermission('workspace.update_self');
    function workcalMoscowToday() {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return new Date(Number(values.year), Number(values.month) - 1, Number(values.day));
    }
    let workcalDate = workcalMoscowToday();
    let workcalSelected = null;
    let workcalData = { days: [], items: [] };
    let workcalStaff = [];
    let workcalLoadSequence = 0;
    const workcalDateKey = date => date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
    const workcalMonthKey = date => date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0');
    const workcalParseDate = value => { const [y,m,d] = value.split('-').map(Number); return new Date(y,m-1,d); };
    const workcalFmtDate = value => new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(new Date(value+'T00:00:00Z'));
    const workcalFmtMoney = value => rub.format(Number(value)||0);
    // Значения datetime-local в форме календаря трактуются как московское время независимо от часового пояса устройства.
    function workcalMskInputToIso(value) {
        if (!value) return null;
        const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
        if (!match) return null;
        const [, y, m, d, h, minute] = match.map(Number);
        return new Date(Date.UTC(y, m - 1, d, h - 3, minute)).toISOString();
    }
    const workcalItemDate = item => {
        const value = item.kind === 'task' ? (item.dueAt || item.startsAt) : (item.startsAt || item.dueAt);
        if (!value) return '';
        return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
    };
    const workcalTime = value => value ? new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : 'Весь день';
    function renderWorkcal() {
        const grid = document.getElementById('workcalGrid');
        if (!grid) return;
        const year = workcalDate.getFullYear(), month = workcalDate.getMonth();
        document.getElementById('workcalMonth').textContent = WORKCAL_MONTHS[month] + ' ' + year;
        const firstOffset = (new Date(year,month,1).getDay()+6)%7;
        const daysInMonth = new Date(year,month+1,0).getDate();
        const todayKey = moscowDateKey();
        const dayMap = new Map((workcalData.days||[]).map(day=>[day.date,day]));
        const itemMap = new Map();
        for (const item of workcalData.items||[]) {
            const key=workcalItemDate(item);
            if(!itemMap.has(key))itemMap.set(key,[]);
            itemMap.get(key).push(item);
        }
        let html = WORKCAL_DAYS.map((day,i)=>'<div class="workcal-weekday">'+day+'</div>').join('');
        const cells = Math.ceil((firstOffset+daysInMonth)/7)*7;
        for(let i=0;i<cells;i++){
            const dayNum=i-firstOffset+1;
            const date=new Date(year,month,dayNum);
            const key=workcalDateKey(date);
            const inMonth=dayNum>=1&&dayNum<=daysInMonth;
            const weekend=date.getDay()===0||date.getDay()===6;
            const summary=dayMap.get(key)||{};
            const items=itemMap.get(key)||[];
            const taskCount=items.filter(x=>x.kind==='task'&&x.status!=='cancelled').length;
            const eventCount=items.filter(x=>x.kind!=='task'&&x.status!=='cancelled').length;
            const tooltip=[(summary.orders||0)+' заказов',(summary.revenue==null?'Выручка скрыта':workcalFmtMoney(summary.revenue)),'Новых: '+(summary.newOrders||0),'В доставке: '+(summary.shipping||0),'Доставлено: '+(summary.delivered||0),'Отменено: '+(summary.cancelled||0),'Складских движений: '+(summary.stockMovements||0),'Задач: '+taskCount,'Событий: '+eventCount].join(' · ');
            const dots=items.filter(x=>x.status!=='cancelled').slice(0,7).map(x=>'<i class="workcal-dot '+esc(x.kind)+'"></i>').join('');
            const metrics=(summary.orders||summary.revenue!=null)?'<span>'+integer.format(summary.orders||0)+' зак.</span><span>'+(summary.revenue==null?'—':workcalFmtMoney(summary.revenue))+'</span>':'<span>—</span>';
            const hoverItems=items.filter(x=>x.status!=='cancelled').slice(0,6).map(x=>'<span class="workcal-hover-line">'+esc(WORKCAL_KINDS[x.kind]||x.kind)+': '+esc(x.title)+'</span>').join('');
            const hover='<span><b>'+esc(workcalFmtDate(key))+'</b></span><span>Заказы: '+integer.format(summary.orders||0)+' · Новые: '+integer.format(summary.newOrders||0)+'</span><span>Доставка: '+integer.format(summary.shipping||0)+' · Доставлено: '+integer.format(summary.delivered||0)+'</span><span>Отменено: '+integer.format(summary.cancelled||0)+' · Выручка: '+(summary.revenue==null?'—':esc(workcalFmtMoney(summary.revenue)))+'</span><span>Склад: '+integer.format(summary.stockMovements||0)+' движ. · −'+integer.format(summary.qtyOut||0)+' / +'+integer.format(summary.qtyIn||0)+' шт.</span>'+(hoverItems||'<span>Задач и событий нет</span>');
            html+='<button type="button" class="workcal-day '+(!inMonth?'other ':'')+(weekend?'weekend ':'')+(key===todayKey?'today ':'')+(key===workcalSelected?'selected':'')+'" data-date="'+key+'" title="'+esc(tooltip)+'" aria-label="'+esc(workcalFmtDate(key)+'. '+tooltip)+'"><span class="workcal-daynum">'+date.getDate()+'</span><span class="workcal-daymetrics">'+metrics+'<span>Задач: '+taskCount+' · Событий: '+eventCount+'</span></span><span class="workcal-dots">'+dots+'</span><span class="workcal-hover">'+hover+'</span></button>';
        }
        grid.innerHTML=html;
        grid.querySelectorAll('button[data-date]').forEach(button=>button.addEventListener('click',()=>selectWorkcalDay(button.dataset.date)));
        if(workcalSelected&&!document.getElementById('workcalCreateForm'))renderWorkcalDay(workcalSelected);
    }
    function renderWorkcalDay(dateKey) {
        const target=document.getElementById('workcalDetail');
        if(!target)return;
        const summary=(workcalData.days||[]).find(x=>x.date===dateKey)||{};
        const items=(workcalData.items||[]).filter(x=>workcalItemDate(x)===dateKey);
        const tasks=items.filter(x=>x.kind==='task'&&x.status!=='cancelled');
        const completed=tasks.filter(x=>x.status==='done').length;
        const events=items.filter(x=>x.kind!=='task'&&x.status!=='cancelled');
        let html='<div class="workcal-detail-head"><div class="workcal-detail-title">'+esc(workcalFmtDate(dateKey))+'</div>'+(workcalCanManage()?'<button type="button" class="workcal-action workcal-primary" id="workcalAddTask">+ Новая задача / событие</button>':'')+'</div>';
        html+='<div class="workcal-daystats"><span class="workcal-stat">Заказы: <b>'+integer.format(summary.orders||0)+'</b></span><span class="workcal-stat">Выручка: <b>'+esc(summary.revenue==null?'—':workcalFmtMoney(summary.revenue))+'</b></span><span class="workcal-stat">Новые: <b>'+integer.format(summary.newOrders||0)+'</b></span><span class="workcal-stat">В доставке: <b>'+integer.format(summary.shipping||0)+'</b></span><span class="workcal-stat">Доставлено: <b>'+integer.format(summary.delivered||0)+'</b></span><span class="workcal-stat">Отменено: <b>'+integer.format(summary.cancelled||0)+'</b></span><span class="workcal-stat">Движения склада: <b>'+integer.format(summary.stockMovements||0)+'</b></span><span class="workcal-stat">Склад −/+ шт.: <b>'+integer.format(summary.qtyOut||0)+' / '+integer.format(summary.qtyIn||0)+'</b></span><span class="workcal-stat">Задачи: <b>'+completed+'/'+tasks.length+'</b></span><span class="workcal-stat">События: <b>'+events.length+'</b></span></div>';
        if(!items.length)html+='<div class="workcal-empty">На этот день пока нет задач и событий.</div>';
        else html+='<div class="workcal-items">'+items.map(item=>{
            const isTask=item.kind==='task';
            const canUpdate=isTask&&workcalCanUpdate()&&item.assignedTo&&window._adminSession&&Number(item.assignedTo)===Number(window._adminSession.userId)&&item.status!=='done'&&item.status!=='cancelled';
            const canEdit=workcalCanManage();
            const details=[item.description,item.assigneeName?'Исполнитель: '+item.assigneeName:'',item.location?'Место: '+item.location:'',item.counterparty?'Контрагент: '+item.counterparty:'',item.amount!=null?'Сумма: '+workcalFmtMoney(item.amount):'',item.metricName?'Показатель: '+item.metricName+' — '+(item.metricValue??'—')+(item.metricTarget!=null?' / цель '+item.metricTarget:''):''].filter(Boolean).join(' · ');
            const nextStatus=item.status==='planned'?'in_progress':'done';
            return '<div class="workcal-item"><div class="workcal-item-time">'+esc(workcalTime(item.dueAt||item.startsAt))+'</div><div><div class="workcal-item-title">'+esc(item.title)+' <span class="dash-pill">'+esc(WORKCAL_KINDS[item.kind]||item.kind)+'</span></div><div class="workcal-item-meta">'+esc(details)+' · '+esc(WORKCAL_STATUSES[item.status]||item.status)+' · '+esc(WORKCAL_PRIORITIES[item.priority]||item.priority)+'</div></div><div class="workcal-item-actions">'+(canUpdate?'<button type="button" data-task-status="'+item.id+'" data-status="'+nextStatus+'">'+(nextStatus==='in_progress'?'Взять в работу':'Выполнено')+'</button>':'')+(canEdit?'<button type="button" data-item-cancel="'+item.id+'">Отменить</button>':'')+'</div></div>';
        }).join('')+'</div>';
        target.innerHTML=html;
        target.querySelector('#workcalAddTask')?.addEventListener('click',()=>renderWorkcalForm(dateKey));
        target.querySelectorAll('[data-task-status]').forEach(button=>button.addEventListener('click',()=>updateWorkcalItem(button.dataset.taskStatus,{status:button.dataset.status})));
        target.querySelectorAll('[data-item-cancel]').forEach(button=>button.addEventListener('click',()=>cancelWorkcalItem(button.dataset.itemCancel)));
    }
    function renderWorkcalTasks() {
        const target=document.getElementById('workcalTaskOverview');
        if(!target)return;
        // В этом блоке показываем не только поручения, но и все доступные
        // пользователю встречи, договоры, логистику, KPI и заметки.
        const entries=(workcalData.items||[]).filter(item=>item.status!=='cancelled')
            .sort((a,b)=>String(workcalItemDate(a)||'').localeCompare(String(workcalItemDate(b)||''))||
                String(a.startsAt||a.dueAt||'').localeCompare(String(b.startsAt||b.dueAt||'')));
        const today=workcalDateKey(workcalMoscowToday());
        const open=entries.filter(item=>item.status!=='done');
        const title=document.getElementById('workcalTaskTitle');
        if(title)title.textContent=workcalCanManage()?'Задачи и события сотрудников':'Мои задачи и события';
        const count=document.getElementById('workcalTaskCount');
        if(count)count.textContent=String(open.length)+' активных';
        if(!entries.length){target.innerHTML='<div class="dash-empty">На этот месяц задач и событий нет.</div>';return;}
        target.innerHTML=entries.slice(0,30).map(item=>{
            const date=workcalItemDate(item);
            const isTask=item.kind==='task';
            const overdue=isTask&&date<today&&item.status!=='done';
            const kindLabel=WORKCAL_KINDS[item.kind]||item.kind;
            const assignee=item.assigneeName?' · '+esc(item.assigneeName):'';
            return '<div class="dash-row"><div><div class="dash-main">'+esc(item.title)+' <span class="dash-pill">'+esc(kindLabel)+'</span></div><div class="dash-sub">'+(overdue?'<b style="color:#dc2626">Просрочено · </b>':'')+esc(date?workcalFmtDate(date):'Без даты')+' · '+esc(WORKCAL_STATUSES[item.status]||item.status)+assignee+'</div></div><div class="dash-value"><button type="button" class="workcal-action" data-open-workcal-date="'+esc(date||'')+'">Открыть</button></div></div>';
        }).join('')+(entries.length>30?'<div class="dash-empty">Показаны первые 30 записей месяца.</div>':'');
        target.querySelectorAll('[data-open-workcal-date]').forEach(button=>button.addEventListener('click',()=>{
            const date=button.dataset.openWorkcalDate;
            if(!date)return;
            if(!date.startsWith(workcalMonthKey(workcalDate))){workcalDate=workcalParseDate(date);workcalSelected=date;loadWorkspaceCalendar();}
            else selectWorkcalDay(date);
        }));
    }
    async function selectWorkcalDay(dateKey) {
        document.getElementById('workcalCreateForm')?.remove();
        workcalSelected=dateKey;
        document.querySelectorAll('.workcal-day').forEach(button=>button.classList.toggle('selected',button.dataset.date===dateKey));
        renderWorkcalDay(dateKey);
    }
    function renderWorkcalForm(dateKey) {
        const target=document.getElementById('workcalDetail');
        if(!target||document.getElementById('workcalCreateForm'))return;
        const defaultDate=dateKey+'T09:00';
        const employeeOptions=workcalStaff.map(user=>'<option value="'+Number(user.id)+'">'+esc(user.displayName)+' · '+esc(user.role)+'</option>').join('');
        target.insertAdjacentHTML('beforeend',`<form class="workcal-create" id="workcalCreateForm">
          <label>Тип записи<select name="kind"><option value="task">Задача сотруднику</option><option value="meeting">Встреча</option><option value="contract">Подписание договора</option><option value="logistics">Логистика / поставка</option><option value="kpi">Показатель KPI</option><option value="note">Заметка</option></select></label>
          <label>Приоритет<select name="priority"><option value="normal">Обычный</option><option value="high">Высокий</option><option value="urgent">Срочный</option><option value="low">Низкий</option></select></label>
          <label class="wide">Название<input name="title" required minlength="2" maxlength="200" placeholder="Например: Подготовить документы для поставки"></label>
          <label>Начало<input type="datetime-local" name="startsAt" value="${defaultDate}"></label>
          <label>Срок / дата завершения<input type="datetime-local" name="dueAt" value="${defaultDate}"></label>
          <label class="wide">Исполнитель<select name="assignedTo"><option value="">Не назначен</option>${employeeOptions}</select></label>
          <label>Место / маршрут<input name="location" maxlength="250" placeholder="Владивосток → Санкт-Петербург"></label>
          <label>Контрагент<input name="counterparty" maxlength="250" placeholder="Поставщик / клиент"></label>
          <label>Сумма, ₽<input name="amount" type="number" min="0" step="0.01"></label>
          <label>Название KPI<input name="metricName" maxlength="120" placeholder="Например: Выполнение плана"></label>
          <label>Факт KPI<input name="metricValue" type="number" step="0.001"></label>
          <label>Цель KPI<input name="metricTarget" type="number" step="0.001"></label>
          <label class="wide">Описание<textarea name="description" maxlength="5000" placeholder="Подробности, ожидаемый результат, документы…"></textarea></label>
          <label class="wide"><span><input type="checkbox" name="companyVisible" checked style="width:auto"> Показывать событие всем сотрудникам</span></label>
          <div class="workcal-create-actions"><button type="button" class="workcal-action" id="workcalFormCancel">Закрыть</button><button class="workcal-action workcal-primary" type="submit">Сохранить</button></div>
        </form>`);
        const form=target.querySelector('#workcalCreateForm');
        form.querySelector('[name="kind"]').addEventListener('change',()=>{
            const task=form.elements.kind.value==='task';
            form.elements.assignedTo.required=task;
            form.elements.dueAt.required=task;
            form.elements.startsAt.required=!task;
        });
        form.querySelector('#workcalFormCancel').addEventListener('click',()=>form.remove());
        form.addEventListener('submit',async event=>{
            event.preventDefault();
            const data=new FormData(form);
            const kind=data.get('kind');
            const startsAt=data.get('startsAt');
            const dueAt=data.get('dueAt');
            const payload={
                kind,title:data.get('title'),description:data.get('description'),
                startsAt:kind==='task'?null:workcalMskInputToIso(startsAt),
                dueAt:kind==='task'?workcalMskInputToIso(dueAt):(dueAt?workcalMskInputToIso(dueAt):null),
                priority:data.get('priority'),assignedTo:data.get('assignedTo')||null,
                companyVisible:form.elements.companyVisible.checked,
                location:data.get('location'),counterparty:data.get('counterparty'),
                amount:data.get('amount')||null,metricName:data.get('metricName'),
                metricValue:data.get('metricValue')||null,metricTarget:data.get('metricTarget')||null
            };
            if(kind==='task'&&!payload.assignedTo){alert('Для задачи выберите сотрудника.');return;}
            if(kind==='task'&&!payload.dueAt){alert('Для задачи укажите срок.');return;}
            if(kind!=='task'&&!payload.startsAt){alert('Для события укажите дату и время начала.');return;}
            await createWorkcalItem(payload,form);
        });
    }
    async function createWorkcalItem(payload,form) {
        const submit=form.querySelector('button[type="submit"]');
        if(submit){submit.disabled=true;submit.textContent='Сохранение…';}
        try{
            const response=await fetch('/api/admin/workspace/items',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(data.error||'Не удалось сохранить задачу');
            form.remove();
            await loadWorkspaceCalendar();
            renderWorkcalDay(workcalSelected);
        }catch(error){
            if(submit){submit.disabled=false;submit.textContent='Сохранить';}
            alert(error.message||'Ошибка сохранения');
        }
    }
    async function updateWorkcalItem(id,patch) {
        try{
            const response=await fetch('/api/admin/workspace/items/'+encodeURIComponent(id),{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(data.error||'Не удалось обновить задачу');
            await loadWorkspaceCalendar();
        }catch(error){alert(error.message||'Ошибка обновления');}
    }
    async function cancelWorkcalItem(id) {
        if(!confirm('Отменить эту запись календаря?'))return;
        try{
            const response=await fetch('/api/admin/workspace/items/'+encodeURIComponent(id),{method:'DELETE',credentials:'same-origin'});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(data.error||'Не удалось отменить запись');
            await loadWorkspaceCalendar();
        }catch(error){alert(error.message||'Ошибка отмены');}
    }
    async function loadWorkspaceCalendar() {
        const requestSequence=++workcalLoadSequence;
        try{
            if(workcalCanManage()){
                const staffResponse=await fetch('/api/admin/workspace/staff',{credentials:'same-origin',cache:'no-store'});
                if(!staffResponse.ok)throw new Error('Не удалось получить список сотрудников');
                const staff=await staffResponse.json();
                if(requestSequence!==workcalLoadSequence)return;
                workcalStaff=staff;
            }
            const month=workcalMonthKey(workcalDate);
            const response=await fetch('/api/admin/workspace/calendar?month='+encodeURIComponent(month),{credentials:'same-origin',cache:'no-store'});
            const data=await response.json().catch(()=>({}));
            if(requestSequence!==workcalLoadSequence)return;
            if(!response.ok)throw new Error(data.error||'Не удалось загрузить календарь');
            workcalData=data;
            renderWorkcal();
            if(!workcalSelected||!workcalSelected.startsWith(month)) {
                const today=workcalMoscowToday();
                workcalSelected=workcalMonthKey(today)===month?workcalDateKey(today):workcalDateKey(new Date(workcalDate.getFullYear(),workcalDate.getMonth(),1));
            }
            if(!document.getElementById('workcalCreateForm'))renderWorkcalDay(workcalSelected);
            renderWorkcalTasks();
        }catch(error){
            if(requestSequence!==workcalLoadSequence)return;
            const grid=document.getElementById('workcalGrid');
            if(grid)grid.innerHTML='<div class="workcal-empty">'+esc(error.message||'Ошибка загрузки')+'</div>';
        }
    }
    document.getElementById('workcalPrev')?.addEventListener('click',()=>{document.getElementById('workcalCreateForm')?.remove();workcalDate=new Date(workcalDate.getFullYear(),workcalDate.getMonth()-1,1);loadWorkspaceCalendar();});
    document.getElementById('workcalNext')?.addEventListener('click',()=>{document.getElementById('workcalCreateForm')?.remove();workcalDate=new Date(workcalDate.getFullYear(),workcalDate.getMonth()+1,1);loadWorkspaceCalendar();});
    document.getElementById('workcalToday')?.addEventListener('click',()=>{workcalDate=workcalMoscowToday();workcalSelected=workcalDateKey(workcalDate);loadWorkspaceCalendar();});
    let loading = false;
    window.loadAdminDashboard = async function loadAdminDashboard() {
        if (loading) return;
        loading = true;
        const button = document.getElementById('dashRefresh');
        if (button) { button.disabled = true; button.textContent = 'Обновление…'; }
        try {
            const response = await fetch('/api/admin/dashboard?date=' + encodeURIComponent(moscowDateKey()), {
                method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store'
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Ошибка загрузки');
            renderKpis(data.summary || {});
            renderRecent(data.recentOrders || []);
            renderLowStock(data.lowStockProducts || [], (data.summary || {}).lowStockCount || 0);
            loadWorkspaceCalendar();
            const date = data.businessDate ? new Date(data.businessDate + 'T00:00:00Z') : new Date();
            document.getElementById('dashBusinessDate').textContent = 'Сводка за ' + new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(date) + ' · Москва';
        } catch (error) {
            document.getElementById('dashKpis').innerHTML = '<div class="dash-error" style="grid-column:1/-1">' + esc(error.message || 'Не удалось загрузить данные') + '</div>';
        } finally {
            loading = false;
            if (button) { button.disabled = false; button.textContent = 'Обновить данные'; }
        }
    };

    document.getElementById('dashRefresh')?.addEventListener('click', () => window.loadAdminDashboard());
    if (typeof VIEWS !== 'undefined') VIEWS.dashboard = { tab: 'dashboard', title: 'Обзор' };
    if (typeof go === 'function') {
        const hash = location.hash.slice(1);
        if (hash === 'dashboard' || !hash) go('dashboard', { initial: true });
    }
    document.getElementById('dashBusinessDate') && (document.getElementById('dashBusinessDate').textContent = 'Сводка за сегодня по Москве');
    window.setInterval(() => { if (document.getElementById('tab-dashboard')?.classList.contains('active')) window.loadAdminDashboard(); }, 60000);
})();
