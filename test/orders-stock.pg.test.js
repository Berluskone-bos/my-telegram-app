'use strict';
// Нужна база: TEST_DATABASE_URL=postgres://… npm test (без переменной пропускается; в GitHub Actions база поднимается сама)
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('склад: отмена и удаление заказов возвращают остаток ровно один раз', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    await initDB();
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');
    const pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('T-oil', 1000, true, 10) RETURNING id")).rows[0].id;
    t.after(async () => { await pool.query('DELETE FROM products WHERE id = $1', [pid]); await pool.end(); });
    const stock = async () => (await pool.query('SELECT stock FROM products WHERE id = $1', [pid])).rows[0].stock;
    const mk = (qty, key) => db.createOrder({ order_number: 'AP-' + key, name: 't', phone: '1', zone: 'spb', city: 'c', street: 's', house: '1',
        items: [{ productId: pid, qty, name: 'T-oil' }], subtotal: 1000 * qty, total: 1000 * qty, idempotency_key: key });

    const o1 = await mk(3, 'k1');
    assert.equal(await stock(), 7, 'списано 3');
    assert.equal(await db.updateOrderStatus(o1.id, 'CANCELLED'), true);
    assert.equal(await stock(), 10, 'остаток вернулся');
    assert.equal(await db.updateOrderStatus(o1.id, 'CANCELLED'), true);
    assert.equal(await stock(), 10, 'повтор не возвращает второй раз');
    assert.equal(await db.updateOrderStatus(o1.id, 'SHIPPING'), 'CANCELLED_LOCKED', 'из CANCELLED назад нельзя');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [o1.id])).rows[0].status, 'CANCELLED');
    assert.equal(await db.updateOrderStatus(999999, 'CANCELLED'), false);

    const o2 = await mk(2, 'k2');
    assert.equal(await stock(), 8);
    await db.updateOrderStatus(o2.id, 'DELIVERED');
    await db.updateOrderStatus(o2.id, 'CANCELLED');
    assert.equal(await stock(), 8, 'доставленный заказ остаток не возвращает');

    await mk(1, 'k3'); await mk(2, 'k4');
    assert.equal(await stock(), 5);
    await db.cancelOrderByNumber('AP-k3');
    assert.equal(await stock(), 6);
    await db.cancelOrderByNumber('AP-k3');
    assert.equal(await stock(), 6, 'повторная отмена по номеру не меняет остаток');

    await mk(1, 'k5');
    assert.equal(await stock(), 5);
    await db.deleteAllOrders();
    assert.equal(await stock(), 8, 'вернули активные k4 и k5, доставленный k2 не вернули');
    assert.equal((await pool.query('SELECT count(*)::int n FROM orders')).rows[0].n, 0);
});
