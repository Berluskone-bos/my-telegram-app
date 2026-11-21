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

    const suffix = String(Date.now()) + '-' + process.pid;
    const courier = await db.createCourier({
        name: 'Тест конкурентной доставки',
        phone: '1',
        telegram_id: 800000000 + (process.pid % 100000000),
        telegram_user: 'complete-race-' + suffix,
        vehicle_type: 'авто'
    });

    const created = [];
    const makeShipment = async (tag) => {
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
            route_number: 'CDR-' + suffix.slice(-8) + '-' + tag,
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
        const accepted = await db.acceptRouteStop(route.id, stopId);
        assert.equal(accepted.status, 'accepted');
        assert.equal((await db.startRouteIfAllAccepted(route.id)).status, 'started');
        return { order, route, stopId };
    };

    t.after(async () => {
        await pool.query("DELETE FROM notification_outbox WHERE dedup_key LIKE $1", ['stop-delivered:%']);
        await pool.query('DELETE FROM route_stops WHERE route_id IN (SELECT id FROM delivery_routes WHERE courier_id = $1)', [courier.id]);
        await pool.query('DELETE FROM delivery_routes WHERE courier_id = $1', [courier.id]);
        if (created.length) await pool.query('DELETE FROM orders WHERE id = ANY($1::int[])', [created]);
        await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
        await pool.end();
    });

    const first = await makeShipment('a');
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

    const second = await makeShipment('b');
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
