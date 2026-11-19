'use strict';
// Нужна база: TEST_DATABASE_URL. Настоящий сервер bot.js (Telegram подменён): код друга, бонусы, свой код.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

function signedInitData(botToken, user) {
    const f = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH', user: JSON.stringify(user) };
    const check = Object.keys(f).sort().map(k => `${k}=${f[k]}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    f.hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams(f).toString();
}

test('рефералы через API: код друга, баланс, списание не более 20 %, свой код отклоняется', { skip }, async (t) => {
    process.env.DATABASE_URL = DB;
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    const { deliverOrder } = require('./helpers/deliver-order');
    await initDB();
    const INV = 880011, FR = 880012;
    const clean = async () => {
        await pool.query('DELETE FROM bonus_ledger WHERE user_id IN ($1, $2)', [INV, FR]);
        await pool.query('DELETE FROM notification_outbox');
        await pool.query('DELETE FROM orders WHERE user_id IN ($1, $2)', [INV, FR]);
    };
    await clean();
    const pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('RA-oil', 1000, true, 1000) RETURNING id")).rows[0].id;
    const port = 3800 + Math.floor(Math.random() * 90);
    const token = '1:reftest';
    const child = spawn(process.execPath, ['-r', path.join(__dirname, 'fake-telegram-preload.js'), path.join(__dirname, '..', 'bot', 'bot.js')], {
        env: { ...process.env, PORT: String(port), DATABASE_URL: DB, BOT_TOKEN: token, WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y',
               WEBHOOK_SECRET: 's'.repeat(32), ADMIN_CHAT_ID: '4242', OUTBOX_DISABLED: '1', NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
    t.after(async () => { child.kill(); await clean(); await pool.query('DELETE FROM products WHERE id = $1', [pid]); await pool.end(); });
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).status < 500) break; } catch { /* ещё не запустился */ }
        await new Promise(r => setTimeout(r, 250));
        if (i === 79) assert.fail('сервер не запустился:\n' + log.slice(-1500));
    }
    const hdr = (id) => ({ 'Content-Type': 'application/json', 'X-Telegram-Init-Data': signedInitData(token, { id, first_name: 'Т' }) });
    const order = (id, qty, phone, extra = {}) => fetch(`http://127.0.0.1:${port}/api/order`, {
        method: 'POST', headers: hdr(id),
        body: JSON.stringify({ items: [{ productId: pid, qty }], phone, address: 'СПб, ул. Т, д. 1', city: 'Санкт-Петербург', street: 'Т', house: '1',
            zone: 'spb', deliveryType: 'delivery', payment: 'cash', ...extra })
    });

    // без авторизации — нельзя
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/bonuses`)).status, 401);

    // приглашающий становится клиентом; его код постоянный и привязан к Telegram ID
    const r0 = await order(INV, 1, '+79990003333'); assert.equal(r0.status, 200, log.slice(-800));
    const b0 = await (await fetch(`http://127.0.0.1:${port}/api/bonuses`, { headers: hdr(INV) })).json();
    assert.equal(b0.referralCode, `REF-${INV}`); assert.equal(b0.balance, 0);
    assert.equal(b0.bonusPerOrder, 200); assert.equal(b0.minOrder, 6000); assert.equal(b0.maxSharePct, 20);

    // свой код — отказ; чужой телефон приглашающего — заказ принят, но без кода
    const own = await order(INV, 1, '+79990003333', { discountCode: `REF-${INV}` });
    assert.equal(own.status, 400); assert.match((await own.json()).error, /own_referral_code/);
    const samePhone = await (await order(FR, 1, '8 (999) 000-33-33', { discountCode: `REF-${INV}` })).json();
    assert.equal(samePhone.referralApplied, false); assert.equal(samePhone.referralReason, 'own_phone');
    const unknown = await (await order(FR, 1, '+79990004444', { discountCode: 'REF-999999999' })).json();
    assert.equal(unknown.referralApplied, false); assert.equal(unknown.referralReason, 'unknown_code');

    // друг заказывает на сумму выше порога: код принят, дополнительной скидки нет (только его обычная по карте)
    const plain = await (await order(FR, 7, '+79990004444')).json();
    const withCode = await (await order(FR, 7, '+79990004444', { discountCode: `REF-${INV}` })).json();
    assert.equal(withCode.referralApplied, true);
    assert.equal(withCode.total, plain.total, 'код друга скидки не даёт');
    const row = (await pool.query('SELECT id, referrer_id FROM orders WHERE order_number = $1', [withCode.orderId])).rows[0];
    assert.equal(String(row.referrer_id), String(INV));

    // доставка — бонус приглашающему
    await deliverOrder(db, pool, await db.getOrderById(row.id));
    const b1 = await (await fetch(`http://127.0.0.1:${port}/api/bonuses`, { headers: hdr(INV) })).json();
    assert.equal(b1.balance, 200); assert.equal(b1.invitedOrders, 1);

    // списание: товаров на ~970 ₽ после скидки, можно не больше 20 % → 194, а не весь баланс
    const spend = await (await order(INV, 1, '+79990003333', { useBonuses: true })).json();
    assert.ok(spend.bonusUsed > 0 && spend.bonusUsed <= 200, 'списано ' + spend.bonusUsed);
    const noSpend = await (await order(INV, 1, '+79990003333')).json();
    assert.equal(noSpend.total - spend.total, spend.bonusUsed, 'итог уменьшен ровно на списанные бонусы');
    assert.ok(spend.bonusUsed <= Math.floor((noSpend.total) * 0.2 + 100), 'не более 20 % товаров');
    const b2 = await (await fetch(`http://127.0.0.1:${port}/api/bonuses`, { headers: hdr(INV) })).json();
    assert.equal(b2.balance, 200 - spend.bonusUsed);
});
