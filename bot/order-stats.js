'use strict';
// GET /api/orders/stats — данные для графика заказов в админке (по дням, неделям или месяцам);
// GET /api/orders/kpi — карточки показателей «сегодня / неделя / месяц / год»;
// GET /api/analytics/shop — топ товаров и способы получения за период.
// Даты — календарные дни по Москве, строки 'YYYY-MM-DD'. Подключается из courier-bot.js рядом с остальными админскими маршрутами.

const MAX_DAYS = 3660;                       // не больше ~10 лет за один запрос
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Дата как число дней от эпохи: считаем по UTC, чтобы часовой пояс сервера ничего не сдвигал.
function dayNum(str) {
    if (typeof str !== 'string' || !DATE_RE.test(str)) return null;
    const [y, m, d] = str.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d);
    const back = new Date(t);
    // 2026-02-31 → отклоняем, а не молча переносим на март
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
    return Math.round(t / DAY_MS);
}
const dayStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

// До 62 дней — по дням, до ~год — по неделям, дальше — по месяцам
function autoGroup(days) { return days <= 62 ? 'day' : days <= 370 ? 'week' : 'month'; }

// Ряд по дням → ряд по дням/неделям (с понедельника)/месяцам. Каждая точка знает свой первый и последний день.
function groupSeries(rows, group) {
    if (group === 'day') return rows.map(r => ({ from: r.day, to: r.day, orders: r.orders, revenue: r.revenue, cancelled: r.cancelled }));
    const out = new Map();
    for (const r of rows) {
        const n = dayNum(r.day);
        let key;
        if (group === 'week') key = n - ((n + 3) % 7);   // 1970-01-01 — четверг: (n+3)%7 = число дней с понедельника
        else key = r.day.slice(0, 7);
        let p = out.get(key);
        if (!p) { p = { from: r.day, to: r.day, orders: 0, revenue: 0, cancelled: 0 }; out.set(key, p); }
        p.to = r.day; p.orders += r.orders; p.revenue += r.revenue; p.cancelled += r.cancelled;
    }
    return [...out.values()];
}

// Возвращает { from, to, days } или { error }
function parseRange(query) {
    const a = dayNum(query.from), b = dayNum(query.to);
    if (a === null || b === null) return { error: 'Укажите период: from и to в виде ГГГГ-ММ-ДД' };
    if (a > b) return { error: 'Начало периода позже конца' };
    const days = b - a + 1;
    if (days > MAX_DAYS) return { error: 'Период слишком большой' };
    return { from: query.from, to: query.to, days, a, b };
}

function registerOrderStatsRoutes(app, { db, verifyAdmin }) {
    // Аналитика магазина за период: GET /api/analytics/shop?from&to или ?period=all (с первого заказа до сегодня)
    app.get('/api/analytics/shop', verifyAdmin, async (req, res) => {
        try {
            let from, to;
            if (req.query.period === 'all') {
                to = await db.getMoscowToday();
                from = (await db.getFirstOrderDate()) || to;
            } else {
                const range = parseRange(req.query);
                if (range.error) return res.status(400).json({ error: range.error });
                ({ from, to } = range);
            }
            res.json({ from, to, ...(await db.getShopAnalytics(from, to)) });
        } catch (e) { console.error('[API]', e.message); res.status(500).json({ error: 'Internal error' }); }
    });

    // Карточки «сегодня / неделя / месяц / год» с мини-графиками
    app.get('/api/orders/kpi', verifyAdmin, async (req, res) => {
        try { res.json(await db.getKpi()); }
        catch (e) { console.error('[API]', e.message); res.status(500).json({ error: 'Internal error' }); }
    });

    app.get('/api/orders/stats', verifyAdmin, async (req, res) => {
        try {
            const range = parseRange(req.query);
            if (range.error) return res.status(400).json({ error: range.error });
            const group = ['day', 'week', 'month'].includes(req.query.group) ? req.query.group : autoGroup(range.days);
            // тот же по длине отрезок сразу перед периодом — для сравнения («+12 % к прошлому периоду»)
            const prevTo = dayStr(range.a - 1), prevFrom = dayStr(range.a - range.days);
            const [first, rows, totals, prev] = await Promise.all([
                db.getFirstOrderDate(), db.getOrderSeries(range.from, range.to),
                db.getOrderTotals(range.from, range.to), db.getOrderTotals(prevFrom, prevTo)
            ]);
            res.json({
                first_order_date: first, from: range.from, to: range.to, group,
                points: groupSeries(rows, group),
                totals, previous: { from: prevFrom, to: prevTo, ...prev }
            });
        } catch (e) { console.error('[API]', e.message); res.status(500).json({ error: 'Internal error' }); }
    });
}

module.exports = { registerOrderStatsRoutes, groupSeries, autoGroup, parseRange, dayNum, dayStr };
