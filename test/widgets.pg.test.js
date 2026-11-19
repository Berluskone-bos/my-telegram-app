'use strict';
// Карточки-виджеты вместе с базой и очередью: отправка, правка, запасной вариант, оценка, отмена, маршрутный лист, сводка.
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('виджеты: очередь, запасной вариант, трекер, оценка, отмена, маршрутный лист, сводка', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
    delete process.env.WIDGETS_ENABLED;
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    const { createOutbox } = require('../bot/outbox');
    const store = require('../bot/widget-store');
    const tracker = require('../bot/tracker');
    const widgets = require('../bot/widgets');
    const { queueRouteSheetEdit } = require('../bot/route-sheet');
    const { createSummaryService } = require('../bot/summary');
    await initDB();
    const wipe = async () => {
        await pool.query('DELETE FROM notification_outbox'); await pool.query('DELETE FROM widget_messages');
        await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query("DELETE FROM orders WHERE order_number LIKE 'AP-wg%'");
    };
    await wipe();
    const courier = await db.createCourier({ name: 'Виджет-курьер', phone: '1', telegram_id: 900101, telegram_user: 'w', vehicle_type: 'авто' });
    t.after(async () => { await wipe(); await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]); await pool.end(); });

    let nextMsg = 700; const sent = []; let rejectWidgets = false, rejectDisabled = false;
    const q = createOutbox({ pool, send: async (bot, method, payload) => {
        if (method === 'sendWidget' && rejectWidgets) throw Object.assign(new Error('Bad Request: method not found'), { tgCode: 400 });
        if (method === 'editMessageReplyMarkup' && rejectDisabled && JSON.stringify(payload).includes('disabled')) throw Object.assign(new Error('Bad Request: field disabled unsupported'), { tgCode: 400 });
        sent.push({ bot, method, payload }); return { message_id: ++nextMsg };
    } });
    const mkOrder = (key, user = 777101) => db.createOrder({ order_number: 'AP-' + key, user_id: user, user_name: 'Клиент', name: 't', phone: '1', address: 'СПб, ул. Тестовая, д. 1',
        zone: 'spb', city: 'c', street: 's', house: '1', items: [], subtotal: 100, total: 100, idempotency_key: key });
    const mkCard = async (orderNumber, user = 777101) => {
        await q.enqueue(tracker.trackerItem({ chatId: user, orderNumber }));
        await q.processOnce();
    };

    // ── 1. карточка уходит, номер сообщения запоминается; правка идёт молча на то же сообщение ──
    await mkOrder('wg1');
    await mkCard('AP-wg1');
    const first = sent.find(s => s.method === 'sendWidget');
    assert.ok(first && first.payload.html && first.payload.allow_queries === true && first.payload.caption);
    const w1 = await store.get(pool, 'tracker', 'AP-wg1');
    assert.equal(Number(w1.message_id), 701); assert.equal(w1.active, true);
    sent.length = 0;
    assert.equal(await tracker.trackerEvent(pool, 'AP-wg1', { stage: 'shipping', courier: 'Иван' }), true);
    await q.processOnce();
    const edit = sent.find(s => s.method === 'editMessageWidgetData');
    assert.equal(edit.payload.message_id, 701); assert.equal(edit.payload.chat_id, '777101');
    assert.deepEqual(JSON.parse(edit.payload.chat_data), { n: 'AP-wg1', s: 2, st: 'Курьер назначен', c: 'Иван' });
    assert.equal(sent.filter(s => s.method === 'sendMessage').length, 0, 'обычных сообщений нет');

    // ── 2. заказ без карточки: trackerEvent = false → вызывающий код пошлёт обычный текст ──
    assert.equal(await tracker.trackerEvent(pool, 'AP-нет-такого', { stage: 'enroute' }), false);

    // ── 3. выключатель WIDGETS_ENABLED=0: карточки не создаются и не меняются ──
    process.env.WIDGETS_ENABLED = '0';
    assert.equal(tracker.trackerItem({ chatId: 1, orderNumber: 'AP-x' }), null);
    assert.equal(await tracker.trackerEvent(pool, 'AP-wg1', { stage: 'enroute' }), false);
    delete process.env.WIDGETS_ENABLED;

    // ── 4. Telegram не принял карточку: заказ не страдает, карточка выключена, дальше работают обычные сообщения ──
    await mkOrder('wg2');
    rejectWidgets = true; sent.length = 0;
    await mkCard('AP-wg2');
    const w2 = await store.get(pool, 'tracker', 'AP-wg2');
    assert.equal(w2.active, false, 'после отказа Telegram карточка выключена');
    assert.equal(await tracker.trackerEvent(pool, 'AP-wg2', { stage: 'enroute' }), false, 'значит, клиенту уйдёт обычный текст');
    // а для маршрутного листа/сводки запасной вариант — обычный текст
    const { notifyWidget } = require('../bot/notify-queue');
    assert.equal(typeof notifyWidget, 'function');
    await q.enqueue({ bot: 'courier', method: 'sendWidget', payload: { chat_id: '900101', html: 'x', chat_data: '{}', caption: 'c', allow_queries: true },
        widget: { kind: 'route', ref: 'fb', state: {} }, fallback: { method: 'sendMessage', payload: { chat_id: '900101', text: 'Маршрутный лист текстом', parse_mode: 'HTML' } } });
    sent.length = 0; await q.processOnce();
    assert.equal(sent.length, 1); assert.equal(sent[0].method, 'sendMessage'); assert.equal(sent[0].payload.text, 'Маршрутный лист текстом');
    assert.equal((await store.get(pool, 'route', 'fb')).active, false);
    rejectWidgets = false;

    // ── 4б. Telegram: «карточки обычным ботам не разрешены» → автопауза, дальше карточки не пробуем, текст уходит ──
    await mkOrder('wg2b');
    const blockedQ = createOutbox({ pool, send: async (bot, method) => { if (method === 'sendWidget') throw Object.assign(new Error('Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED'), { tgCode: 400 }); return { message_id: 1 }; } });
    await blockedQ.enqueue(tracker.trackerItem({ chatId: 777101, orderNumber: 'AP-wg2b' }));
    await blockedQ.processOnce();
    assert.equal(widgets.widgetsEnabled(), false, 'после такого ответа карточки на паузе');
    assert.equal(tracker.trackerItem({ chatId: 1, orderNumber: 'AP-y' }), null, 'новые карточки не ставятся');
    assert.equal((await store.get(pool, 'tracker', 'AP-wg2b')).active, false);
    widgets.resumeWidgets();

    // ── 5. оценка звёздами: только доставленный заказ, только владелец, один раз ──
    const calls = [];
    const call = async (method, payload) => { calls.push({ method, payload }); return true; };
    const o3 = await mkOrder('wg3');
    const route = await db.createRoute({ route_number: 'RL-wg3', route_date: '2026-11-15', courier_id: courier.id, status: 'assigned', total_orders: 1,
        stops: [{ order_id: String(o3.id), order_number: o3.order_number, address: o3.address, phone: '1', client_name: 'К', client_chat_id: o3.user_id, amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: '' }] });
    const stopId = route.stops[0].id;
    await mkCard('AP-wg3'); const w3 = await store.get(pool, 'tracker', 'AP-wg3');
    const query = (data, from = 777101) => ({ id: 'q' + Math.random(), data, from: { id: from }, chat: { id: 777101 }, message_id: Number(w3.message_id) });
    assert.equal(await tracker.handleWidgetQuery(query('rate:5'), { pool, db, call }), 'not_delivered', 'пока не доставлен — оценить нельзя');
    assert.equal(await db.updateOrderStatus(o3.id, 'SHIPPING'), true);
    await db.updateStopStatus(stopId, 'delivered', '');
    assert.equal(await db.updateOrderStatus(o3.id, 'DELIVERED'), true);
    assert.equal(await tracker.handleWidgetQuery(query('rate:5', 999), { pool, db, call }), 'bad_chat', 'чужой пользователь');
    assert.equal(await tracker.handleWidgetQuery(query('rate:9'), { pool, db, call }), 'ignored', 'оценка вне 1–5');
    assert.equal(await tracker.handleWidgetQuery(query('drop table'), { pool, db, call }), 'ignored');
    const before = Number((await pool.query('SELECT rating_count FROM couriers WHERE id = $1', [courier.id])).rows[0].rating_count);
    calls.length = 0;
    assert.equal(await tracker.handleWidgetQuery(query('rate:4'), { pool, db, call }), 'rated');
    assert.equal(calls[0].method, 'answerWidgetQuery'); assert.equal(calls[1].method, 'editMessageWidgetData');
    assert.equal(JSON.parse(calls[1].payload.chat_data).r, 4, 'оценка видна в карточке');
    assert.equal(await tracker.handleWidgetQuery(query('rate:1'), { pool, db, call }), 'already_rated', 'второй раз нельзя');
    const after = (await pool.query('SELECT rating, rating_count FROM couriers WHERE id = $1', [courier.id])).rows[0];
    assert.equal(Number(after.rating_count), before + 1, 'в рейтинг курьера попала ровно одна оценка');

    // ── 5б. миграция старых оценок tracker-widget: не разрешать повторную оценку после релиза ──
    const legacyOrder = await mkOrder('wg3legacy');
    const legacyRoute = await db.createRoute({ route_number: 'RL-wg3legacy', route_date: '2026-11-15', courier_id: courier.id, status: 'assigned', total_orders: 1,
        stops: [{ order_id: String(legacyOrder.id), order_number: legacyOrder.order_number, address: legacyOrder.address, phone: '1', client_name: 'К', client_chat_id: legacyOrder.user_id, amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: '' }] });
    await db.updateOrderStatus(legacyOrder.id, 'SHIPPING');
    await db.updateStopStatus(legacyRoute.stops[0].id, 'delivered', '');
    assert.equal(await db.updateOrderStatus(legacyOrder.id, 'DELIVERED'), true);
    await mkCard(legacyOrder.order_number);
    await pool.query(
        `UPDATE widget_messages SET state = state || '{"rating":3}'::jsonb WHERE kind = 'tracker' AND ref = $1`,
        [legacyOrder.order_number]
    );
    await initDB(); // повторный запуск безопасен и выполняет backfill
    assert.equal(Number((await pool.query('SELECT client_rating FROM route_stops WHERE id = $1', [legacyRoute.stops[0].id])).rows[0].client_rating), 3);
    assert.equal((await store.get(pool, 'tracker', legacyOrder.order_number)).state.canRate, false);
    const legacyWidget = await store.get(pool, 'tracker', legacyOrder.order_number);
    const legacyQuery = { id: 'q-legacy', data: 'rate:5', from: { id: legacyOrder.user_id }, chat: { id: legacyOrder.user_id }, message_id: Number(legacyWidget.message_id) };
    const beforeLegacyRetry = Number((await pool.query('SELECT rating_count FROM couriers WHERE id = $1', [courier.id])).rows[0].rating_count);
    assert.equal(await tracker.handleWidgetQuery(legacyQuery, { pool, db, call }), 'already_rated');
    assert.equal(Number((await pool.query('SELECT rating_count FROM couriers WHERE id = $1', [courier.id])).rows[0].rating_count), beforeLegacyRetry);

    // ── 6. отмена заказа: карточка «Отменён» и серая кнопка у курьера (с запасным вариантом) ──
    const o4 = await mkOrder('wg4');
    await mkCard('AP-wg4');
    const route4 = await db.createRoute({ route_number: 'RL-wg4', route_date: '2026-11-15', courier_id: courier.id, status: 'assigned', total_orders: 1,
        stops: [{ order_id: String(o4.id), order_number: o4.order_number, address: o4.address, phone: '1', client_name: 'К', client_chat_id: o4.user_id, amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: '' }] });
    const st4 = route4.stops[0].id;
    assert.equal(await db.updateOrderStatus(o4.id, 'SHIPPING'), true);
    await q.enqueue({ bot: 'courier', dedupKey: `assign:${st4}`, onSent: { stopId: st4 }, payload: { chat_id: '900101', text: 'Новый заказ' } });
    // маршрутная карточка уже есть
    await store.upsert(pool, 'route', route4.id, {}); await store.setMessage(pool, 'route', route4.id, '900101', 650);
    await q.processOnce(); sent.length = 0;
    assert.equal(await db.updateOrderStatus(o4.id, 'CANCELLED'), true);
    rejectDisabled = true;
    await q.processOnce();
    const trackerEdit = sent.find(s => s.method === 'editMessageWidgetData' && s.payload.chat_id === '777101');
    assert.equal(JSON.parse(trackerEdit.payload.chat_data).x, 1, 'карточка клиента показывает «Отменён»');
    const sheetEdit = sent.find(s => s.method === 'editMessageWidgetData' && s.payload.chat_id === '900101');
    assert.equal(JSON.parse(sheetEdit.payload.chat_data).k[0][3], 4, 'в маршрутном листе точка «отменён»');
    const btn = sent.find(s => s.method === 'editMessageReplyMarkup');
    assert.equal(btn.payload.reply_markup.inline_keyboard[0][0].callback_data, 'noop_cancelled', 'Telegram не принял серую кнопку — поставлена прежняя');
    assert.ok(sent.some(s => s.method === 'sendMessage' && /Отменён/.test(s.payload.text)), 'текст об отмене клиенту остаётся (это уведомление)');

    // ── 7. маршрутный лист: правка по данным из базы, «выехал» показывается у выбранной точки ──
    const o5 = await mkOrder('wg5'), o6 = await mkOrder('wg6');
    const route5 = await db.createRoute({ route_number: 'RL-wg5', route_date: '2026-11-15', courier_id: courier.id, status: 'assigned', total_orders: 2,
        stops: [o5, o6].map((o, i) => ({ order_id: String(o.id), order_number: o.order_number, stop_number: i + 1, address: 'Адрес ' + (i + 1), phone: '1', client_name: 'К', client_chat_id: o.user_id, amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: '', eta_at: new Date(Date.now() + 600e3) })) });
    await store.upsert(pool, 'route', route5.id, {}); await store.setMessage(pool, 'route', route5.id, '900101', 660);
    assert.equal(await queueRouteSheetEdit(pool, route5.id, { activeStopId: route5.stops[0].id }), true);
    await db.updateStopStatus(route5.stops[1].id, 'delivered', '');
    assert.equal(await queueRouteSheetEdit(pool, route5.id), true);
    sent.length = 0; await q.processOnce();
    const datas = sent.filter(s => s.method === 'editMessageWidgetData').map(s => JSON.parse(s.payload.chat_data));
    assert.equal(datas[0].k[0][3], 1, 'первая точка — «едем»'); assert.equal(datas[0].d, 0);
    assert.equal(datas[1].k[1][3], 2, 'вторая — доставлена'); assert.equal(datas[1].d, 1);
    assert.equal(await queueRouteSheetEdit(pool, 999999), false, 'нет карточки — ничего не ставим');

    // ── 8. сводка дня: правка только когда цифры изменились ──
    const summaryQueue = { notifyWidget: (bot, chatId, card, opts) => q.enqueue({ bot, method: 'sendWidget', payload: { chat_id: String(chatId), html: card.html, chat_data: card.chat_data, caption: card.caption, allow_queries: true }, widget: { kind: opts.kind, ref: opts.ref, state: opts.state } }).then(() => true), notify: async () => {} };
    const sum = createSummaryService({ db, pool, queue: summaryQueue, chatId: 4242 });
    assert.equal(await sum.refresh(), false, 'карточки ещё нет');
    assert.equal(await sum.send(), true); await q.processOnce();
    assert.equal(await sum.refresh(), false, 'цифры не менялись');
    await mkOrder('wg7');
    assert.equal(await sum.refresh(), true, 'появился заказ — карточка обновлена');
    sent.length = 0; await q.processOnce();
    const sd = JSON.parse(sent.find(s => s.method === 'editMessageWidgetData').payload.chat_data);
    assert.ok(sd.o >= 1 && /^\d\d\.\d\d\.\d{4}$/.test(sd.a));
    assert.ok(widgets.checkWidget(widgets.summaryWidget({ date: sd.a, orders: sd.o })));

    // ── 9. настоящий notifyWidget: карточка в очередь с запасным вариантом; при выключателе — сразу обычный текст ──
    await pool.query('DELETE FROM notification_outbox');
    const card = widgets.routeSheetWidget('RL-1', [{ order_number: 'AP-1', address: 'Адрес', status: 'pending', clock: '14:35' }]);
    assert.equal(await notifyWidget('courier', 900101, card, { kind: 'route', ref: 'nw1', fallbackText: 'Лист текстом', buttons: [[{ text: 'Я', url: 'https://ya.ru' }]], dedupKey: 'nw1' }), true);
    process.env.WIDGETS_ENABLED = '0';
    assert.equal(await notifyWidget('courier', 900101, card, { kind: 'route', ref: 'nw2', fallbackText: 'Лист текстом 2', dedupKey: 'nw2' }), false);
    delete process.env.WIDGETS_ENABLED;
    assert.equal(await notifyWidget('courier', 900101, { ...card, html: 'я'.repeat(30000) }, { kind: 'route', ref: 'nw3', fallbackText: 'Лист текстом 3', dedupKey: 'nw3' }), false, 'слишком большая карточка → текст');
    const rows = (await pool.query('SELECT method, payload, on_sent FROM notification_outbox ORDER BY id')).rows;
    assert.deepEqual(rows.map(r => r.method), ['sendWidget', 'sendMessage', 'sendMessage']);
    assert.equal(rows[0].on_sent.fallback.payload.text, 'Лист текстом'); assert.ok(rows[0].payload.reply_markup, 'кнопки карты у карточки');
    assert.equal(rows[1].payload.text, 'Лист текстом 2'); assert.equal(rows[2].payload.text, 'Лист текстом 3');
});
