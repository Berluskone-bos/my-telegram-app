'use strict';
// Нужна база: TEST_DATABASE_URL. После выдачи самовывоза отмена не должна менять заказ, остаток или бонусы.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('отмена по номеру не отменяет PICKED_UP и не возвращает товар/бонусы', { skip }, async (t) => {
    const suffix = String(Date.now());
    const userId = 990000000 + (Number(suffix.slice(-6)) % 1000000);
    Object.assign(process.env, {
        DATABASE_URL: DB,
        WEBHOOK_SECRET: 's'.repeat(32),
        BOT_TOKEN: '1:x',
        WEB_APP_URL: 'https://x.y',
        WEBHOOK_URL: 'https://x.y',
        ADMIN_CHAT_ID: '1',
        OUTBOX_DISABLED: '1'
    });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    await initDB();

    const trackingBefore = (await pool.query(
        "SELECT EXISTS(SELECT 1 FROM app_flags WHERE flag = 'stock_tracking_enabled') AS enabled"
    )).rows[0].enabled;
    const pid = (await pool.query(
        "INSERT INTO products(name, price, active, stock) VALUES ('Pickup-test', 100, true, 10) RETURNING id"
    )).rows[0].id;
    await pool.query(
        "INSERT INTO bonus_ledger(user_id, delta, reason, note) VALUES ($1, 10, 'test_seed', 'pickup cancel test')",
        [userId]
    );
    const order = await db.createOrder({
        order_number: 'AP-pickup-' + suffix.slice(-8),
        user_id: userId,
        user_name: 'Тест самовывоза',
        name: 'Тест самовывоза',
        phone: '1',
        address: 'Самовывоз',
        zone: 'spb',
        city: 'Санкт-Петербург',
        street: 'Самовывоз',
        house: '1',
        delivery_type: 'pickup',
        items: [{ productId: pid, qty: 2, name: 'Pickup-test' }],
        subtotal: 200,
        total: 200,
        bonus_used: 5,
        idempotency_key: 'pickup-' + suffix
    });

    t.after(async () => {
        await pool.query('DELETE FROM bonus_ledger WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM orders WHERE id = $1', [order.id]);
        await pool.query('DELETE FROM products WHERE id = $1', [pid]);
        if (trackingBefore) {
            await pool.query("INSERT INTO app_flags (flag) VALUES ('stock_tracking_enabled') ON CONFLICT (flag) DO NOTHING");
        } else {
            await pool.query("DELETE FROM app_flags WHERE flag = 'stock_tracking_enabled'");
        }
        await pool.end();
    });

    const stock = async () => Number((await pool.query(
        'SELECT stock FROM products WHERE id = $1', [pid]
    )).rows[0].stock);
    assert.equal(await stock(), 8, 'при оформлении заказа списаны две единицы');

    for (const status of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_PICKUP', 'PICKED_UP']) {
        assert.equal(await db.updateOrderStatus(order.id, status), true, status);
    }
    assert.equal(await stock(), 8, 'после фактической выдачи остаток остаётся списанным');
    assert.equal((await pool.query(
        'SELECT stock_deducted FROM orders WHERE id = $1', [order.id]
    )).rows[0].stock_deducted, false);

    assert.equal(await db.cancelOrderByNumber(order.order_number), false,
        'отмена по номеру должна отклонить уже выданный самовывоз');
    assert.equal((await pool.query(
        'SELECT status FROM orders WHERE id = $1', [order.id]
    )).rows[0].status, 'PICKED_UP', 'статус выданного заказа не меняется');
    assert.equal(await stock(), 8, 'остаток не возвращается после выдачи');
    assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS n FROM bonus_ledger WHERE order_id = $1 AND reason = 'spend_refund'",
        [order.id]
    )).rows[0].n, 0, 'потраченные бонусы не возвращаются после выдачи');
});
