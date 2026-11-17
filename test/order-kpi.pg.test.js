'use strict';
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js). Без неё тест пропускается.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('карточки показателей: период до этого момента против такого же отрезка прошлого, отмены и «будущее» не считаются', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    const { registerOrderStatsRoutes } = require('../bot/order-stats');
    await initDB();
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');
    t.after(async () => { await pool.query('DELETE FROM orders'); await pool.end(); });

    const add = (key, moscow, total, status = 'NEW') => pool.query(
        `INSERT INTO orders (order_number, user_name, total, status, created_at)
         VALUES ($1, 'T', $2, $3, ($4::timestamp AT TIME ZONE 'Europe/Moscow') AT TIME ZONE current_setting('TimeZone'))`, ['AP-K' + key, total, status, moscow]);
    // «Сейчас» = вторник 17.11.2026 15:30 по Москве. Неделя с понедельника 16.11.
    await add('A', '2026-11-17 09:10', 1000);                  // сегодня
    await add('B', '2026-11-17 16:00', 999);                   // позже «сейчас» — не считается
    await add('C', '2026-11-16 10:00', 500);                   // вчера до 15:30 — в сравнении «сегодня»
    await add('D', '2026-11-16 18:00', 700);                   // вчера после 15:30 — в сравнение «сегодня» не входит
    await add('E', '2026-11-10 12:00', 300);                   // прошлая неделя до вт 15:30 — в сравнении «неделя»
    await add('F', '2026-11-10 16:00', 200);                   // прошлая неделя после вт 15:30 — не входит
    await add('G', '2026-10-05 12:00', 400);                   // прошлый месяц до 17-го — в сравнении «месяц»
    await add('H', '2026-10-20 12:00', 600);                   // прошлый месяц после 17-го — не входит
    await add('I', '2025-03-01 12:00', 250);                   // прошлый год до 17.11 — в сравнении «год»
    await add('J', '2026-11-17 10:00', 9999, 'CANCELLED');     // отмена — нигде не считается

    const k = await db.getKpi('2026-11-17 15:30:00');
    const pick = (x) => ({ orders: x.orders, revenue: x.revenue, prev: x.prev });
    assert.deepEqual(pick(k.today), { orders: 1, revenue: 1000, prev: { orders: 1, revenue: 500 } });
    assert.deepEqual(pick(k.week), { orders: 3, revenue: 2200, prev: { orders: 1, revenue: 300 } });
    assert.deepEqual(pick(k.month), { orders: 5, revenue: 2700, prev: { orders: 1, revenue: 400 } });
    assert.deepEqual(pick(k.year), { orders: 7, revenue: 3700, prev: { orders: 1, revenue: 250 } });

    // мини-графики: число столбиков и номер текущего
    assert.equal(k.today.series.length, 24); assert.equal(k.today.idx, 15); assert.equal(k.today.series[9].orders, 1);
    assert.equal(k.week.series.length, 7); assert.equal(k.week.idx, 1);
    assert.deepEqual([k.week.series[0].orders, k.week.series[1].orders, k.week.series[2].orders], [2, 1, 0]);
    assert.equal(k.month.series.length, 30, 'в ноябре 30 дней'); assert.equal(k.month.idx, 16);
    assert.deepEqual([k.month.series[9].orders, k.month.series[15].orders, k.month.series[16].orders], [2, 2, 1]);
    assert.equal(k.year.series.length, 12); assert.equal(k.year.idx, 10);
    assert.deepEqual([k.year.series[9].orders, k.year.series[10].orders], [2, 5]);
    for (const key of ['today', 'week', 'month', 'year']) {
        assert.equal(k[key].series.reduce((s, p) => s + p.orders, 0), k[key].orders, key + ': сумма столбиков = итог');
    }

    // маршрут: только администратор, ответ — те же четыре периода
    const app = express();
    let allowed = true;
    registerOrderStatsRoutes(app, { db, verifyAdmin: (req, res, next) => allowed ? next() : res.status(401).json({ error: 'no' }) });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/api/orders/kpi`;
    const ok = await fetch(url);
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(await ok.json()), ['today', 'week', 'month', 'year']);
    allowed = false;
    assert.equal((await fetch(url)).status, 401);
});
