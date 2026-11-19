'use strict';
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js). Без неё тест пропускается.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('график заказов: дни без заказов, отмены отдельно, граница суток по Москве, сравнение, дата первого заказа', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    const { registerOrderStatsRoutes } = require('../bot/order-stats');
    await initDB();
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');

    const app = express(); app.use(express.json());
    let allowed = true;
    registerOrderStatsRoutes(app, { db, verifyAdmin: (req, res, next) => { if (!allowed) return res.status(401).json({ error: 'no' }); req.admin = { role: 'admin' }; return next(); } });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    t.after(async () => { server.close(); await pool.query('DELETE FROM orders'); await pool.end(); });
    const get = (q) => fetch(`http://127.0.0.1:${server.address().port}/api/orders/stats?${q}`);

    // created_at хранится без пояса в поясе сервера: подставляем «настенное» время сервера, которому соответствует МОСКОВСКОЕ время из аргумента
    const add = (key, moscow, total, status) => pool.query(
        `INSERT INTO orders (order_number, user_name, total, status, created_at)
         VALUES ($1, 'T', $2, $3, ($4::timestamp AT TIME ZONE 'Europe/Moscow') AT TIME ZONE current_setting('TimeZone'))`, ['AP-S' + key, total, status, moscow]);
    await add(1, '2026-10-20 12:00', 1000, 'DELIVERED');    // до периода (и до предыдущего окна)
    await add(2, '2026-11-02 23:30', 500, 'NEW');           // 2 ноября по Москве
    await add(3, '2026-11-03 00:30', 700, 'CONFIRMED');     // уже 3 ноября
    await add(4, '2026-11-03 10:00', 300, 'CANCELLED');     // отмена: не в заказах и не в выручке
    await add(5, '2026-11-10 09:00', 1200, 'COMPLETED');
    await add(6, '2026-10-28 09:00', 400, 'COMPLETED');     // в предыдущем окне (22 окт — 31 окт для периода из 10 дней)

    const r = await get('from=2026-11-01&to=2026-11-10');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.first_order_date, '2026-10-20');
    assert.equal(j.group, 'day');
    assert.equal(j.points.length, 10, 'каждый день периода, в том числе пустые');
    const by = Object.fromEntries(j.points.map(p => [p.from, p]));
    assert.equal(by['2026-11-01'].orders, 0);
    assert.equal(by['2026-11-02'].orders, 1, '23:30 по Москве — ещё 2 ноября');
    assert.equal(by['2026-11-03'].orders, 1, '00:30 по Москве — уже 3 ноября');
    assert.equal(by['2026-11-03'].cancelled, 1);
    assert.equal(by['2026-11-03'].revenue, 700, 'отменённый заказ в выручку не входит');
    assert.deepEqual(j.totals, { orders: 3, revenue: 2400, cancelled: 1 });
    assert.deepEqual([j.previous.from, j.previous.to], ['2026-10-22', '2026-10-31']);
    assert.equal(j.previous.orders, 1);
    assert.equal(j.previous.revenue, 400);

    // длинный период группируется по неделям/месяцам, сумма не теряется
    const wk = await (await get('from=2026-08-01&to=2026-11-30')).json();
    assert.equal(wk.group, 'week');
    assert.equal(wk.points.reduce((s, p) => s + p.orders, 0), 5);
    const mo = await (await get('from=2026-10-01&to=2026-11-30&group=month')).json();
    assert.deepEqual(mo.points.map(p => [p.from.slice(0, 7), p.orders]), [['2026-10', 2], ['2026-11', 3]]);

    // плохие запросы и доступ
    assert.equal((await get('from=2026-11-10&to=2026-11-01')).status, 400);
    assert.equal((await get('from=abc&to=2026-11-01')).status, 400);
    assert.equal((await get('from=2026-11-01')).status, 400);
    allowed = false;
    assert.equal((await get('from=2026-11-01&to=2026-11-10')).status, 401, 'без входа в админку — отказ');
    allowed = true;
    await pool.query('DELETE FROM orders');
    const empty = await (await get('from=2026-11-01&to=2026-11-03')).json();
    assert.equal(empty.first_order_date, null);
    assert.deepEqual(empty.totals, { orders: 0, revenue: 0, cancelled: 0 });
});
