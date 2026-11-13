'use strict';
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js). Без неё тест пропускается.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';
const TOKEN = '123456:TEST_TOKEN_FOR_UNIT_TESTS';

const initDataFor = (id) => {
    const p = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAHtest', user: JSON.stringify({ id, first_name: 'T' }) };
    const dcs = Object.keys(p).sort().map(k => `${k}=${p[k]}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    return new URLSearchParams({ ...p, hash: crypto.createHmac('sha256', secret).update(dcs).digest('hex') }).toString();
};

test('история заказов клиента: только свои заказы, скрытие только завершённых', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    const { verifyInitData } = require('../bot/telegram-auth');
    const { registerOrderHistoryRoutes } = require('../bot/order-history-routes');
    await initDB();
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');
    const pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('H-oil', 500, true, 100) RETURNING id")).rows[0].id;

    const app = express(); app.use(express.json());
    registerOrderHistoryRoutes(app, {
        db, rateLimit: () => (req, res, next) => next(), sanitizeLog: String,
        authenticatedTelegramUser: (req) => { const a = verifyInitData(req.header('X-Telegram-Init-Data'), TOKEN); return a && a.user && a.user.id ? a.user : null; }
    });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    t.after(async () => { server.close(); await pool.query('DELETE FROM products WHERE id = $1', [pid]); await pool.end(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = (path, { method = 'GET', as, body } = {}) => fetch(base + path, {
        method, headers: { 'content-type': 'application/json', ...(as ? { 'X-Telegram-Init-Data': as } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const mk = (uid, key, qty = 1) => db.createOrder({ order_number: 'AP-' + key, user_id: uid, user_name: 'T', phone: '+79990000000', address: 'СПб, ул. Тест, д. 1',
        zone: 'spb', city: 'СПб', street: 'Тест', house: '1', comment: 'секретный комментарий',
        items: [{ productId: pid, qty, name: 'H-oil', volume: '4 л', price: 500 }], subtotal: 500 * qty, total: 500 * qty, idempotency_key: key });

    const U1 = initDataFor(111), U2 = initDataFor(222);
    const a1 = await mk(111, 'h1'), a2 = await mk(111, 'h2', 2); const b1 = await mk(222, 'h3');
    await db.updateOrderStatus(a1.id, 'DELIVERED');

    // без входа и с подделкой — 401
    assert.equal((await api('/api/orders/my')).status, 401);
    assert.equal((await api('/api/orders/my', { as: U1.replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64)) })).status, 401);

    // свои заказы, новые сверху, без телефона и комментария
    const r1 = await (await api('/api/orders/my', { as: U1 })).json();
    assert.equal(r1.success, true);
    assert.deepEqual(r1.orders.map(o => o.orderNumber), ['AP-h2', 'AP-h1']);
    assert.equal(r1.orders[0].items[0].qty, 2);
    assert.deepEqual(r1.orders[0].items[0], { id: pid, name: 'H-oil', volume: '4 л', price: 500, qty: 2 });
    assert.equal(r1.orders[1].status, 'DELIVERED');
    const raw = JSON.stringify(r1);
    assert.ok(!raw.includes('+7999') && !raw.includes('секретный') && !raw.includes('AP-h3'), 'чужие или личные данные в ответе');
    const r2 = await (await api('/api/orders/my', { as: U2 })).json();
    assert.deepEqual(r2.orders.map(o => o.orderNumber), ['AP-h3']);

    // скрытие: завершённый скрывается, активный и чужой — нет
    const h = await (await api('/api/orders/my/hide', { method: 'POST', as: U1, body: { orderNumbers: ['AP-h1', 'AP-h2', 'AP-h3'] } })).json();
    assert.deepEqual(h.hidden, ['AP-h1']);
    assert.deepEqual(h.skipped.sort(), ['AP-h2', 'AP-h3']);
    assert.deepEqual((await (await api('/api/orders/my', { as: U1 })).json()).orders.map(o => o.orderNumber), ['AP-h2']);
    assert.deepEqual((await (await api('/api/orders/my', { as: U2 })).json()).orders.map(o => o.orderNumber), ['AP-h3'], 'чужой заказ не тронут');
    assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE order_number = 'AP-h1'")).rows[0].n, 1, 'запись заказа осталась в учёте');

    // после отмены активный тоже можно скрыть
    await db.updateOrderStatus(a2.id, 'CANCELLED');
    assert.deepEqual((await (await api('/api/orders/my/hide', { method: 'POST', as: U1, body: { orderNumbers: ['AP-h2'] } })).json()).hidden, ['AP-h2']);
    assert.deepEqual((await (await api('/api/orders/my', { as: U1 })).json()).orders, []);

    // неверные данные
    assert.equal((await api('/api/orders/my/hide', { method: 'POST', as: U1, body: { orderNumbers: [] } })).status, 400);
    assert.equal((await api('/api/orders/my/hide', { method: 'POST', as: U1, body: { orderNumbers: [123] } })).status, 400);
    assert.equal((await api('/api/orders/my/hide', { method: 'POST', body: { orderNumbers: ['AP-h3'] } })).status, 401);
});
