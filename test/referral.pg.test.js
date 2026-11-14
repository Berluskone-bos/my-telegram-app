'use strict';
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js). Без неё тест пропускается.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReferralCode, bonusToSpend, qualifiesForReferralBonus, phoneKey } = require('../bot/referral');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('referral.js: правила без базы', () => {
    assert.equal(parseReferralCode('REF-123456789'), '123456789');
    assert.equal(parseReferralCode('ref-123456789'), '123456789');
    assert.equal(parseReferralCode('AP-1234'), null);
    assert.equal(parseReferralCode('REF-12'), null);
    assert.equal(bonusToSpend({ goodsTotal: 10000, balance: 5000, maxSharePct: 20, wantUse: true }), 2000, 'не больше 20 %');
    assert.equal(bonusToSpend({ goodsTotal: 10000, balance: 300, maxSharePct: 20, wantUse: true }), 300, 'не больше баланса');
    assert.equal(bonusToSpend({ goodsTotal: 10000, balance: 300, maxSharePct: 20, wantUse: false }), 0);
    assert.equal(qualifiesForReferralBonus(6000, 6000), false, 'ровно 6000 — не проходит');
    assert.equal(qualifiesForReferralBonus(6000.01, 6000), true);
    assert.equal(phoneKey('+7 (999) 111-22-33'), phoneKey('8 999 111 22 33'));
});

test('бонусы и рефералы: начисление, списание, возврат', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y', OUTBOX_DISABLED: '1' });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    await initDB();
    const INV = 880001, FR = 880002;           // приглашающий и друг
    const pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('R-oil', 1000, true, 1000) RETURNING id")).rows[0].id;
    const cleanup = async () => {
        await pool.query("DELETE FROM bonus_ledger WHERE user_id IN ($1, $2)", [INV, FR]);
        await pool.query("DELETE FROM notification_outbox WHERE dedup_key LIKE 'order-%' OR dedup_key LIKE 'cancel-%'").catch(() => {});
        await pool.query("DELETE FROM orders WHERE user_id IN ($1, $2)", [INV, FR]);
        await pool.query('DELETE FROM customer_profiles WHERE user_id IN ($1, $2)', [INV, FR]);
    };
    await cleanup();
    t.after(async () => { await cleanup(); await pool.query('DELETE FROM products WHERE id = $1', [pid]); await pool.end(); });

    let n = 0;
    const mk = (user, phone, total, extra = {}) => db.createOrder({
        order_number: `AP-ref${++n}-${process.pid}`, user_id: user, user_name: 'Т', phone, address: 'СПб, ул. А, д. 1',
        zone: 'spb', city: 'СПб', street: 'А', house: '1', items: [{ productId: pid, qty: 1, name: 'R-oil', volume: '4 л', price: 1000 }],
        subtotal: total, total, delivery_cost: 0, idempotency_key: `ref-${process.pid}-${n}`, ...extra
    });

    // приглашающий должен существовать как клиент: у него есть свой заказ и телефон
    const own = await mk(INV, '+79990001111', 1000);
    await db.updateOrderStatus(own.id, 'DELIVERED');
    assert.equal(await db.getBonusBalance(INV), 0, 'свой заказ без кода бонуса не даёт');

    // проверка кода
    assert.deepEqual(await db.resolveReferrer(String(INV), INV, '+79990002222'), { ok: false, reason: 'own_code' });
    assert.deepEqual(await db.resolveReferrer(String(INV), FR, '8 (999) 000-11-11'), { ok: false, reason: 'own_phone' });
    assert.deepEqual(await db.resolveReferrer('999999999', FR, '+79990002222'), { ok: false, reason: 'unknown_code' });
    assert.deepEqual(await db.resolveReferrer(String(INV), FR, '+79990002222'), { ok: true, referrerId: String(INV) });

    // заказ друга ровно на 6000 бонуса не даёт, 6500 — даёт; бонус только после доставки
    const small = await mk(FR, '+79990002222', 6000, { referrer_id: INV, referral_code: `REF-${INV}` });
    const big = await mk(FR, '+79990002222', 6500, { referrer_id: INV, referral_code: `REF-${INV}` });
    assert.equal(await db.getBonusBalance(INV), 0, 'до доставки бонуса нет');
    await db.updateOrderStatus(small.id, 'DELIVERED');
    assert.equal(await db.getBonusBalance(INV), 0, '6000 — не больше порога');
    await db.updateOrderStatus(big.id, 'DELIVERED');
    assert.equal(await db.getBonusBalance(INV), 200);
    await db.updateOrderStatus(big.id, 'COMPLETED');
    assert.equal(await db.getBonusBalance(INV), 200, 'повторного начисления нет');

    // доставка в сумму товаров не входит
    const withDelivery = await mk(FR, '+79990002222', 6300, { referrer_id: INV, delivery_cost: 500 });
    await db.updateOrderStatus(withDelivery.id, 'DELIVERED');
    assert.equal(await db.getBonusBalance(INV), 200, 'товары 5800 — бонуса нет');

    // отмена заказа после доставки аннулирует бонус, повторная отмена ничего не меняет
    assert.equal(await db.updateOrderStatus(big.id, 'CANCELLED'), true);
    assert.equal(await db.getBonusBalance(INV), 0);
    assert.equal(await db.updateOrderStatus(big.id, 'CANCELLED'), 'ALREADY');
    assert.equal(await db.getBonusBalance(INV), 0);

    // списание: баланс 400, заказ на 1000 → не больше 20 % = 200
    const g1 = await mk(FR, '+79990002222', 7000, { referrer_id: INV });
    const g2 = await mk(FR, '+79990002222', 7000, { referrer_id: INV });
    await db.updateOrderStatus(g1.id, 'DELIVERED');
    await db.updateOrderStatus(g2.id, 'DELIVERED');
    assert.equal(await db.getBonusBalance(INV), 400);
    const s = await db.getSettings();
    assert.equal(bonusToSpend({ goodsTotal: 1000, balance: 400, maxSharePct: s.bonus_max_share_pct, wantUse: true }), 200);
    const paid = await mk(INV, '+79990001111', 800, { bonus_used: 200 });
    assert.equal(await db.getBonusBalance(INV), 200);
    // нельзя потратить больше, чем есть
    await assert.rejects(mk(INV, '+79990001111', 100, { bonus_used: 300 }), (e) => e.code === 'BONUS_INSUFFICIENT');
    assert.equal(await db.getBonusBalance(INV), 200, 'неудачный заказ баланс не меняет');
    const cnt = (await pool.query('SELECT COUNT(*)::int AS c FROM orders WHERE user_id = $1', [INV])).rows[0].c;
    assert.equal(cnt, 2, 'неудачный заказ не сохранился');
    // два заказа одновременно на весь остаток: проходит только один
    const race = await Promise.allSettled([mk(INV, '+79990001111', 900, { bonus_used: 200 }), mk(INV, '+79990001111', 900, { bonus_used: 200 })]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1, 'бонусы не списываются дважды');
    assert.equal(await db.getBonusBalance(INV), 0);

    // отмена заказа возвращает списанные бонусы
    assert.equal(await db.updateOrderStatus(paid.id, 'CANCELLED'), true);
    assert.equal(await db.getBonusBalance(INV), 200);
    await db.updateOrderStatus(paid.id, 'CANCELLED');
    assert.equal(await db.getBonusBalance(INV), 200, 'возврат один раз');

    const sum = await db.getBonusSummary(INV);
    assert.equal(sum.balance, 200);
    assert.ok(sum.history.length > 0);
});
