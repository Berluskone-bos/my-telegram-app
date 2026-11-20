'use strict';
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js). Без неё тест пропускается.
// Настоящий обработчик кнопок курьерского бота, Telegram подменён заглушкой.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('курьерский бот: кнопки отменённого заказа не работают и клиенту не уходит «курьер в пути»', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y',
        ADMIN_CHAT_ID: '1', COURIER_BOT_TOKEN: '2:z', OUTBOX_DISABLED: '1' });
    delete process.env.ADMIN_BOT_TOKEN;

    // заглушка вместо node-telegram-bot-api: запоминаем обработчики и вызовы
    const handlers = {}, calls = [];
    let failNextRouteEdit = false;
    class FakeBot {
        on(ev, fn) { handlers[ev] = fn; }
        once() {}
        onText() {}
        getMe() { return Promise.resolve({ id: 1, username: 'x' }); }
        setMyCommands() { return Promise.resolve(true); }
        sendMessage(...a) { calls.push(['sendMessage', ...a]); return Promise.resolve({ message_id: 1 }); }
        answerCallbackQuery(...a) { calls.push(['answerCallbackQuery', ...a]); return Promise.resolve(true); }
        editMessageReplyMarkup(...a) {
            calls.push(['editMessageReplyMarkup', ...a]);
            if (failNextRouteEdit) {
                failNextRouteEdit = false;
                return Promise.reject(Object.assign(new Error('ETELEGRAM: message to edit not found'), { code: 'ETELEGRAM' }));
            }
            return Promise.resolve(true);
        }
        setWebHook() { return Promise.resolve(true); }
    }
    const origLoad = Module._load;
    Module._load = function (req, ...rest) { return req === 'node-telegram-bot-api' ? FakeBot : origLoad.call(this, req, ...rest); };
    t.after(() => { Module._load = origLoad; });

    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    await initDB();
    require('../bot/courier-bot');
    assert.equal(typeof handlers.callback_query, 'function', 'обработчик кнопок зарегистрирован');

    await pool.query('DELETE FROM notification_outbox');
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');
    const courier = await db.createCourier({ name: 'Курьер-гард', phone: '1', telegram_id: 900002, telegram_user: 'g', vehicle_type: 'авто' });
    t.after(async () => {
        await pool.query('DELETE FROM notification_outbox');
        await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes');
        await pool.query("DELETE FROM orders WHERE order_number LIKE 'AP-cg%'");
        await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
        await pool.end();
    });

    const mk = async (key) => {
        const o = await db.createOrder({ order_number: 'AP-' + key, user_id: 777004, user_name: 'К', name: 't', phone: '1', address: 'СПб, ул. Т, д. 1',
            zone: 'spb', city: 'c', street: 's', house: '1', items: [], subtotal: 1, total: 1, idempotency_key: key });
        for (const status of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) assert.equal(await db.updateOrderStatus(o.id, status), true);
        const route = await db.createRoute({ route_number: 'RL-' + key.slice(-3), route_date: '2026-11-14', courier_id: courier.id, status: 'assigned', total_orders: 1, enforceReadyOrders: true,
            stops: [{ order_id: String(o.id), order_number: o.order_number, address: o.address, phone: '1', client_name: 'К', client_chat_id: o.user_id, amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: '' }] });
        return { o, route, stopId: route.stops[0].id };
    };
    const press = async (data, replyMarkup = { inline_keyboard: [] }, messageExtras = {}) => {
        calls.length = 0;
        await handlers.callback_query({ id: 'q1', data, from: { id: 900002, first_name: 'К' }, message: { chat: { id: 900002 }, message_id: 55, reply_markup: replyMarkup, ...messageExtras } });
        await new Promise(r => setTimeout(r, 150));
    };
    const adminTexts = async () => (await pool.query("SELECT payload->>'text' AS t FROM notification_outbox WHERE bot = 'admin' ORDER BY id")).rows.map(r => r.t);
    const clientTexts = async () => (await pool.query("SELECT payload->>'text' AS t FROM notification_outbox WHERE bot = 'client' ORDER BY id")).rows.map(r => r.t);

    // заказ отменили, курьер нажимает «Принять заказ» на старом сообщении
    const a = await mk('cg1');
    await db.updateOrderStatus(a.o.id, 'CANCELLED');
    await pool.query('DELETE FROM notification_outbox');   // оставляем только то, что породит нажатие кнопки
    for (const action of ['accept', 'enroute', 'arrived', 'done']) {
        await press(`deliver_${a.route.id}_${a.stopId}_${action}`);
        const alert = calls.find(c => c[0] === 'answerCallbackQuery');
        assert.ok(alert && alert[2].show_alert, `«${action}»: курьеру показано предупреждение`);
        assert.match(alert[2].text, /отменён/);
    }
    await press(`failed_${a.route.id}_${a.stopId}`);
    assert.match(calls.find(c => c[0] === 'answerCallbackQuery')[2].text, /отменён/);
    await press(`failreason_${a.route.id}_${a.stopId}_Клиента нет дома`);
    assert.match(calls.find(c => c[0] === 'answerCallbackQuery')[2].text, /отменён/);
    await press(`delivered_${a.route.id}_${a.stopId}`);
    assert.match(calls.find(c => c[0] === 'answerCallbackQuery')[2].text, /отменён/);
    assert.deepEqual(await clientTexts(), [], 'клиенту ничего не отправлено');
    assert.deepEqual(await adminTexts(), [], 'админу о кнопках отменённого заказа ничего не отправлено');
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [a.stopId])).rows[0].status, 'cancelled', 'остановка не перезаписана');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [a.o.id])).rows[0].status, 'CANCELLED');

    // Нельзя оценить ещё не доставленную остановку или подменить ID курьера.
    const c = await mk('cg3');
    assert.equal((await db.rateCourierForStop(c.stopId, courier.id, 777004, 5)).status, 'not_delivered');
    assert.equal((await db.rateCourierForStop(c.stopId, courier.id + 100000, 777004, 5)).status, 'not_allowed');

    // кнопка «Поехал!» (начало маршрута) клиентам ничего не отправляет
    await press(`startroute_${c.route.id}`);
    assert.deepEqual(await clientTexts(), [], '«Поехал!» клиенту сообщений не шлёт');
    await pool.query('DELETE FROM notification_outbox');

    // обычный заказ: сообщения клиенту уходят на правильных шагах
    //   «Принять заказ» — клиенту ничего (курьер лишь взял заказ со склада)
    //   «В пути» — «Курьер в пути / везёт ваш заказ»; «У клиента» — «Курьер приехал»; «Доставлен» — «Доставлен»
    const b = await mk('cg2');
    await press(`deliver_${b.route.id}_${b.stopId}_accept`);
    assert.ok(!calls.some(c => c[0] === 'answerCallbackQuery' && c[2] && c[2].show_alert), 'предупреждения нет');
    assert.deepEqual(await clientTexts(), [], 'после «Принять» клиенту ничего не отправлено');
    const startPrompt = calls.find(c => c[0] === 'sendMessage' &&
        c[3]?.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data === `startroute_${b.route.id}`));
    assert.ok(startPrompt, 'после принятия единственного заказа курьеру показана кнопка общего старта маршрута');
    assert.match(startPrompt[2], /Все заказы маршрута .* приняты/);
    const acceptedCard = calls.find(c => c[0] === 'editMessageReplyMarkup');
    assert.ok(acceptedCard, 'карточка принятого заказа обновлена');
    assert.equal(
        acceptedCard[1].inline_keyboard.flat().some(button => /_arrived$/.test(button.callback_data || '')),
        false,
        'до общего старта у принятого заказа нет преждевременной кнопки «У клиента»'
    );
    assert.equal((await adminTexts()).length, 1); assert.match((await adminTexts())[0], /принял заказ \(забрал со склада\)/);

    // Курьер запускает маршрут из того же чата, не переходя на отдельный экран.
    await press(`startroute_${b.route.id}`);
    assert.equal((await db.getRouteById(b.route.id)).status, 'in_progress', 'кнопка из сообщения запускает маршрут');
    assert.equal((await adminTexts()).length, 2, 'админ получает отдельное уведомление о старте маршрута');
    assert.ok((await adminTexts())[1].startsWith('[МАРШРУТ]') && /начат курьером/i.test((await adminTexts())[1]));
    const enroutePrompt = calls.find(c => c[0] === 'sendMessage' &&
        c[3]?.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data === `deliver_${b.route.id}_${b.stopId}_enroute`));
    assert.ok(enroutePrompt, 'после общего старта курьер получает карточку с кнопкой «В пути»');
    assert.match(enroutePrompt[2], /AP-cg2/);
    assert.match(enroutePrompt[2], /СПб, ул\. Т/);
    await pool.query("DELETE FROM notification_outbox WHERE bot = 'client'");

    await press(`deliver_${b.route.id}_${b.stopId}_enroute`);
    let texts = await clientTexts();
    assert.equal(texts.length, 1); assert.match(texts[0], /Курьер в пути/); assert.match(texts[0], /везёт ваш заказ/);
    await press(`deliver_${b.route.id}_${b.stopId}_enroute`);   // повторное нажатие не дублирует сообщение
    assert.equal((await clientTexts()).length, 1, 'дубля нет');
    assert.equal((await adminTexts()).length, 3, 'уведомление админу о выезде не дублируется; отдельно учитывается старт маршрута');
    assert.match((await adminTexts())[2], /выехал к клиенту/);

    await press(`deliver_${b.route.id}_${b.stopId}_arrived`);
    texts = await clientTexts();
    assert.equal(texts.length, 2); assert.match(texts[1], /Курьер приехал/);

    await press(`deliver_${b.route.id}_${b.stopId}_done`);
    texts = await clientTexts();
    assert.ok(texts.length >= 3); assert.match(texts[2], /Доставлен/);
    const adm = await adminTexts();
    assert.equal(adm.length, 5);
    assert.match(adm[3], /приехал к клиенту/);
    assert.match(adm[4], /заказ доставлен/);
    assert.match(adm[4], new RegExp('AP-cg2'));

    // Оценку может отправить только владелец доставленного заказа; параллельные повторы дают одно начисление.
    const initialCount = Number((await pool.query('SELECT rating_count FROM couriers WHERE id = $1', [courier.id])).rows[0].rating_count);
    assert.equal((await db.rateCourierForStop(b.stopId, courier.id, 999999, 5)).status, 'not_allowed');
    assert.equal(Number((await pool.query('SELECT rating_count FROM couriers WHERE id = $1', [courier.id])).rows[0].rating_count), initialCount);
    const concurrentRatings = await Promise.all([
        db.rateCourierForStop(b.stopId, courier.id, 777004, 5),
        db.rateCourierForStop(b.stopId, courier.id, 777004, 1)
    ]);
    assert.deepEqual(concurrentRatings.map(x => x.status).sort(), ['already_rated', 'rated']);
    const storedRating = Number((await pool.query('SELECT client_rating FROM route_stops WHERE id = $1', [b.stopId])).rows[0].client_rating);
    assert.ok([1, 5].includes(storedRating));
    assert.equal(Number((await pool.query('SELECT rating_count FROM couriers WHERE id = $1', [courier.id])).rows[0].rating_count), initialCount + 1);
    assert.equal((await db.rateCourierForStop(b.stopId, courier.id, 777004, 3)).status, 'already_rated');
    assert.equal((await db.rateCourierForStop(b.stopId, courier.id, 777005, 4)).status, 'not_allowed');

    // Маршрут из трёх заказов: одна карта со всеми точками и строго последовательные клиентские статусы.
    await pool.query('DELETE FROM notification_outbox');
    const multiOrders = [];
    for (let i = 1; i <= 3; i++) {
        const key = `cg_multi_${i}`;
        const o = await db.createOrder({ order_number: 'AP-' + key, user_id: 777010 + i, user_name: 'К', name: 't', phone: '1',
            address: `СПб, адрес ${i}`, zone: 'spb', city: 'c', street: 's', house: String(i), items: [], subtotal: 1, total: 1, idempotency_key: key });
        for (const status of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) assert.equal(await db.updateOrderStatus(o.id, status), true);
        multiOrders.push(o);
    }
    const multiRoute = await db.createRoute({
        route_number: 'RL-CGMULTI', route_date: '2026-11-14', courier_id: courier.id, status: 'assigned',
        total_orders: 3, enforceReadyOrders: true,
        stops: multiOrders.map((o, i) => ({
            order_id: String(o.id), order_number: o.order_number, stop_number: i + 1,
            address: o.address, lat: 59.93 + i * 0.01, lon: 30.33 + i * 0.01,
            phone: '1', client_name: 'К', client_chat_id: o.user_id,
            amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: ''
        }))
    });
    for (const st of multiRoute.stops) await press(`deliver_${multiRoute.id}_${st.id}_accept`);
    await press(`startroute_${multiRoute.id}`);
    const routeCard = calls.filter(c => c[0] === 'sendMessage');
    assert.equal(routeCard.length, 1, 'после старта отправляется одно сообщение с единым маршрутом');
    const routeText = routeCard[0][2];
    assert.match(routeText, /1\. <b>AP-cg_multi_1/);
    assert.match(routeText, /2\. <b>AP-cg_multi_2/);
    assert.match(routeText, /3\. <b>AP-cg_multi_3/);
    const routeKeyboard = routeCard[0][3].reply_markup.inline_keyboard;
    const mapButtons = routeKeyboard.flat().filter(x => x.url);
    assert.equal(mapButtons.length, 2, 'одна карточка содержит ссылки на общий маршрут в навигаторах');
    assert.match(mapButtons[0].url, /59\.93,30\.33~59\.94,30\.34~59\.95,30\.35/);
    assert.ok(routeKeyboard.flat().some(x => x.callback_data === `deliver_${multiRoute.id}_${multiRoute.stops[0].id}_enroute`));
    assert.deepEqual(await clientTexts(), [], 'при старте маршрута ни один клиент не получает преждевременное «Курьер в пути»');

    await press(`deliver_${multiRoute.id}_${multiRoute.stops[0].id}_enroute`, { inline_keyboard: routeKeyboard });
    let multiClientTexts = await clientTexts();
    assert.equal(multiClientTexts.length, 1, 'после «В пути» уведомляется только первый клиент');
    assert.match(multiClientTexts[0], /AP-cg_multi_1/);
    await press(`deliver_${multiRoute.id}_${multiRoute.stops[1].id}_enroute`, { inline_keyboard: routeKeyboard });
    assert.equal((await clientTexts()).length, 1, 'нельзя начать вторую точку до завершения первой');
    assert.match(calls.find(c => c[0] === 'answerCallbackQuery')[2].text, /предыдущую доставку/);

    await press(`deliver_${multiRoute.id}_${multiRoute.stops[0].id}_arrived`, { inline_keyboard: routeKeyboard });
    await press(`deliver_${multiRoute.id}_${multiRoute.stops[0].id}_done`, { inline_keyboard: routeKeyboard });
    const nextKeyboardCall = calls.filter(c => c[0] === 'editMessageReplyMarkup').at(-1);
    assert.ok(nextKeyboardCall?.[1]?.inline_keyboard?.flat().some(x =>
        x.callback_data === `deliver_${multiRoute.id}_${multiRoute.stops[1].id}_enroute`),
        'после завершения первой доставки в той же карточке открывается вторая точка');
    assert.equal((await clientTexts()).length, 3, 'первый клиент получает «В пути», «У клиента», «Доставлен»; второй пока не уведомлён');

    await press(`deliver_${multiRoute.id}_${multiRoute.stops[1].id}_enroute`);
    multiClientTexts = await clientTexts();
    assert.ok(multiClientTexts.some(t => /AP-cg_multi_2/.test(t) && /Курьер в пути/.test(t)),
        'второй клиент получает уведомление только после завершения первой доставки');
    assert.ok(!multiClientTexts.some(t => /AP-cg_multi_3/.test(t)),
        'третий клиент не уведомляется до завершения второй доставки');

    // Недоставка первой из трёх точек должна закрыть только остановку, а не весь маршрут.
    await pool.query('DELETE FROM notification_outbox');
    const failedOrders = [];
    for (let i = 1; i <= 3; i++) {
        const key = `cg_failed_${i}`;
        const o = await db.createOrder({ order_number: 'AP-' + key, user_id: 777020 + i, user_name: 'К', name: 't', phone: '1',
            address: `СПб, адрес недоставки ${i}`, zone: 'spb', city: 'c', street: 's', house: String(i), items: [], subtotal: 1, total: 1, idempotency_key: key });
        for (const status of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) assert.equal(await db.updateOrderStatus(o.id, status), true);
        failedOrders.push(o);
    }
    const failedRoute = await db.createRoute({
        route_number: 'RL-CGFAILED', route_date: '2026-11-14', courier_id: courier.id, status: 'assigned',
        total_orders: 3, enforceReadyOrders: true,
        stops: failedOrders.map((o, i) => ({
            order_id: String(o.id), order_number: o.order_number, stop_number: i + 1,
            address: o.address, lat: 59.96 + i * 0.01, lon: 30.36 + i * 0.01,
            phone: '1', client_name: 'К', client_chat_id: o.user_id,
            amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: ''
        }))
    });
    for (const st of failedRoute.stops) await press(`deliver_${failedRoute.id}_${st.id}_accept`);
    await press(`startroute_${failedRoute.id}`);
    const failedRouteCard = calls.find(c => c[0] === 'sendMessage' &&
        c[3]?.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data === `deliver_${failedRoute.id}_${failedRoute.stops[0].id}_enroute`));
    assert.ok(failedRouteCard, 'общая карточка трёх точек создана');

    await press(`failed_${failedRoute.id}_${failedRoute.stops[0].id}`, failedRouteCard[3].reply_markup);
    const reasonPrompt = calls.find(c => c[0] === 'sendMessage' && /Причина не доставки/.test(c[2]));
    assert.ok(reasonPrompt, 'курьеру показан выбор причины недоставки');
    assert.equal(reasonPrompt[3].reply_to_message_id, 55, 'причина привязана к общей карточке маршрута');

    // Telegram может отклонить редактирование исходной маршрутной карточки.
    // В этом случае бот обязан прислать новую карточку с кнопкой следующей остановки.
    failNextRouteEdit = true;
    await press(`failreason_${failedRoute.id}_${failedRoute.stops[0].id}_Не отвечает на звонки`, reasonPrompt[3].reply_markup,
        { reply_to_message: { message_id: 55 } });
    let failedState = await db.getRouteById(failedRoute.id);
    assert.equal(failedState.stops[0].status, 'failed', 'первая остановка отмечена как недоставленная');
    assert.equal(failedState.stops[0].fail_reason, 'Не отвечает на звонки');
    assert.equal(failedState.status, 'in_progress', 'маршрут остаётся в пути, пока есть две активные точки');
    assert.equal(Number(failedState.failed), 1, 'счётчик недоставленных обновлён');
    assert.equal((await db.getOrderByNumber(failedOrders[0].id)).status, 'SHIPPING', 'заказ не отменён и не помечен доставленным');
    const fallbackCard = calls.find(c => c[0] === 'sendMessage' &&
        c[3]?.reply_markup?.inline_keyboard?.flat()?.some(b =>
            b.callback_data === `deliver_${failedRoute.id}_${failedRoute.stops[1].id}_enroute`));
    assert.ok(fallbackCard, 'если Telegram не дал отредактировать старую карточку, курьер получает новую');
    assert.match(fallbackCard[2], /Следующая точка: 1 из 2/);
    assert.ok(!fallbackCard[3].reply_markup.inline_keyboard.flat().some(b =>
        b.callback_data === `deliver_${failedRoute.id}_${failedRoute.stops[0].id}_enroute`),
        'недоставленная точка больше не активна');
    assert.equal(Number((await pool.query('SELECT failed FROM delivery_routes WHERE id = $1', [failedRoute.id])).rows[0].failed), 1, 'счётчик недоставки маршрута обновлён');
    assert.ok(Number((await db.getDayStats('2026-11-14')).failed) >= 1, 'общая статистика учитывает недоставку (в ней также могут быть отменённые остановки)');
    assert.ok((await adminTexts()).some(t => /Не доставлено/.test(t) && /Не отвечает на звонки/.test(t)),
        'админ получает статус и причину недоставки');
    assert.ok((await clientTexts()).some(t => /не доставлен/.test(t) && /Не отвечает на звонки/.test(t)),
        'клиент получает уведомление о неудачной попытке, без сообщения о доставке');

    await press(`deliver_${failedRoute.id}_${failedRoute.stops[1].id}_enroute`, fallbackCard[3].reply_markup);
    assert.ok((await clientTexts()).some(t => /AP-cg_failed_2/.test(t) && /Курьер в пути/.test(t)),
        'следующий клиент получает уведомление только после закрытия предыдущей остановки');
});
