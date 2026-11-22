'use strict';
// PostgreSQL integration test: duplicate and competing courier callbacks must have one terminal result.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('параллельные callback «Доставлен» фиксируют доставку и уведомление только один раз', { skip }, async (t) => {
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

    // DB adapter methods must reject unsafe JS integers before reaching PostgreSQL.
    const unsafeId = Number.MAX_SAFE_INTEGER + 1;
    assert.equal(await db.updateOrderStatus(unsafeId, 'CANCELLED'), false);
    assert.equal(await db.updateProduct(unsafeId, { name: 'must not write' }), null);
    assert.equal(await db.getOrderById(unsafeId), null);
    assert.equal(await db.getProductById(unsafeId), null);
    assert.equal((await db.acceptRouteStop(unsafeId, 1)).status, 'not_found');
    assert.equal((await db.acceptRouteStop(1, unsafeId)).status, 'not_found');
    assert.equal((await db.startRouteIfAllAccepted(unsafeId)).status, 'not_found');
    assert.equal(await db.setStopStage(unsafeId, 'enroute'), null);
    assert.equal((await db.failDeliveryStop(unsafeId, 'invalid')).status, 'not_found');
    assert.equal((await db.completeDeliveryStop(unsafeId)).status, 'not_found');
    assert.equal((await db.rateCourierForStop(unsafeId, 1, 123456, 5)).status, 'invalid');

    const suffix = String(Date.now()) + '-' + process.pid;
    const courier = await db.createCourier({
        name: 'Тест конкурентной доставки',
        phone: '1',
        telegram_id: 800000000 + (process.pid % 100000000),
        telegram_user: 'complete-race-' + suffix,
        vehicle_type: 'авто'
    });

    const created = [];
    const stopIds = [];
    const makeShipment = async (tag, prepare = true) => {
        const order = await db.createOrder({
            order_number: 'AP-cdr-' + suffix.slice(-12) + '-' + tag,
            user_id: 880000000 + (process.pid % 100000000),
            user_name: 'Тест',
            name: 'Тест',
            phone: '1',
            address: 'Тестовый адрес',
            zone: 'spb',
            city: 'Санкт-Петербург',
            street: 'Тестовая',
            house: '1',
            items: [],
            subtotal: 0,
            total: 0,
            idempotency_key: 'cdr-' + suffix + '-' + tag
        });
        created.push(order.id);
        for (const status of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) {
            assert.equal(await db.updateOrderStatus(order.id, status), true);
        }
        const route = await db.createRoute({
            route_number: 'C' + suffix.slice(-6) + '-' + tag.slice(0, 4),
            route_date: new Date().toISOString().slice(0, 10),
            courier_id: courier.id,
            status: 'assigned',
            total_orders: 1,
            enforceReadyOrders: true,
            stops: [{
                order_id: String(order.id),
                order_number: order.order_number,
                address: order.address,
                phone: '1',
                client_name: 'Тест',
                client_chat_id: order.user_id,
                amount_to_pay: 0,
                payment_status: 'paid',
                status: 'pending',
                comment: ''
            }]
        });
        const stopId = route.stops[0].id;
        stopIds.push(stopId);
        if (prepare) {
            const accepted = await db.acceptRouteStop(route.id, stopId);
            assert.equal(accepted.status, 'accepted');
            assert.equal((await db.startRouteIfAllAccepted(route.id)).status, 'started');
        }
        return { order, route, stopId };
    };

    t.after(async () => {
        if (stopIds.length) await pool.query('DELETE FROM notification_outbox WHERE dedup_key = ANY($1::text[])', [
            [...stopIds.map(id => `stop-delivered:${id}`), ...stopIds.flatMap(id => [`complete-admin-rollback:${id}`, `complete-admin-ok:${id}`])]
        ]);
        await pool.query('DELETE FROM route_stops WHERE route_id IN (SELECT id FROM delivery_routes WHERE courier_id = $1)', [courier.id]);
        await pool.query('DELETE FROM delivery_routes WHERE courier_id = $1', [courier.id]);
        if (created.length) await pool.query('DELETE FROM orders WHERE id = ANY($1::int[])', [created]);
        await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
        await pool.end();
    });

    const ownership = await makeShipment('ownership', false);
    assert.equal((await db.acceptRouteStop(ownership.route.id, ownership.stopId, { expectedCourierId: null })).status, 'not_assigned');
    assert.equal((await db.acceptRouteStop(ownership.route.id, ownership.stopId, { expectedCourierId: courier.id + 999999 })).status, 'not_assigned');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [ownership.stopId])).rows[0].status, 'pending');
    assert.equal((await db.completeDeliveryStop(ownership.stopId, { expectedCourierId: courier.id })).status, 'forbidden',
        'pending stop cannot be completed before courier acceptance and route start');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [ownership.order.id])).rows[0].status, 'READY_FOR_SHIPMENT');
    await pool.query('UPDATE couriers SET is_active = FALSE WHERE id = $1', [courier.id]);
    assert.equal((await db.acceptRouteStop(ownership.route.id, ownership.stopId, { expectedCourierId: courier.id })).status, 'courier_inactive');
    await pool.query('UPDATE couriers SET is_active = TRUE WHERE id = $1', [courier.id]);
    assert.equal((await db.acceptRouteStop(ownership.route.id, ownership.stopId, { expectedCourierId: courier.id })).status, 'accepted');

    // Accepted is still not deliverable until the route has started.
    assert.equal((await db.completeDeliveryStop(ownership.stopId, { expectedCourierId: courier.id })).status, 'forbidden');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [ownership.stopId])).rows[0].status, 'accepted');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [ownership.order.id])).rows[0].status, 'READY_FOR_SHIPMENT',
        'premature completion must not mutate the order');

    assert.equal((await db.startRouteIfAllAccepted(ownership.route.id, { expectedCourierId: null })).status, 'not_assigned');
    assert.equal((await db.getRouteById(ownership.route.id)).status, 'assigned');
    assert.equal((await db.startRouteIfAllAccepted(ownership.route.id, { expectedCourierId: courier.id + 999999 })).status, 'not_assigned');
    assert.equal((await db.getRouteById(ownership.route.id)).status, 'assigned');
    await pool.query('UPDATE couriers SET is_active = FALSE WHERE id = $1', [courier.id]);
    assert.equal((await db.startRouteIfAllAccepted(ownership.route.id, { expectedCourierId: courier.id })).status, 'courier_inactive');
    await pool.query('UPDATE couriers SET is_active = TRUE WHERE id = $1', [courier.id]);
    assert.equal((await db.startRouteIfAllAccepted(ownership.route.id, { expectedCourierId: courier.id })).status, 'started');

    assert.equal(await db.setStopStage(ownership.stopId, 'enroute', { expectedCourierId: null }), null);
    assert.equal((await pool.query('SELECT stage FROM route_stops WHERE id = $1', [ownership.stopId])).rows[0].stage, null);
    assert.equal(await db.setStopStage(ownership.stopId, 'enroute', { expectedCourierId: courier.id + 999999 }), null);
    assert.equal((await pool.query('SELECT stage FROM route_stops WHERE id = $1', [ownership.stopId])).rows[0].stage, null);
    await pool.query('UPDATE couriers SET is_active = FALSE WHERE id = $1', [courier.id]);
    assert.equal(await db.setStopStage(ownership.stopId, 'enroute', { expectedCourierId: courier.id }), null);
    await pool.query('UPDATE couriers SET is_active = TRUE WHERE id = $1', [courier.id]);
    assert.ok(await db.setStopStage(ownership.stopId, 'enroute', { expectedCourierId: courier.id }));
    assert.ok(await db.setStopStage(ownership.stopId, 'arrived', { expectedCourierId: courier.id }));

    const first = await makeShipment('a');
    assert.equal((await db.completeDeliveryStop(first.stopId, { expectedCourierId: null })).status, 'not_assigned');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [first.stopId])).rows[0].status, 'in_progress');
    // Проверка владельца должна выполняться внутри транзакции, а не только в Telegram callback.
    assert.equal((await db.completeDeliveryStop(first.stopId, { expectedCourierId: courier.id + 999999 })).status, 'not_assigned');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [first.stopId])).rows[0].status, 'in_progress',
        'чужой курьер не может завершить остановку через прямой вызов DB-операции');
    await pool.query('UPDATE couriers SET is_active = FALSE WHERE id = $1', [courier.id]);
    assert.equal((await db.completeDeliveryStop(first.stopId, { expectedCourierId: courier.id })).status, 'courier_inactive');
    await pool.query('UPDATE couriers SET is_active = TRUE WHERE id = $1', [courier.id]);
    const results = await Promise.all([
        db.completeDeliveryStop(first.stopId),
        db.completeDeliveryStop(first.stopId)
    ]);
    assert.deepEqual(results.map(x => x.status).sort(), ['already', 'completed']);
    const stored = (await pool.query(
        `SELECT rs.status AS stop_status, o.status AS order_status
           FROM route_stops rs JOIN orders o ON o.id::text = rs.order_id
          WHERE rs.id = $1`, [first.stopId]
    )).rows[0];
    assert.equal(stored.stop_status, 'delivered');
    assert.equal(stored.order_status, 'COMPLETED');
    const notices = await pool.query(
        "SELECT COUNT(*)::int AS n FROM notification_outbox WHERE dedup_key = $1",
        [`stop-delivered:${first.stopId}`]
    );
    assert.equal(notices.rows[0].n, 1, 'в outbox ровно одно уведомление клиенту');

    const transactional = await makeShipment('tx');
    const { enqueue } = require('../bot/outbox');
    const adminRollbackKey = 'complete-admin-rollback:' + transactional.stopId;
    await assert.rejects(db.completeDeliveryStop(transactional.stopId, {
        afterComplete: async ({ client }) => {
            await enqueue(client, { bot: 'admin', dedupKey: adminRollbackKey, payload: { chat_id: '1', text: 'Доставлено' } });
            throw new Error('simulate admin notification enqueue failure');
        }
    }), /simulate admin notification enqueue failure/);
    const rolledBack = (await pool.query(
        `SELECT rs.status AS stop_status, o.status AS order_status
           FROM route_stops rs JOIN orders o ON o.id::text = rs.order_id
          WHERE rs.id = $1`, [transactional.stopId]
    )).rows[0];
    assert.equal(rolledBack.stop_status, 'in_progress', 'остановка откатывается при сбое admin outbox');
    assert.equal(rolledBack.order_status, 'SHIPPING', 'заказ откатывается при сбое admin outbox');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notification_outbox WHERE dedup_key = $1', [adminRollbackKey])).rows[0].n, 0);

    const adminKey = 'complete-admin-ok:' + transactional.stopId;
    assert.equal((await db.completeDeliveryStop(transactional.stopId, {
        afterComplete: async ({ client }) => {
            await enqueue(client, { bot: 'admin', dedupKey: adminKey, payload: { chat_id: '1', text: 'Доставлено' } });
        }
    })).status, 'completed');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notification_outbox WHERE dedup_key = $1', [adminKey])).rows[0].n, 1,
        'административное уведомление фиксируется вместе с доставкой');

    const second = await makeShipment('b');
    assert.equal((await db.failDeliveryStop(second.stopId, 'Нет авторизации', { expectedCourierId: null })).status, 'not_assigned');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [second.stopId])).rows[0].status, 'in_progress');
    assert.equal((await db.failDeliveryStop(second.stopId, 'Подмена владельца', { expectedCourierId: courier.id + 999999 })).status, 'not_assigned');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [second.stopId])).rows[0].status, 'in_progress',
        'чужой курьер не может отметить остановку недоставленной');
    await pool.query('UPDATE couriers SET is_active = FALSE WHERE id = $1', [courier.id]);
    assert.equal((await db.failDeliveryStop(second.stopId, 'Курьер отключён', { expectedCourierId: courier.id })).status, 'courier_inactive');
    await pool.query('UPDATE couriers SET is_active = TRUE WHERE id = $1', [courier.id]);
    const race = await Promise.all([
        db.completeDeliveryStop(second.stopId),
        db.failDeliveryStop(second.stopId, 'Тестовая причина')
    ]);
    const final = (await pool.query(
        `SELECT rs.status AS stop_status, o.status AS order_status
           FROM route_stops rs JOIN orders o ON o.id::text = rs.order_id
          WHERE rs.id = $1`, [second.stopId]
    )).rows[0];
    const delivered = final.stop_status === 'delivered' && final.order_status === 'COMPLETED';
    const failed = final.stop_status === 'failed' && final.order_status === 'DELIVERY_FAILED';
    assert.ok(delivered || failed, 'гонка должна завершиться одним согласованным терминальным состоянием');
    assert.equal(race.filter(x => x.status === 'completed' || x.status === 'failed').length, 1,
        'только один callback может зафиксировать терминальный результат');
    const raceNotice = await pool.query(
        "SELECT COUNT(*)::int AS n FROM notification_outbox WHERE dedup_key = $1",
        [`stop-delivered:${second.stopId}`]
    );
    assert.equal(raceNotice.rows[0].n, delivered ? 1 : 0,
        'уведомление о доставке появляется только если победил callback доставки');
});
