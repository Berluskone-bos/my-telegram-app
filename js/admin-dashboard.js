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
              <div class="dash-columns">
                <section class="dash-panel"><div class="dash-panel-head"><div class="dash-panel-title">Последние заказы за день</div><span class="dash-pill" id="dashOrdersCount">0</span></div><div class="dash-panel-body" id="dashRecentOrders"><div class="dash-empty">Загрузка…</div></div></section>
                <section class="dash-panel"><div class="dash-panel-head"><div class="dash-panel-title">Низкие остатки</div><span class="dash-pill" id="dashLowStockCount">0</span></div><div class="dash-panel-body" id="dashLowStock"><div class="dash-empty">Загрузка…</div></div></section>
              </div>
              <section class="dash-panel"><div class="dash-panel-head"><div class="dash-panel-title">Ближайшие события</div><span class="dash-pill">Следующий этап</span></div><div class="dash-panel-body"><div class="dash-empty">После реализации рабочего календаря здесь появятся доставки, выдачи заказов, задачи и встречи.</div></div></section>
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
            ['Товары в каталоге', s.products, s.lowStockCount + ' с низким остатком'],
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
