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
    const { deliverOrder } = require('./helpers/deliver-order');
    await initDB();
    const trackingBefore = (await pool.query(
        "SELECT EXISTS(SELECT 1 FROM app_flags WHERE flag = 'stock_tracking_enabled') AS enabled"
    )).rows[0].enabled;
    let pid = null;
    t.after(async () => {
        if (pid !== null) await pool.query('DELETE FROM products WHERE id = $1', [pid]);
        if (trackingBefore) {
            await pool.query("INSERT INTO app_flags (flag) VALUES ('stock_tracking_enabled') ON CONFLICT (flag) DO NOTHING");
        } else {
            await pool.query("DELETE FROM app_flags WHERE flag = 'stock_tracking_enabled'");
        }
        await pool.end();
    });

    await pool.query("DELETE FROM app_flags WHERE flag = 'stock_tracking_enabled'");
    assert.equal(await db.updateProduct(2147483647, { stock: 0 }), null, 'несуществующий товар не обновляется');
    assert.equal((await pool.query(
        "SELECT EXISTS(SELECT 1 FROM app_flags WHERE flag = 'stock_tracking_enabled') AS enabled"
    )).rows[0].enabled, false, 'неуспешное обновление не включает складской учёт');

    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');
    pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('T-oil', 1000, true, 10) RETURNING id")).rows[0].id;
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
    await deliverOrder(db, pool, o2);
    await db.updateOrderStatus(o2.id, 'CANCELLED');
    assert.equal(await stock(), 8, 'доставленный заказ остаток не возвращает');

    // Обход через промежуточный статус: доставлен -> новый -> отменён не должен вернуть товар второй раз
    assert.equal(await db.updateOrderStatus(o2.id, 'NEW'), 'CANCELLED_LOCKED', 'отменённый заказ закрыт');
    const o2b = await mk(1, 'k2b');
    assert.equal(await stock(), 7);
    await deliverOrder(db, pool, o2b);
    assert.equal(await db.updateOrderStatus(o2b.id, 'NEW'), 'TRANSITION_FORBIDDEN', 'COMPLETED -> NEW запрещено');
    assert.equal(await db.updateOrderStatus(o2b.id, 'SHIPPING'), 'TRANSITION_FORBIDDEN', 'COMPLETED -> SHIPPING запрещено');
    assert.equal(await db.updateOrderStatus(o2b.id, 'COMPLETED'), 'ALREADY', 'повторное завершение идемпотентно');
    assert.equal(await db.updateOrderStatus(o2b.id, 'ASSEMBLING'), 'TRANSITION_FORBIDDEN', 'COMPLETED -> ASSEMBLING запрещено');
    assert.equal((await pool.query('SELECT stock_deducted FROM orders WHERE id = $1', [o2b.id])).rows[0].stock_deducted, false, 'флаг снят при доставке');
    assert.equal(await db.updateOrderStatus(o2b.id, 'CANCELLED'), true, 'поздний возврат денег допустим');
    assert.equal(await stock(), 7, 'товар не вернулся: он у покупателя');
    // Заказ отменяется на этапе подготовки к отправке; обратные переходы запрещены.
    const o2c = await mk(1, 'k2c');
    assert.equal(await stock(), 6);
    for (const st of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) assert.equal(await db.updateOrderStatus(o2c.id, st), true, st);
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
    // Два последовательных callback «Доставлено»: один переход, одно уведомление, без нового списания.
    const deliveredOrder = await mk(1, 'k6');
    const courier = await db.createCourier({ name: 'Склад-тест', phone: '1', telegram_id: 900099999, telegram_user: 'stock-test', vehicle_type: 'авто' });
    for (const status of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) {
        assert.equal(await db.updateOrderStatus(deliveredOrder.id, status), true);
    }
    const routeId = (await pool.query(
        `INSERT INTO delivery_routes(route_number, route_date, courier_id, status, total_orders) VALUES ('RL-DONE-TEST', CURRENT_DATE, $1, 'assigned', 1) RETURNING id`, [courier.id]
    )).rows[0].id;
    const stopId = (await pool.query(
        `INSERT INTO route_stops(route_id, order_id, order_number, stop_number, address, status, client_chat_id)
         VALUES ($1, $2, $3, 1, 'Test address', 'pending', 987654321) RETURNING id`,
        [routeId, String(deliveredOrder.id), deliveredOrder.order_number]
    )).rows[0].id;
    assert.equal((await db.acceptRouteStop(routeId, stopId)).status, 'accepted');
    assert.equal((await db.startRouteIfAllAccepted(routeId)).status, 'started');

    const firstDone = await db.completeDeliveryStop(stopId);
    const secondDone = await db.completeDeliveryStop(stopId);
    assert.equal(firstDone.status, 'completed', 'первое нажатие завершает доставку');
    assert.equal(secondDone.status, 'already', 'повторное нажатие распознаётся как повтор');
    assert.equal(await stock(), 3, 'после двух done товар не списан повторно');
    const deliveredState = (await pool.query(
        'SELECT status, stock_deducted FROM orders WHERE id = $1', [deliveredOrder.id]
    )).rows[0];
    assert.equal(deliveredState.status, 'COMPLETED');
    assert.equal(deliveredState.stock_deducted, false);
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [stopId])).rows[0].status, 'delivered');
    const routeState = (await pool.query(
        'SELECT status, completed FROM delivery_routes WHERE id = $1', [routeId]
    )).rows[0];
    assert.equal(routeState.status, 'completed');
    assert.equal(routeState.completed, 1);
    const noticeCount = (await pool.query(
        'SELECT count(*)::int AS n FROM notification_outbox WHERE dedup_key = $1',
        [`stop-delivered:${stopId}`]
    )).rows[0].n;
    assert.equal(noticeCount, 1, 'клиентское уведомление поставлено в outbox ровно один раз');
    await pool.query('DELETE FROM notification_outbox WHERE dedup_key = $1', [`stop-delivered:${stopId}`]);

    await pool.query('DELETE FROM route_stops WHERE route_id = $1', [routeId]);
    await pool.query('DELETE FROM delivery_routes WHERE id = $1', [routeId]);
    await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
    await db.deleteAllOrders();
    assert.equal(await stock(), 6, 'вернули только активные k4 и k5; доставленные k2, k2b и k6 не вернули');
    assert.equal((await pool.query('SELECT count(*)::int n FROM orders')).rows[0].n, 0);

    // Когда остаток последнего товара исчерпан, учёт не должен отключаться автоматически.
    await mk(6, 'k7');
    assert.equal(await stock(), 0, 'последний остаток списан до нуля');
    const publicProduct = (await db.getPublicCatalog()).find(p => p.id === pid);
    assert.equal(publicProduct.in_stock, false, 'витрина показывает отсутствие товара при нулевом остатке');
    await assert.rejects(
        () => mk(1, 'k8'),
        (error) => error.code === 'OUT_OF_STOCK',
        'следующий заказ отклоняется, а не проходит при нулевом остатке'
    );
    assert.equal(await stock(), 0, 'нехватка товара не меняет остаток');
    assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE order_number = 'AP-k8'")).rows[0].n, 0,
        'заказ с недостаточным остатком не сохраняется');
    await db.deleteAllOrders();
    assert.equal(await stock(), 6, 'тестовый заказ очищен, остаток восстановлен');
});
