'use strict';
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js). Без неё тест пропускается.
// Повторяет сценарий владельца: заказ → подтверждён → сборка → курьер назначен → заказ отменён в админ-боте.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('отмена заказа: курьер получает сообщение, кнопки гаснут, клиент уведомляется один раз', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    const { createOutbox } = require('../bot/outbox');
    const { checkStopActive } = require('../bot/cancel-flow');
    await initDB();
    await pool.query('DELETE FROM notification_outbox');
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');
    const courier = await db.createCourier({ name: 'Тест-курьер', phone: '1', telegram_id: 900001, telegram_user: 'c', vehicle_type: 'авто' });
    t.after(async () => {
        await pool.query('DELETE FROM notification_outbox');
        await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes');
        await pool.query("DELETE FROM orders WHERE order_number LIKE 'AP-cf%'");
        await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
        await pool.end();
    });

    let nextMsg = 500; const sent = [];
    const q = createOutbox({ pool, send: async (bot, method, payload) => { sent.push({ bot, method, payload }); return { message_id: ++nextMsg }; } });

    const mkOrder = (key) => db.createOrder({ order_number: 'AP-' + key, user_id: 777002, user_name: 'Клиент', name: 't', phone: '1', address: 'СПб, ул. Тестовая, д. 1',
        zone: 'spb', city: 'c', street: 's', house: '1', items: [], subtotal: 100, total: 100, idempotency_key: key });
    const assign = async (order, withMessageSent) => {
        const current = (await pool.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status;
        if (current === 'NEW') assert.equal(await db.updateOrderStatus(order.id, 'CONFIRMED'), true);
        const afterConfirm = (await pool.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status;
        if (afterConfirm === 'CONFIRMED') assert.equal(await db.updateOrderStatus(order.id, 'ASSEMBLING'), true);
        const afterAssembly = (await pool.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status;
        if (afterAssembly === 'ASSEMBLING') assert.equal(await db.updateOrderStatus(order.id, 'READY_FOR_SHIPMENT'), true);
        const route = await db.createRoute({ route_number: 'RL-' + String(order.id), route_date: '2026-11-14', courier_id: courier.id, status: 'assigned', total_orders: 1, enforceReadyOrders: true,
            stops: [{ order_id: String(order.id), order_number: order.order_number, address: order.address, phone: '1', client_name: 'Клиент', client_chat_id: order.user_id,
                amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: '' }] });
        const stopId = route.stops[0].id;
        await q.enqueue({ bot: 'courier', dedupKey: `assign:${stopId}`, onSent: { stopId },
            payload: { chat_id: '900001', text: 'Новый заказ', reply_markup: { inline_keyboard: [[{ text: 'Принять заказ', callback_data: `deliver_${route.id}_${stopId}_accept` }]] } } });
        if (withMessageSent) await q.processOnce();
        return { route, stopId };
    };
    const outbox = async () => (await pool.query('SELECT dedup_key, status FROM notification_outbox ORDER BY id')).rows;

    // ── сценарий владельца ──
    const o1 = await mkOrder('cf1');
    assert.equal(await db.updateOrderStatus(o1.id, 'CONFIRMED'), true);
    assert.equal(await db.updateOrderStatus(o1.id, 'ASSEMBLING'), true);
    const { route, stopId } = await assign(o1, true);
    const stop = (await pool.query('SELECT courier_chat_id, courier_message_id FROM route_stops WHERE id = $1', [stopId])).rows[0];
    assert.equal(Number(stop.courier_message_id), 501, 'id сообщения курьеру запомнен');
    assert.equal((await checkStopActive(pool, stopId)).active, true);
    sent.length = 0;

    assert.equal(await db.updateOrderStatus(o1.id, 'CANCELLED'), true);   // кнопка «Отменить» в админ-боте
    assert.equal((await checkStopActive(pool, stopId)).active, false, 'кнопки курьера теперь заблокированы');
    assert.equal((await checkStopActive(pool, stopId)).reason, 'cancelled');
    assert.equal((await db.getRouteById(route.id)).status, 'completed', 'в маршруте не осталось активных остановок');

    await q.processOnce();
    const edit = sent.find(s => s.method === 'editMessageReplyMarkup');
    assert.ok(edit, 'на прежнем сообщении курьера кнопки заменены');
    assert.equal(edit.payload.message_id, 501); assert.equal(edit.payload.chat_id, '900001');
    assert.deepEqual(edit.payload.reply_markup.inline_keyboard[0][0].disabled, {}, 'серая кнопка (disabled) вместо заглушки');
    const editRow = (await pool.query(`SELECT on_sent FROM notification_outbox WHERE dedup_key = $1`, [`cancel-edit:${stopId}`])).rows[0];
    assert.equal(editRow.on_sent.fallback.payload.reply_markup.inline_keyboard[0][0].callback_data, 'noop_cancelled', 'запасной вариант — прежняя кнопка');
    const toCourier = sent.find(s => s.bot === 'courier' && s.method === 'sendMessage');
    assert.match(toCourier.payload.text, /Заказ отменён/); assert.match(toCourier.payload.text, /AP-cf1/);
    assert.equal(toCourier.payload.chat_id, '900001');
    const toClient = sent.filter(s => s.bot === 'client');
    assert.equal(toClient.length, 1); assert.equal(toClient[0].payload.chat_id, '777002'); assert.match(toClient[0].payload.text, /Отменён/);

    // повторное нажатие «Отменить»: никаких новых сообщений
    sent.length = 0;
    assert.equal(await db.updateOrderStatus(o1.id, 'CANCELLED'), 'ALREADY');
    assert.equal((await q.processOnce()).sent, 0); assert.equal(sent.length, 0);
    assert.equal(await db.updateOrderStatus(o1.id, 'SHIPPING'), 'CANCELLED_LOCKED', 'вернуть отменённый в работу нельзя');

    // ── курьер ещё не получил сообщение (оно в очереди): не отправляем ни заказ, ни отмену ──
    await pool.query('DELETE FROM notification_outbox'); sent.length = 0;
    const o2 = await mkOrder('cf2');
    const second = await assign(o2, false);
    assert.equal(await db.updateOrderStatus(o2.id, 'CANCELLED'), true);
    await q.processOnce();
    assert.equal(sent.filter(s => s.bot === 'courier').length, 0, 'курьеру ничего не уходит');
    assert.equal(sent.filter(s => s.bot === 'client').length, 1, 'клиенту — «Отменён»');
    assert.equal((await outbox()).find(r => r.dedup_key === `assign:${second.stopId}`).status, 'skipped');

    // ── уже принятая курьером остановка также отменяется и гасит кнопки ──
    await pool.query('DELETE FROM notification_outbox'); sent.length = 0;
    const oAccepted = await mkOrder('cf-accepted');
    const accepted = await assign(oAccepted, true);
    assert.equal((await db.acceptRouteStop(accepted.route.id, accepted.stopId)).status, 'accepted');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [accepted.stopId])).rows[0].status, 'accepted');
    assert.equal(await db.updateOrderStatus(oAccepted.id, 'CANCELLED'), true);
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [accepted.stopId])).rows[0].status, 'cancelled',
        'отмена переводит accepted остановку в cancelled');
    assert.equal((await db.getRouteById(accepted.route.id)).status, 'completed', 'маршрут закрывается после отмены принятой единственной остановки');
    await q.processOnce();
    assert.ok(sent.some(s => s.bot === 'courier' && s.method === 'sendMessage' && /Заказ отменён/.test(s.payload.text)),
        'курьер, уже принявший заказ, получает сообщение об отмене');
    assert.ok(sent.some(s => s.method === 'editMessageReplyMarkup'), 'кнопки принятой остановки гасятся');

    // ── гонка: курьерский этап одновременно с отменой заказа ──
    await pool.query('DELETE FROM notification_outbox'); sent.length = 0;
    const oRace = await mkOrder('cf-race');
    const race = await assign(oRace, true);
    assert.equal((await db.acceptRouteStop(race.route.id, race.stopId)).status, 'accepted');
    assert.equal((await db.startRouteIfAllAccepted(race.route.id)).status, 'started');
    const [stageRace, cancelRace] = await Promise.all([
        db.setStopStage(race.stopId, 'enroute', { expectedCourierId: courier.id, expectedRouteId: race.route.id }),
        db.updateOrderStatus(oRace.id, 'CANCELLED')
    ]);
    assert.ok(stageRace === null || stageRace.stage === 'enroute', 'курьерский этап либо отклонён после отмены, либо завершился до неё');
    assert.equal(cancelRace, true);
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [oRace.id])).rows[0].status, 'CANCELLED');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [race.stopId])).rows[0].status, 'cancelled',
        'после гонки отмена остаётся терминальным состоянием остановки');
    assert.equal((await checkStopActive(pool, race.stopId)).active, false);

    // ── гонка принятия остановки с отменой ──
    await pool.query('DELETE FROM notification_outbox'); sent.length = 0;
    const oAcceptRace = await mkOrder('cf-accept-race');
    const acceptRace = await assign(oAcceptRace, true);
    const [acceptResult, acceptCancel] = await Promise.all([
        db.acceptRouteStop(acceptRace.route.id, acceptRace.stopId, { expectedCourierId: courier.id }),
        db.updateOrderStatus(oAcceptRace.id, 'CANCELLED')
    ]);
    assert.equal(acceptCancel, true);
    assert.ok(['accepted', 'route_started'].includes(acceptResult.status),
        'accept either commits before cancellation or is rejected after route closure');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [oAcceptRace.id])).rows[0].status, 'CANCELLED');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [acceptRace.stopId])).rows[0].status, 'cancelled');
    assert.equal((await db.getRouteById(acceptRace.route.id)).status, 'completed');

    // ── гонка старта маршрута с отменой ──
    await pool.query('DELETE FROM notification_outbox'); sent.length = 0;
    const oStartRace = await mkOrder('cf-start-race');
    const startRace = await assign(oStartRace, true);
    assert.equal((await db.acceptRouteStop(startRace.route.id, startRace.stopId, { expectedCourierId: courier.id })).status, 'accepted');
    const [startResult, startCancel] = await Promise.all([
        db.startRouteIfAllAccepted(startRace.route.id, { expectedCourierId: courier.id }),
        db.updateOrderStatus(oStartRace.id, 'CANCELLED')
    ]);
    assert.equal(startCancel, true);
    assert.ok(['started', 'forbidden'].includes(startResult.status),
        'route start either commits before cancellation or sees the closed route');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [oStartRace.id])).rows[0].status, 'CANCELLED');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [startRace.stopId])).rows[0].status, 'cancelled');
    assert.equal((await db.getRouteById(startRace.route.id)).status, 'completed');

    // ── гонка отказа курьера с отменой ──
    await pool.query('DELETE FROM notification_outbox'); sent.length = 0;
    const oFailRace = await mkOrder('cf-fail-race');
    const failRace = await assign(oFailRace, true);
    assert.equal((await db.acceptRouteStop(failRace.route.id, failRace.stopId, { expectedCourierId: courier.id })).status, 'accepted');
    assert.equal((await db.startRouteIfAllAccepted(failRace.route.id, { expectedCourierId: courier.id })).status, 'started');
    const [failResult, failCancel] = await Promise.all([
        db.failDeliveryStop(failRace.stopId, 'Клиента нет дома', { expectedCourierId: courier.id, expectedRouteId: failRace.route.id }),
        db.updateOrderStatus(oFailRace.id, 'CANCELLED')
    ]);
    assert.equal(failCancel, true);
    assert.ok(['failed', 'cancelled'].includes(failResult.status),
        'failure either commits before cancellation or is rejected after cancellation');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [oFailRace.id])).rows[0].status, 'CANCELLED');
    assert.ok(['failed', 'cancelled'].includes((await pool.query('SELECT status FROM route_stops WHERE id = $1', [failRace.stopId])).rows[0].status));
    assert.equal((await db.getRouteById(failRace.route.id)).status, 'completed');

    // ── гонка завершения доставки с отменой: победитель должен оставить согласованное терминальное состояние ──
    await pool.query('DELETE FROM notification_outbox'); sent.length = 0;
    const oCompleteRace = await mkOrder('cf-complete-race');
    const completeRace = await assign(oCompleteRace, true);
    assert.equal((await db.acceptRouteStop(completeRace.route.id, completeRace.stopId)).status, 'accepted');
    assert.equal((await db.startRouteIfAllAccepted(completeRace.route.id)).status, 'started');
    const [completionRace, cancellationRace] = await Promise.all([
        db.completeDeliveryStop(completeRace.stopId, { expectedCourierId: courier.id, expectedRouteId: completeRace.route.id }),
        db.updateOrderStatus(oCompleteRace.id, 'CANCELLED')
    ]);
    const completionState = (await pool.query(
        'SELECT o.status AS order_status, rs.status AS stop_status FROM orders o JOIN route_stops rs ON rs.order_id = o.id::text WHERE o.id = $1',
        [oCompleteRace.id]
    )).rows[0];
    assert.equal(cancellationRace, true);
    if (completionRace.status === 'cancelled') {
        assert.equal(completionState.order_status, 'CANCELLED');
        assert.equal(completionState.stop_status, 'cancelled');
    } else {
        assert.equal(completionRace.status, 'completed');
        // Admin cancellation after completion is an existing business rule used to reverse referral bonuses.
        // Delivery history remains delivered; the order itself is marked cancelled.
        assert.equal(completionState.order_status, 'CANCELLED');
        assert.equal(completionState.stop_status, 'delivered');
    }

    // ── заказ без курьера: только клиент ──
    await pool.query('DELETE FROM notification_outbox'); sent.length = 0;
    const o3 = await mkOrder('cf3');
    assert.equal(await db.updateOrderStatus(o3.id, 'CANCELLED'), true);
    await q.processOnce();
    assert.deepEqual(sent.map(s => s.bot), ['client']);

    // ── доставленный заказ отменять нельзя без возврата, курьеру сообщений об отмене нет ──
    const o4 = await mkOrder('cf4');
    const third = await assign(o4, true);
    await pool.query("UPDATE route_stops SET status = 'delivered' WHERE id = $1", [third.stopId]);
    assert.equal((await checkStopActive(pool, third.stopId)).active, true, 'доставленная остановка не помечается отменённой сама по себе');
});
