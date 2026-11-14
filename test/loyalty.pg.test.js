'use strict';
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js). Без неё часть тестов пропускается.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { resolveDiscount } = require('../bot/discount');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';
const TOKEN = '123456:TEST_TOKEN_FOR_UNIT_TESTS';

test('скидка: берётся большая из шкалы и промокода, они не суммируются', () => {
    assert.deepEqual(resolveDiscount({ promoPct: 0, loyaltyPct: 3 }), { discount: 3, discountCode: null, discountSource: 'loyalty' });
    assert.deepEqual(resolveDiscount({ promoPct: 10, promoCode: 'SALE', loyaltyPct: 5 }), { discount: 10, discountCode: 'SALE', discountSource: 'promo' });
    assert.deepEqual(resolveDiscount({ promoPct: 5, promoCode: 'SALE', loyaltyPct: 5 }), { discount: 5, discountCode: null, discountSource: 'loyalty' }, 'равные: промокод не тратится');
    assert.deepEqual(resolveDiscount({ promoPct: 3, promoCode: 'SALE', loyaltyPct: 7 }), { discount: 7, discountCode: null, discountSource: 'loyalty' });
    assert.deepEqual(resolveDiscount({}), { discount: 0, discountCode: null, discountSource: null });
    assert.deepEqual(resolveDiscount({ promoPct: NaN, loyaltyPct: -5 }), { discount: 0, discountCode: null, discountSource: null });
});

const initDataFor = (id) => {
    const p = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAHtest', user: JSON.stringify({ id, first_name: 'T' }) };
    const dcs = Object.keys(p).sort().map(k => `${k}=${p[k]}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    return new URLSearchParams({ ...p, hash: crypto.createHmac('sha256', secret).update(dcs).digest('hex') }).toString();
};

test('скидка по обороту: уровни, только доставленные заказы, без доставки', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    const { verifyInitData } = require('../bot/telegram-auth');
    const { registerLoyaltyRoutes } = require('../bot/loyalty-routes');
    await initDB();
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');
    const pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('L-oil', 1, true, 1000) RETURNING id")).rows[0].id;

    const tiers = await db.getLoyaltyTiers();
    assert.deepEqual(tiers.map(x => [x.at, x.percent, x.name]), [[0, 3, 'Железный'], [15000, 5, 'Бронзовый'], [40000, 7, 'Серебряный'], [100000, 10, 'Золотой']]);

    const app = express(); app.use(express.json());
    registerLoyaltyRoutes(app, { db, rateLimit: () => (q, r, n) => n(), sanitizeLog: String,
        authenticatedTelegramUser: (req) => { const a = verifyInitData(req.header('X-Telegram-Init-Data'), TOKEN); return a && a.user && a.user.id ? a.user : null; } });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    t.after(async () => { server.close(); await pool.query('DELETE FROM products WHERE id = $1', [pid]); await pool.end(); });
    const get = async (as) => fetch(`http://127.0.0.1:${server.address().port}/api/loyalty`, { headers: as ? { 'X-Telegram-Init-Data': as } : {} });

    let n = 0;
    const order = async (uid, goods, status, delivery = 0) => {
        n++; const o = await db.createOrder({ order_number: 'AP-L' + n, user_id: uid, user_name: 'T', phone: '1', address: 'a', zone: 'spb', city: 'c', street: 's', house: '1',
            items: [{ productId: pid, qty: 1, name: 'x', price: goods }], subtotal: goods, total: goods + delivery, delivery_cost: delivery, idempotency_key: 'L' + n });
        if (status !== 'NEW') await db.updateOrderStatus(o.id, status);
        return o;
    };

    // новый клиент: 3 %, до следующего уровня 15 000
    let l = await db.getLoyalty(900);
    assert.equal(l.turnover, 0); assert.equal(l.percent, 3); assert.equal(l.name, 'Железный');
    assert.deepEqual(l.next, { at: 15000, percent: 5, name: 'Бронзовый' });

    // не считаются: новый, в пути, отменённый заказы; доставка не входит в оборот
    await order(900, 50000, 'NEW'); await order(900, 50000, 'SHIPPING'); await order(900, 50000, 'CANCELLED');
    assert.equal((await db.getLoyalty(900)).percent, 3);
    await order(900, 14999, 'DELIVERED', 300);
    l = await db.getLoyalty(900);
    assert.equal(l.turnover, 14999, 'доставка 300 ₽ не входит в оборот'); assert.equal(l.percent, 3);
    await order(900, 1, 'COMPLETED');
    l = await db.getLoyalty(900);
    assert.equal(l.turnover, 15000); assert.equal(l.percent, 5); assert.equal(l.name, 'Бронзовый'); assert.equal(l.from, 15000);
    assert.deepEqual(l.next, { at: 40000, percent: 7, name: 'Серебряный' });
    await order(900, 25000, 'DELIVERED');
    assert.equal((await db.getLoyalty(900)).percent, 7);
    await order(900, 60000, 'DELIVERED');
    l = await db.getLoyalty(900);
    assert.equal(l.percent, 10); assert.equal(l.name, 'Золотой'); assert.equal(l.next, null);

    // чужой оборот не влияет
    assert.equal((await db.getLoyalty(901)).percent, 3);

    // API: только по подписи Telegram, отдаёт свои данные
    assert.equal((await get()).status, 401);
    assert.equal((await get(initDataFor(900).replace(/hash=[0-9a-f]+/, 'hash=' + '1'.repeat(64)))).status, 401);
    const j = await (await get(initDataFor(900))).json();
    assert.equal(j.success, true); assert.equal(j.loyalty.percent, 10); assert.equal(j.loyalty.turnover, 100000);
    const j2 = await (await get(initDataFor(901))).json();
    assert.equal(j2.loyalty.percent, 3); assert.equal(j2.loyalty.turnover, 0);
});
