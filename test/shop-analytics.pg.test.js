'use strict';
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js). Без неё тест пропускается.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('аналитика магазина: топ товаров, способы получения, отмены и границы периода', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    const { registerOrderStatsRoutes } = require('../bot/order-stats');
    await initDB();
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');

    const app = express();
    let allowed = true;
    registerOrderStatsRoutes(app, { db, verifyAdmin: (req, res, next) => { if (!allowed) return res.status(401).json({ error: 'no' }); req.admin = { role: 'admin' }; return next(); } });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    t.after(async () => { server.close(); await pool.query('DELETE FROM orders'); await pool.end(); });
    const get = (q) => fetch(`http://127.0.0.1:${server.address().port}/api/analytics/shop?${q}`);

    const add = (key, moscow, total, status, delivery, items) => pool.query(
        `INSERT INTO orders (order_number, user_name, total, status, delivery_type, items, created_at)
         VALUES ($1, 'T', $2, $3, $4, $5::jsonb, ($6::timestamp AT TIME ZONE 'Europe/Moscow') AT TIME ZONE current_setting('TimeZone'))`,
        ['AP-A' + key, total, status, delivery, JSON.stringify(items), moscow]);
    const oil = { productId: 1, name: 'Gulf 5W-30', volume: '4л', price: 3000, qty: 1 };
    const filter = { productId: 2, name: 'Фильтр', volume: '', price: 500, qty: 2 };
    await add(1, '2026-11-02 10:00', 3900, 'COMPLETED', 'delivery', [oil, filter]);           // масло 3000 + фильтры 1000, со скидкой итог 3900
    await add(2, '2026-11-03 12:00', 3000, 'NEW', 'pickup', [oil]);
    await add(3, '2026-11-04 12:00', 1000, 'CONFIRMED', 'delivery', [filter]);
    await add(4, '2026-11-05 12:00', 9000, 'CANCELLED', 'delivery', [{ ...oil, qty: 3 }]);   // отмена — не считается
    await add(5, '2026-10-31 23:30', 3000, 'COMPLETED', 'delivery', [oil]);                    // до периода
    await add(6, '2026-11-06 12:00', 700, 'NEW', 'delivery', [{ name: 'Старый заказ', price: 'abc', qty: 'x' }]); // кривые поля старого заказа не ломают отчёт

    const r = await get('from=2026-11-01&to=2026-11-30');
    assert.equal(r.status, 200);
    const j = await r.json();
    const byKey = Object.fromEntries(j.products.map(p => [p.key, p]));
    assert.equal(j.products[0].name, 'Gulf 5W-30', 'первое место — по выручке');
    assert.deepEqual([byKey['1'].qty, byKey['1'].revenue, byKey['1'].orders], [2, 6000, 2]);
    assert.deepEqual([byKey['2'].qty, byKey['2'].revenue, byKey['2'].orders], [4, 2000, 2]);
    assert.ok(byKey['Старый заказ'], 'товар без productId ищется по названию');
    assert.equal(byKey['Старый заказ'].qty, 1, 'кривое количество считается как 1'); assert.equal(byKey['Старый заказ'].revenue, 0);
    assert.deepEqual(j.delivery.map(d => [d.type, d.orders, d.revenue]), [['delivery', 3, 5600], ['pickup', 1, 3000]]);
    assert.deepEqual(j.totals, { orders: 4, revenue: 8600, cancelled: 1 });

    // «всё время» берёт период с первого заказа
    const all = await (await get('period=all')).json();
    assert.equal(all.from, '2026-10-31');
    assert.equal(all.totals.orders, 5);

    assert.equal((await get('from=2026-11-30&to=2026-11-01')).status, 400);
    assert.equal((await get('from=abc&to=2026-11-01')).status, 400);
    allowed = false;
    assert.equal((await get('from=2026-11-01&to=2026-11-30')).status, 401);
    allowed = true;
    await pool.query('DELETE FROM orders');
    const empty = await (await get('period=all')).json();
    assert.deepEqual([empty.products, empty.delivery, empty.totals.orders], [[], [], 0]);
});
