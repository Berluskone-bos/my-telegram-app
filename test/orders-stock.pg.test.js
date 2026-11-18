'use strict';
// Нужна база: TEST_DATABASE_URL=postgres://… npm test (без переменной пропускается; в GitHub Actions база поднимается сама)
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl(); // бросает ошибку, если база не тестовая
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
    assert.equal(await db.updateOrderStatus(o1.id, 'CANCELLED'), 'ALREADY');
    assert.equal(await stock(), 10, 'повтор не возвращает второй раз');
    assert.equal(await db.updateOrderStatus(o1.id, 'SHIPPING'), 'CANCELLED_LOCKED', 'из CANCELLED назад нельзя');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [o1.id])).rows[0].status, 'CANCELLED');
    assert.equal(await db.updateOrderStatus(999999, 'CANCELLED'), false);

    const o2 = await mk(2, 'k2');
    assert.equal(await stock(), 8);
    await db.updateOrderStatus(o2.id, 'DELIVERED');
    await db.updateOrderStatus(o2.id, 'CANCELLED');
    assert.equal(await stock(), 8, 'доставленный заказ остаток не возвращает');

    // Обход через промежуточный статус: доставлен -> новый -> отменён не должен вернуть товар второй раз
    assert.equal(await db.updateOrderStatus(o2.id, 'NEW'), 'CANCELLED_LOCKED', 'отменённый заказ закрыт');
    const o2b = await mk(1, 'k2b');
    assert.equal(await stock(), 7);
    await db.updateOrderStatus(o2b.id, 'DELIVERED');
    assert.equal(await db.updateOrderStatus(o2b.id, 'NEW'), 'TRANSITION_FORBIDDEN', 'DELIVERED -> NEW запрещено');
    assert.equal(await db.updateOrderStatus(o2b.id, 'SHIPPING'), 'TRANSITION_FORBIDDEN', 'DELIVERED -> SHIPPING запрещено');
    assert.equal(await db.updateOrderStatus(o2b.id, 'COMPLETED'), true, 'DELIVERED -> COMPLETED можно');
    assert.equal(await db.updateOrderStatus(o2b.id, 'ASSEMBLING'), 'TRANSITION_FORBIDDEN', 'COMPLETED -> ASSEMBLING запрещено');
    assert.equal((await pool.query('SELECT stock_deducted FROM orders WHERE id = $1', [o2b.id])).rows[0].stock_deducted, false, 'флаг снят при доставке');
    assert.equal(await db.updateOrderStatus(o2b.id, 'CANCELLED'), true, 'поздний возврат денег допустим');
    assert.equal(await stock(), 7, 'товар не вернулся: он у покупателя');
    // рабочие статусы двигаются в любую сторону
    const o2c = await mk(1, 'k2c');
    assert.equal(await stock(), 6);
    for (const st of ['CONFIRMED', 'ASSEMBLING', 'SHIPPING', 'ASSEMBLING', 'NEW']) assert.equal(await db.updateOrderStatus(o2c.id, st), true, st);
    assert.equal(await db.updateOrderStatus(o2c.id, 'CANCELLED'), true);
    assert.equal(await stock(), 7, 'рабочий заказ при отмене вернул товар');

    await mk(1, 'k3'); await mk(2, 'k4');
    assert.equal(await stock(), 4);
    await db.cancelOrderByNumber('AP-k3');
    assert.equal(await stock(), 5);
    await db.cancelOrderByNumber('AP-k3');
    assert.equal(await stock(), 5, 'повторная отмена по номеру не меняет остаток');

    await mk(1, 'k5');
    assert.equal(await stock(), 4);
    await db.deleteAllOrders();
    assert.equal(await stock(), 7, 'вернули активные k4 и k5, доставленные k2 и k2b не вернули');
    assert.equal((await pool.query('SELECT count(*)::int n FROM orders')).rows[0].n, 0);
});

test('доставка: два последовательных done завершают остановку, списание и уведомление только один раз', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y' });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    await initDB();

    const pid = (await pool.query(
        "INSERT INTO products(name, price, active, stock) VALUES ('T-delivery-idempotency', 1000, true, 10) RETURNING id"
    )).rows[0].id;
    let routeId, stopId, orderId;
    const suffix = Date.now().toString();
    const orderNumber = 'AP-DONE-' + suffix;
    const dedupKey = null;

    t.after(async () => {
        if (stopId) await pool.query('DELETE FROM route_stops WHERE id = $1', [stopId]);
        if (routeId) await pool.query('DELETE FROM delivery_routes WHERE id = $1', [routeId]);
        if (orderId) await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
        await pool.query("DELETE FROM notification_outbox WHERE dedup_key LIKE 'stop-delivered:%' AND payload->>'chat_id' = '987654321'");
        await pool.query('DELETE FROM products WHERE id = $1', [pid]);
        await pool.end();
    });

    const order = await db.createOrder({
        order_number: orderNumber, user_id: 987654321, user_name: 'Test', phone: '70000000000',
        zone: 'spb', city: 'Test', street: 'Test', house: '1',
        items: [{ productId: pid, qty: 2, name: 'T-delivery-idempotency' }],
        subtotal: 2000, total: 2000, idempotency_key: 'done-' + suffix
    });
    orderId = order.id;
    assert.equal((await pool.query('SELECT stock FROM products WHERE id = $1', [pid])).rows[0].stock, 8,
        'товар списан один раз при создании заказа');

    routeId = (await pool.query(
        "INSERT INTO delivery_routes(route_number, route_date, status, total_orders) VALUES ($1, CURRENT_DATE, 'in_progress', 1) RETURNING id",
        ['RL-D' + suffix.slice(-8)]
    )).rows[0].id;
    stopId = (await pool.query(
        `INSERT INTO route_stops(route_id, order_id, order_number, stop_number, address, status, client_chat_id)
         VALUES ($1, $2, $3, 1, 'Test address', 'in_progress', 987654321) RETURNING id`,
        [routeId, String(orderId), orderNumber]
    )).rows[0].id;

    const first = await db.completeDeliveryStop(stopId);
    const second = await db.completeDeliveryStop(stopId);

    assert.equal(first.status, 'completed', 'первое нажатие завершает доставку');
    assert.equal(second.status, 'already', 'второе нажатие распознаётся как повтор');
    const orderState = (await pool.query(
        'SELECT status, stock_deducted FROM orders WHERE id = $1', [orderId]
    )).rows[0];
    assert.equal(orderState.status, 'COMPLETED');
    assert.equal(orderState.stock_deducted, false);
    assert.equal((await pool.query('SELECT stock FROM products WHERE id = $1', [pid])).rows[0].stock, 8,
        'при завершении и повторном done остаток не списывается повторно');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [stopId])).rows[0].status, 'delivered');
    assert.equal((await pool.query('SELECT status, completed FROM delivery_routes WHERE id = $1', [routeId])).rows[0].status, 'completed');
    const notices = await pool.query(
        "SELECT count(*)::int AS n FROM notification_outbox WHERE dedup_key = $1",
        [`stop-delivered:${stopId}`]
    );
    assert.equal(notices.rows[0].n, 1, 'клиентское уведомление записано в outbox ровно один раз');
});
