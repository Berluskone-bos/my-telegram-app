'use strict';
// Нужна база: TEST_DATABASE_URL. Маршрут из нескольких заказов: порядок, рассылка курьеру, время приезда клиентам.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('маршрут из 4 заказов: порядок по времени в пути, лист курьеру, сообщения клиентам 2–4 и обновление при сдвиге', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', OUTBOX_DISABLED: '1' });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    const realPlanner = require('../bot/services/route-planner');
    const { createRouteService } = require('../bot/route-service');
    await initDB();
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes');
    await pool.query("DELETE FROM orders WHERE order_number LIKE 'AP-rs%'");

    // Склад(0) и четыре адреса. Время в пути (сек): выгодный порядок D, B, A, C.
    const coords = { 'адрес A': [59.90, 30.30], 'адрес B': [59.91, 30.31], 'адрес C': [59.92, 30.32], 'адрес D': [59.93, 30.33] };
    const geocoder = { geocode: async (addr) => ({ lat: coords[addr][0], lon: coords[addr][1] }) };
    let fetchCalls = 0;
    // «Дорога»: вдоль неё точки стоят в порядке склад, D, B, A, C; время в пути = 600 с на каждый участок между соседними
    const along = { '59.94': 0, '59.93': 1, '59.91': 2, '59.9': 3, '59.92': 4 };
    const planner = { ...realPlanner, planRoute: (o) => realPlanner.planRoute({ ...o, fetchImpl: async (url) => {
        fetchCalls++;
        const lats = url.split('/driving/')[1].split('?')[0].split(';').map(p => String(Number(p.split(',')[1])));
        const durations = lats.map(a => lats.map(b => Math.abs(along[a] - along[b]) * 600));
        return { ok: true, json: async () => ({ code: 'Ok', durations }) };
    } }) };
    const sent = [];
    const queue = { notify: (bot, chat, text, opts = {}) => { sent.push({ bot, chat: String(chat), text, opts }); return Promise.resolve(1); } };
    const clock = { t: new Date('2026-11-15T00:00:00Z') };     // воскресенье 03:00 МСК: коэффициент 1.0
    const svc = createRouteService({ db, geocoder, queue, planner, env: { WAREHOUSE_LAT: '59.94', WAREHOUSE_LON: '30.34', SERVICE_MINUTES: '5' }, now: () => clock.t });

    const courier = await db.createCourier({ name: 'Курьер-маршрут', phone: '1', telegram_id: 900010, telegram_user: 'r', vehicle_type: 'авто' });
    t.after(async () => {
        await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes');
        await pool.query("DELETE FROM orders WHERE order_number LIKE 'AP-rs%'");
        await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
        await pool.end();
    });
    const mk = (key, addr, extra = {}) => db.createOrder({ order_number: 'AP-rs' + key, user_id: 880100 + Number(key), user_name: 'К' + key, phone: '1', address: addr,
        zone: 'spb', city: 'c', street: 's', house: '1', items: [], subtotal: 1, total: 100, idempotency_key: 'rs' + key, ...extra });
    const oA = await mk('1', 'адрес A'), oB = await mk('2', 'адрес B'), oC = await mk('3', 'адрес C'), oD = await mk('4', 'адрес D');
    for (const o of [oA, oB, oC, oD]) {
        await db.updateOrderStatus(o.id, 'CONFIRMED');
        await db.updateOrderStatus(o.id, 'ASSEMBLING');
        await db.updateOrderStatus(o.id, 'READY_FOR_SHIPMENT');
    }

    // проверки отказов
    await assert.rejects(svc.buildRoute({ orderIds: [], courier }), (e) => e.code === 'BAD_REQUEST');
    const pickup = await mk('5', 'адрес A', { delivery_type: 'pickup' });
    await assert.rejects(svc.buildRoute({ orderIds: [pickup.id], courier }), (e) => e.code === 'CONFLICT' && /самовывоз/.test(e.message));
    const cancelled = await mk('6', 'адрес A'); await db.updateOrderStatus(cancelled.id, 'CANCELLED');
    await assert.rejects(svc.buildRoute({ orderIds: [cancelled.id], courier }), (e) => e.code === 'CONFLICT');

    // сборка маршрута
    const out = await svc.buildRoute({ orderIds: [oA.id, oB.id, oC.id, oD.id], courier, notifyAdmin: (x) => sent.push({ bot: 'admin', text: x }) });
    assert.deepEqual(out.sequence, ['AP-rs4', 'AP-rs2', 'AP-rs1', 'AP-rs3'], 'порядок по времени в пути, а не по порядку заказов');
    const stops = (await db.getRouteById(out.route.id)).stops;
    assert.deepEqual(stops.map(s => [s.stop_number, s.order_number]), [[1, 'AP-rs4'], [2, 'AP-rs2'], [3, 'AP-rs1'], [4, 'AP-rs3']]);
    assert.ok(stops.every(s => s.eta_at), 'время приезда сохранено');
    // склад→D = 600 с (10 мин) после выезда в 03:00 UTC... время прибытия: 00:10, 00:25 (+5 мин остановка), 00:40, 00:55
    assert.deepEqual(stops.map(s => new Date(s.eta_at).toISOString().slice(11, 16)), ['00:10', '00:25', '00:40', '00:55']);
    for (const o of [oA, oB, oC, oD]) assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [o.id])).rows[0].status, 'READY_FOR_SHIPMENT');
    // повторно те же заказы нельзя
    await assert.rejects(svc.buildRoute({ orderIds: [oA.id], courier }), (e) => e.code === 'CONFLICT' && /уже назначен/.test(e.message));

    // курьеру: один маршрутный лист + 4 карточки с кнопкой «Принять»
    const toCourier = sent.filter(m => m.bot === 'courier');
    assert.equal(toCourier.length, 5);
    assert.match(toCourier[0].text, /Маршрут RL-\d+<\/b>: 4 точек/); assert.match(toCourier[0].text, /1\. AP-rs4 — адрес D — к 03:10/);
    assert.match(toCourier[0].text, /живые пробки не учитываются/);
    assert.match(toCourier[1].text, /Точка 1 из 4/);
    assert.equal(toCourier[1].opts.buttons.at(-1)[0].callback_data, `deliver_${out.route.id}_${stops[0].id}_accept`);
    assert.ok(sent.some(m => m.bot === 'admin' && /назначен/.test(m.text)));
    assert.equal(sent.filter(m => m.bot === 'client').length, 0, 'при назначении маршрута клиент не получает сообщение о выезде');
    sent.length = 0;

    // Старт всего маршрута блокируется, пока не приняты все заказы.
    assert.deepEqual(await db.startRouteIfAllAccepted(out.route.id), { status: 'not_ready', waiting: 4 });
    assert.equal((await db.acceptRouteStop(out.route.id, stops[0].id)).status, 'accepted');
    assert.equal((await db.acceptRouteStop(out.route.id, stops[0].id)).status, 'already', 'повторное принятие идемпотентно');
    assert.deepEqual(await db.startRouteIfAllAccepted(out.route.id), { status: 'not_ready', waiting: 3 });
    for (const stop of stops.slice(1)) assert.equal((await db.acceptRouteStop(out.route.id, stop.id)).status, 'accepted');
    const starts = await Promise.all([db.startRouteIfAllAccepted(out.route.id), db.startRouteIfAllAccepted(out.route.id)]);
    assert.deepEqual(starts.map(x => x.status).sort(), ['already', 'started'], 'конкурентный старт фиксируется один раз');
    assert.equal((await db.getRouteById(out.route.id)).status, 'in_progress');
    for (const o of [oA, oB, oC, oD]) assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [o.id])).rows[0].status, 'SHIPPING');
    assert.ok((await db.getRouteById(out.route.id)).stops.every(s => s.status === 'in_progress'));

    // После общего старта клиентам отправляются ETA-уведомления по всем заказам маршрута.
    clock.t = new Date('2026-11-15T00:02:00Z');
    let r = await svc.refreshEtas({ routeId: out.route.id, firstStopId: stops[0].id, notifyNew: true });
    const clientTexts = () => sent.filter(m => m.bot === 'client');
    assert.equal(clientTexts().length, 4);
    const toUser = (n) => clientTexts().find(m => m.chat === String(880100 + n)).text;
    assert.match(toUser(4), /Курьер в пути/); assert.match(toUser(4), /везёт ваш заказ и будет у вас через ~10 мин \(около 03:12\)/);
    assert.match(toUser(2), /Курьер выехал/); assert.match(toUser(2), /2-й из 4/); assert.match(toUser(2), /через ~25 мин/);
    assert.match(toUser(1), /3-й из 4/); assert.match(toUser(3), /4-й из 4/);
    sent.length = 0;

    // повторное нажатие и пересчёт без сдвига ничего не отправляют
    await svc.refreshEtas({ routeId: out.route.id, firstStopId: stops[0].id, notifyNew: true });
    assert.equal(clientTexts().filter(m => !/Курьер в пути/.test(m.text)).length, 0, 'остальным второй раз не пишем');
    sent.length = 0;

    // доставил первую точку на 6 минут позже плана: сдвиг меньше 15 минут — клиентам не пишем
    await db.updateStopStatus(stops[0].id, 'delivered', '');
    clock.t = new Date('2026-11-15T00:16:00Z');
    await svc.refreshEtas({ routeId: out.route.id, notifyNew: false });
    assert.equal(clientTexts().length, 0, 'небольшой сдвиг без сообщений');

    // вторую точку курьер сдал только в 00:50 — остальным уходит уточнённое время
    await db.updateStopStatus(stops[1].id, 'delivered', '');
    clock.t = new Date('2026-11-15T00:50:00Z');
    await svc.refreshEtas({ routeId: out.route.id, notifyNew: false });
    assert.equal(clientTexts().length, 2, 'сдвиг больше 15 минут — обновление двум оставшимся');
    assert.ok(clientTexts().every(m => /уточнено/.test(m.text)));
    assert.deepEqual(clientTexts().map(m => m.chat).sort(), [String(880101), String(880103)]);
    assert.ok(fetchCalls > 0);
});
