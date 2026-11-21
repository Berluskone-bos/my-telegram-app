'use strict';
// Нужна база: TEST_DATABASE_URL. Статус «Не доставлен» (DELIVERY_FAILED): переходы, повторная отправка, отмена, этапы остановки.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('«Не доставлен»: статус заказа, повторная отправка, отмена возвращает товар, этапы остановки', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    await initDB();
    await pool.query('DELETE FROM notification_outbox');
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');
    const pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('T-fail', 500, true, 10) RETURNING id")).rows[0].id;
    const courier = await db.createCourier({ name: 'Курьер-недоставка', phone: '1', telegram_id: 900077, telegram_user: 'f', vehicle_type: 'авто' });
    t.after(async () => {
        await pool.query("DELETE FROM notification_outbox WHERE dedup_key LIKE 'stage-outbox-%'");
        await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes');
        await pool.query("DELETE FROM orders WHERE order_number LIKE 'AP-df%'");
        await pool.query('DELETE FROM products WHERE id = $1', [pid]);
        await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
        await pool.end();
    });
    const stock = async () => (await pool.query('SELECT stock FROM products WHERE id = $1', [pid])).rows[0].stock;
    const status = async (id) => (await pool.query('SELECT status FROM orders WHERE id = $1', [id])).rows[0].status;
    const ship = async (key, qty = 1) => {
        const o = await db.createOrder({ order_number: 'AP-' + key, user_id: 777031, user_name: 'К', name: 't', phone: '1', address: 'СПб, ул. Т, д. 1',
            zone: 'spb', city: 'c', street: 's', house: '1', items: [{ productId: pid, qty, name: 'T-fail' }], subtotal: 500 * qty, total: 500 * qty, idempotency_key: key });
        for (const s of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) assert.equal(await db.updateOrderStatus(o.id, s), true);
        const route = await db.createRoute({ route_number: 'RL-' + key.slice(-4), route_date: '2026-11-14', courier_id: courier.id, status: 'assigned', total_orders: 1, enforceReadyOrders: true,
            stops: [{ order_id: String(o.id), order_number: o.order_number, address: o.address, phone: '1', client_name: 'К', client_chat_id: o.user_id, amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: '' }] });
        const stopId = route.stops[0].id;
        assert.equal((await db.acceptRouteStop(route.id, stopId)).status, 'accepted');
        assert.equal((await db.startRouteIfAllAccepted(route.id)).status !== 'forbidden', true);
        return { o, route, stopId };
    };

    // Этапы остановки: сохраняются, повтор не «меняет», назад («У клиента» → «В пути») нельзя
    const a = await ship('df1', 2);
    assert.equal(await stock(), 8);
    const { enqueue } = require('../bot/outbox');
    const stageKey = 'stage-outbox-enroute:' + a.stopId;
    assert.ok(await db.setStopStage(a.stopId, 'enroute', {
        afterUpdate: async ({ client, stop, stage }) => {
            assert.equal(stop.id, a.stopId);
            assert.equal(stage, 'enroute');
            await enqueue(client, { bot: 'client', dedupKey: stageKey, payload: { chat_id: '777031', text: 'Курьер выехал' } });
        }
    }), 'первое «В пути» меняет этап');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notification_outbox WHERE dedup_key = $1', [stageKey])).rows[0].n, 1,
        'уведомление записано в той же транзакции');
    let duplicateCallbackCalled = false;
    assert.equal(await db.setStopStage(a.stopId, 'enroute', {
        afterUpdate: async () => { duplicateCallbackCalled = true; }
    }), null, 'повтор — без изменения');
    assert.equal(duplicateCallbackCalled, false, 'повторный этап не создаёт повторное уведомление');

    const rollbackKey = 'stage-outbox-rollback:' + a.stopId;
    await assert.rejects(db.setStopStage(a.stopId, 'arrived', {
        afterUpdate: async ({ client }) => {
            await enqueue(client, { bot: 'client', dedupKey: rollbackKey, payload: { chat_id: '777031', text: 'rollback' } });
            throw new Error('simulate outbox failure');
        }
    }), /simulate outbox failure/);
    assert.equal((await pool.query('SELECT stage FROM route_stops WHERE id = $1', [a.stopId])).rows[0].stage, 'enroute',
        'этап откатывается при ошибке outbox');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notification_outbox WHERE dedup_key = $1', [rollbackKey])).rows[0].n, 0,
        'outbox запись откатывается вместе с этапом');
    assert.ok(await db.setStopStage(a.stopId, 'arrived'));
    assert.equal(await db.setStopStage(a.stopId, 'enroute'), null, 'после «У клиента» вернуться в «В пути» нельзя');
    assert.equal(await db.setStopStage(a.stopId, 'bogus'), null);

    // Недоставка: остановка failed, заказ — DELIVERY_FAILED (не «В доставке»), маршрут завершён
    assert.equal(await status(a.o.id), 'SHIPPING');
    assert.equal((await db.failDeliveryStop(a.stopId, 'Клиента нет дома')).status, 'failed');
    assert.equal(await status(a.o.id), 'DELIVERY_FAILED');
    assert.equal((await db.failDeliveryStop(a.stopId, 'Клиента нет дома')).status, 'already', 'повтор безопасен');
    assert.equal(await db.setStopStage(a.stopId, 'enroute'), null, 'у закрытой остановки этап не меняется');
    assert.equal(await stock(), 8, 'товар пока у курьера/на складе возврата: остаток не меняется');
    assert.equal((await db.completeDeliveryStop(a.stopId)).status !== 'completed', true, 'недоставленный нельзя «доставить» старой кнопкой');
    assert.equal(await status(a.o.id), 'DELIVERY_FAILED');

    // Причина видна в списке заказов админки
    const listed = (await db.getOrdersPage(1, 50)).items.find(x => x.id === a.o.id);
    assert.equal(listed.status, 'DELIVERY_FAILED');
    assert.equal(listed.fail_reason, 'Клиента нет дома');

    // Запрещённые переходы: сразу «Доставлен» без нового рейса нельзя; можно — на повторную отправку или в отмену
    for (const bad of ['NEW', 'CONFIRMED', 'ASSEMBLING', 'SHIPPING', 'COMPLETED']) {
        assert.equal(await db.updateOrderStatus(a.o.id, bad), 'TRANSITION_FORBIDDEN', 'DELIVERY_FAILED → ' + bad);
    }
    assert.equal(await db.updateOrderStatus(a.o.id, 'READY_FOR_SHIPMENT'), true, 'повторная отправка');
    // и снова в новый рейс: заказ готов к отправке, прежняя остановка не мешает
    const again = await db.createRoute({ route_number: 'RL-df1b', route_date: '2026-11-15', courier_id: courier.id, status: 'assigned', total_orders: 1, enforceReadyOrders: true,
        stops: [{ order_id: String(a.o.id), order_number: a.o.order_number, address: a.o.address, phone: '1', client_name: 'К', client_chat_id: a.o.user_id, amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: '' }] });
    assert.ok(again && again.stops.length === 1, 'заказ можно включить в новый маршрут');
    assert.equal(await stock(), 8);

    // Отмена из «Не доставлен» возвращает товар на склад ровно один раз
    const b = await ship('df2', 3);
    assert.equal(await stock(), 5);
    await db.setStopStage(b.stopId, 'enroute');
    assert.equal((await db.failDeliveryStop(b.stopId, 'Неверный адрес')).status, 'failed');
    assert.equal(await status(b.o.id), 'DELIVERY_FAILED');
    assert.equal(await db.updateOrderStatus(b.o.id, 'CANCELLED'), true);
    assert.equal(await stock(), 8, 'остаток вернулся');
    assert.equal(await db.updateOrderStatus(b.o.id, 'CANCELLED'), 'ALREADY');
    assert.equal(await stock(), 8, 'повтор не возвращает второй раз');
});
