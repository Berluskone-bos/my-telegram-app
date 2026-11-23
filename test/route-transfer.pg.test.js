'use strict';
// PostgreSQL integration: аварийная передача активного маршрута без возврата заказов на склад.
const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('аварийная передача: история первого курьера сохраняется, незавершённые заказы переходят второму ровно один раз', { skip }, async (t) => {
    Object.assign(process.env, {
        DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x',
        WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y',
        ADMIN_CHAT_ID: '1', OUTBOX_DISABLED: '1'
    });
    const { pool, initDB } = require('../bot/db');
    const db = require('../bot/db-adapter');
    const { createRouteService } = require('../bot/route-service');
    await initDB();

    const tag = String(Date.now());
    const prefix = 'AP-xfer' + tag.slice(-7);
    const courierA = await db.createCourier({ name: 'Курьер передачи А', phone: '1', telegram_id: 990001, telegram_user: 'xfera', vehicle_type: 'авто' });
    const courierB = await db.createCourier({ name: 'Курьер передачи Б', phone: '2', telegram_id: 990002, telegram_user: 'xferb', vehicle_type: 'авто' });
    const courierC = await db.createCourier({ name: 'Курьер передачи В', phone: '3', telegram_id: 990003, telegram_user: 'xferc', vehicle_type: 'авто' });
    const createdOrders = [];
    let routeIds = [];
    t.after(async () => {
        if (routeIds.length) {
            await pool.query('DELETE FROM route_transfer_events WHERE source_route_id = ANY($1::int[]) OR target_route_id = ANY($1::int[])', [routeIds]);
            await pool.query('UPDATE route_stops SET transferred_to_stop_id = NULL WHERE route_id = ANY($1::int[])', [routeIds]);
            await pool.query('UPDATE delivery_routes SET transferred_to_route_id = NULL WHERE id = ANY($1::int[])', [routeIds]);
            await pool.query('DELETE FROM route_stops WHERE route_id = ANY($1::int[])', [routeIds]);
            await pool.query('DELETE FROM delivery_routes WHERE id = ANY($1::int[])', [routeIds]);
        }
        if (createdOrders.length) await pool.query('DELETE FROM orders WHERE id = ANY($1::int[])', [createdOrders]);
        await pool.query('DELETE FROM couriers WHERE id = ANY($1::int[])', [[courierA.id, courierB.id, courierC.id]]);
        await pool.end();
    });

    const makeOrder = async (suffix) => {
        const order = await db.createOrder({
            order_number: prefix + suffix, user_id: 990100 + Number(suffix), user_name: 'Клиент ' + suffix,
            phone: '+70000000000', address: 'Тестовый адрес ' + suffix, zone: 'spb',
            city: 'Санкт-Петербург', street: 'Тестовая', house: String(suffix),
            items: [], subtotal: 100, total: 100, payment: 'cash',
            idempotency_key: 'xfer-' + tag + '-' + suffix
        });
        createdOrders.push(order.id);
        await db.updateOrderStatus(order.id, 'CONFIRMED');
        await db.updateOrderStatus(order.id, 'ASSEMBLING');
        await db.updateOrderStatus(order.id, 'READY_FOR_SHIPMENT');
        return order;
    };
    const orders = [await makeOrder('1'), await makeOrder('2'), await makeOrder('3')];
    const queueMessages = [];
    const queue = { notify: async (bot, chat, text, options = {}) => {
        queueMessages.push({ bot, chat: String(chat), text, options });
        return true;
    } };
    const planner = { planRoute: async ({ stops }) => ({ ordered: [...stops].reverse(), unplaced: [], source: 'estimate', totalMin: 0 }) };
    const svc = createRouteService({ db, queue, planner, env: { SERVICE_MINUTES: '5' }, now: () => new Date('2026-11-23T10:00:00Z') });

    const initial = await svc.buildRoute({ orderIds: orders.map(o => o.id), courier: courierA });
    routeIds.push(initial.route.id);
    const originalStops = (await db.getRouteById(initial.route.id)).stops;
    for (const stop of originalStops) {
        assert.equal((await db.acceptRouteStop(initial.route.id, stop.id, { expectedCourierId: courierA.id })).status, 'accepted');
    }
    assert.equal((await db.startRouteIfAllAccepted(initial.route.id, { expectedCourierId: courierA.id })).status, 'started');
    const delivered = originalStops[0];
    assert.equal((await db.completeDeliveryStop(delivered.id, { expectedCourierId: courierA.id, expectedRouteId: initial.route.id })).status, 'completed');

    const transferArgs = {
        sourceRouteId: initial.route.id, sourceCourierId: courierA.id, targetCourier: courierB,
        reason: 'breakdown', notifyAdmin: async () => true
    };
    const results = await Promise.allSettled([
        svc.transferRemainingRoute(transferArgs),
        svc.transferRemainingRoute(transferArgs)
    ]);
    const successes = results.filter(x => x.status === 'fulfilled');
    const failures = results.filter(x => x.status === 'rejected');
    assert.equal(successes.length, 1, 'параллельная повторная передача должна пройти ровно один раз');
    assert.equal(failures.length, 1, 'повторная передача должна быть отклонена');

    const transferred = successes[0].value;
    routeIds.push(transferred.route.id);
    const oldRoute = await db.getRouteById(initial.route.id);
    const newRoute = await db.getRouteById(transferred.route.id);
    assert.equal(oldRoute.status, 'transferred');
    assert.equal(Number(oldRoute.transferred_to_route_id), Number(newRoute.id));
    assert.equal(oldRoute.stops.find(s => Number(s.id) === Number(delivered.id)).status, 'delivered',
        'уже доставленная остановка остаётся в истории первого курьера');
    const oldRemaining = oldRoute.stops.filter(s => s.status === 'transferred');
    assert.equal(oldRemaining.length, 2);
    assert.ok(oldRemaining.every(s => s.transferred_to_stop_id), 'сохраняется связь старых и новых остановок');
    assert.equal(newRoute.status, 'assigned');
    assert.equal(Number(newRoute.courier_id), Number(courierB.id));
    assert.equal(newRoute.stops.length, 2);
    assert.deepEqual(newRoute.stops.map(s => s.order_number), transferred.sequence,
        'порядок в новом маршрутном листе совпадает с результатом оптимизации');
    assert.ok(newRoute.stops.every(s => s.status === 'pending'));
    assert.equal(queueMessages.filter(m => m.bot === 'courier' && m.chat === String(courierB.telegram_id)).length, 3,
        'второму курьеру поставлены маршрутный лист и две карточки заказов');
    const statuses = await pool.query('SELECT status FROM orders WHERE id = ANY($1::int[]) ORDER BY id', [orders.map(o => o.id)]);
    assert.equal(statuses.rows.filter(x => x.status === 'COMPLETED').length, 1);
    assert.equal(statuses.rows.filter(x => x.status === 'SHIPPING').length, 2,
        'переданные заказы не возвращаются в READY_FOR_SHIPMENT');

    // Если второй курьер тоже не может продолжить, те же заказы можно передать третьему.
    const secondTransfer = await svc.transferRemainingRoute({
        sourceRouteId: newRoute.id, sourceCourierId: courierB.id, targetCourier: courierC, reason: 'fuel'
    });
    routeIds.push(secondTransfer.route.id);
    const middleRoute = await db.getRouteById(newRoute.id);
    const finalRoute = await db.getRouteById(secondTransfer.route.id);
    assert.equal(middleRoute.status, 'transferred');
    assert.equal(Number(finalRoute.transferred_from_route_id), Number(middleRoute.id));
    assert.equal(Number(finalRoute.courier_id), Number(courierC.id));
    assert.equal(finalRoute.stops.length, 2);
    assert.ok(finalRoute.stops.every(s => s.status === 'pending'));
    assert.equal(queueMessages.filter(m => m.bot === 'courier' && m.chat === String(courierC.telegram_id)).length, 3,
        'третьему курьеру также отправлены маршрутный лист и карточки заказов');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM route_transfer_events')).rows[0].n >= 2, true,
        'каждая передача записана в журнал');

    for (const stop of finalRoute.stops) {
        assert.equal((await db.acceptRouteStop(finalRoute.id, stop.id, { expectedCourierId: courierC.id })).status, 'accepted');
    }
    assert.equal((await db.startRouteIfAllAccepted(finalRoute.id, { expectedCourierId: courierC.id })).status, 'started',
        'новый курьер может принять и начать повторно переданный маршрут');
    assert.equal(await db.setStopStage(oldRemaining[0].id, 'enroute', {
        expectedCourierId: courierA.id, expectedRouteId: initial.route.id
    }), null, 'первый курьер не может продолжить работу с переданной остановкой');
    const middleTransferred = middleRoute.stops.find(s => s.status === 'transferred');
    assert.ok(middleTransferred);
    assert.equal(await db.setStopStage(middleTransferred.id, 'enroute', {
        expectedCourierId: courierB.id, expectedRouteId: middleRoute.id
    }), null, 'второй курьер также теряет доступ после повторной передачи');
});
