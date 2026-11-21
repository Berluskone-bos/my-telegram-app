'use strict';
// Нужна база: TEST_DATABASE_URL. Проверяет, что конкурентные callback не создают цикл блокировок.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('параллельные «В пути» и «Доставлено» используют порядок блокировок заказ → маршрут → остановка', { skip }, async (t) => {
    const suffix = String(Date.now());
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

    const courier = await db.createCourier({
        name: 'Тест lock order',
        phone: '1',
        telegram_id: 700000000 + (Number(suffix.slice(-6)) % 1000000),
        telegram_user: 'lock-order-test',
        vehicle_type: 'авто'
    });
    const order = await db.createOrder({
        order_number: 'AP-lock-' + suffix.slice(-10),
        user_id: 990000000 + (Number(suffix.slice(-6)) % 1000000),
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
        idempotency_key: 'lock-' + suffix
    });
    const route = await db.createRoute({
        route_number: 'RL-' + suffix.slice(-8),
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

    t.after(async () => {
        await pool.query('DELETE FROM route_stops WHERE route_id = $1', [route.id]);
        await pool.query('DELETE FROM delivery_routes WHERE id = $1', [route.id]);
        await pool.query('DELETE FROM orders WHERE id = $1', [order.id]);
        await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
        await pool.end();
    });

    for (const status of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) {
        assert.equal(await db.updateOrderStatus(order.id, status), true);
    }
    assert.equal((await db.acceptRouteStop(route.id, stopId)).status, 'accepted');
    assert.equal((await db.startRouteIfAllAccepted(route.id)).status, 'started');

    const waitForRouteLockWaiters = async (expected) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const r = await pool.query(
                `SELECT COUNT(*)::int AS n
                   FROM pg_stat_activity
                  WHERE wait_event_type = 'Lock'
                    AND query LIKE '%SELECT id FROM delivery_routes WHERE id = $1 FOR UPDATE%'`
            );
            if (r.rows[0].n >= expected) return;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error('Не дождались ' + expected + ' ожидающих блокировку маршрута');
    };

    const blocker = await pool.connect();
    let blockerOpen = false;
    let stageTask;
    let completeTask;
    try {
        await blocker.query('BEGIN');
        blockerOpen = true;
        await blocker.query('SELECT id FROM delivery_routes WHERE id = $1 FOR UPDATE', [route.id]);

        // Первый callback становится в очередь на блокировку маршрута.
        stageTask = db.setStopStage(stopId, 'enroute').then(
            value => ({ ok: true, value }),
            error => ({ ok: false, error })
        );
        await waitForRouteLockWaiters(1);

        // Второй callback приходит параллельно. При неправильном порядке он успевает
        // заблокировать stop, а затем ждёт route — получается цикл с первым callback.
        completeTask = db.completeDeliveryStop(stopId).then(
            value => ({ ok: true, value }),
            error => ({ ok: false, error })
        );
        await waitForRouteLockWaiters(2);

        await blocker.query('COMMIT');
        blockerOpen = false;
    } finally {
        if (blockerOpen) await blocker.query('ROLLBACK').catch(() => {});
        blocker.release();
    }

    const [stage, complete] = await Promise.all([stageTask, completeTask]);
    assert.equal(stage.ok, true, stage.error && stage.error.message);
    assert.equal(complete.ok, true, complete.error && complete.error.message);
    assert.ok(stage.value, 'этап «В пути» должен сохраниться');
    assert.equal(complete.value.status, 'completed', 'доставка должна завершиться без deadlock');

    const stored = (await pool.query(
        `SELECT rs.status AS stop_status, rs.stage, o.status AS order_status
           FROM route_stops rs JOIN orders o ON o.id::text = rs.order_id
          WHERE rs.id = $1`, [stopId]
    )).rows[0];
    assert.equal(stored.stop_status, 'delivered');
    assert.equal(stored.stage, 'enroute');
    assert.equal(stored.order_status, 'COMPLETED');
});
