'use strict';
// Интеграционный тест транзакционного outbox для обычной смены статуса заказа.
const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('смена статуса и outbox-уведомления фиксируются или откатываются вместе', { skip }, async (t) => {
    Object.assign(process.env, {
        DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x',
        WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1',
        OUTBOX_DISABLED: '1'
    });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    const { enqueue } = require('../bot/outbox');
    await initDB();

    const suffix = Date.now().toString(36);
    const orderNumber = 'AP-status-' + suffix;
    const firstKey = 'status-outbox:' + suffix + ':CONFIRMED';
    const rollbackKey = 'status-outbox:' + suffix + ':ASSEMBLING';
    t.after(async () => {
        await pool.query('DELETE FROM notification_outbox WHERE dedup_key = ANY($1::text[])', [[firstKey, rollbackKey]]);
        await pool.query('DELETE FROM orders WHERE order_number = $1', [orderNumber]);
        await pool.end();
    });

    const order = await db.createOrder({
        order_number: orderNumber, user_id: '880001', user_name: 'Тестовый клиент',
        phone: '+70000000000', address: 'Тестовый адрес', zone: 'spb',
        city: 'СПб', street: 'Тестовая', house: '1', items: [],
        subtotal: 100, total: 100, idempotency_key: 'status-outbox-' + suffix
    });

    const changed = await db.updateOrderStatus(order.id, 'CONFIRMED', {
        afterUpdate: async ({ order: lockedOrder, client, status }) => {
            assert.equal(lockedOrder.order_number, orderNumber);
            assert.equal(lockedOrder.user_name, 'Тестовый клиент');
            assert.equal(lockedOrder.phone, '+70000000000');
            assert.equal(lockedOrder.address, 'Тестовый адрес');
            assert.equal(status, 'CONFIRMED');
            await enqueue(client, {
                bot: 'admin', dedupKey: firstKey,
                payload: { chat_id: '1', text: 'Заказ подтверждён' }
            });
        }
    });
    assert.equal(changed, true);
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status, 'CONFIRMED');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notification_outbox WHERE dedup_key = $1', [firstKey])).rows[0].n, 1);

    let calledOnAlready = false;
    assert.equal(await db.updateOrderStatus(order.id, 'CONFIRMED', {
        afterUpdate: async () => { calledOnAlready = true; }
    }), 'ALREADY');
    assert.equal(calledOnAlready, false, 'повторный статус не запускает повторную постановку');

    await assert.rejects(db.updateOrderStatus(order.id, 'ASSEMBLING', {
        afterUpdate: async ({ client }) => {
            await enqueue(client, {
                bot: 'admin', dedupKey: rollbackKey,
                payload: { chat_id: '1', text: 'Это уведомление должно откатиться' }
            });
            throw new Error('simulate failure after enqueue');
        }
    }), /simulate failure after enqueue/);

    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status, 'CONFIRMED',
        'статус заказа откатился');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notification_outbox WHERE dedup_key = $1', [rollbackKey])).rows[0].n, 0,
        'outbox-строка откатилась вместе со статусом');
});
