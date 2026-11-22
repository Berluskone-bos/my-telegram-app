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
    let nextMessageId = 1000;
    let nextCallbackId = 0;
    class FakeBot {
        on(ev, fn) { handlers[ev] = fn; }
        once() {}
        onText() {}
        getMe() { return Promise.resolve({ id: 1, username: 'x' }); }
        setMyCommands() { return Promise.resolve(true); }
        sendMessage(...a) { const result = { message_id: nextMessageId++ }; calls.push(['sendMessage', ...a, result]); return Promise.resolve(result); }
        answerCallbackQuery(...a) { calls.push(['answerCallbackQuery', ...a]); return Promise.resolve(true); }
        editMessageReplyMarkup(...a) {
            calls.push(['editMessageReplyMarkup', ...a]);
            if (failNextRouteEdit) {
                failNextRouteEdit = false;
                return Promise.reject(Object.assign(new Error('ETELEGRAM: message to edit not found'), { code: 'ETELEGRAM' }));
            }
            return Promise.resolve(true);
        }
        editMessageText(...a) {
            calls.push(['editMessageText', ...a]);
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

    // Регистрация курьера и outbox-заявка должны коммититься вместе.
    const testTelegramBase = 900000000000 + (Date.now() % 1000000000);
    const rollbackTelegramId = testTelegramBase;
    const successTelegramId = testTelegramBase + 1;
    const rollbackKey = `courier-registration-rollback:${rollbackTelegramId}`;
    const successKey = `courier-registration-success:${successTelegramId}`;
    const makeCourier = telegramId => ({
        name: 'Тест атомарной регистрации', phone: '+70000000000',
        telegram_id: telegramId, telegram_user: 'atomic-test', vehicle_type: 'авто',
        zones: ['spb'], is_active: false
    });
    await assert.rejects(
        db.createCourier(makeCourier(rollbackTelegramId), {
            afterCreate: async ({ client, courier: created }) => {
                await client.query(
                    `INSERT INTO notification_outbox (bot, method, payload, dedup_key)
                     VALUES ('admin', 'sendMessage', $1::jsonb, $2)`,
                    [JSON.stringify({ chat_id: '1', text: `courier ${created.id}` }), rollbackKey]
                );
                throw new Error('simulated outbox enqueue failure');
            }
        }),
        /simulated outbox enqueue failure/
    );
    assert.equal((await pool.query('SELECT 1 FROM couriers WHERE telegram_id = $1', [rollbackTelegramId])).rowCount, 0,
        'курьер не создаётся, если запись заявки в outbox завершилась ошибкой');
    assert.equal((await pool.query('SELECT 1 FROM notification_outbox WHERE dedup_key = $1', [rollbackKey])).rowCount, 0,
        'outbox-запись откатывается вместе с регистрацией');

    const createdAtomic = await db.createCourier(makeCourier(successTelegramId), {
        afterCreate: async ({ client, courier: created }) => {
            await client.query(
                `INSERT INTO notification_outbox (bot, method, payload, dedup_key)
                 VALUES ('admin', 'sendMessage', $1::jsonb, $2)`,
                [JSON.stringify({ chat_id: '1', text: `courier ${created.id}` }), successKey]
            );
        }
    });
    assert.ok(createdAtomic.id);
    assert.equal((await pool.query('SELECT 1 FROM notification_outbox WHERE dedup_key = $1', [successKey])).rowCount, 1,
        'заявка администратора сохранена вместе с курьером');
    await pool.query('DELETE FROM notification_outbox WHERE dedup_key = ANY($1::text[])', [[rollbackKey, successKey]]);
    await pool.query('DELETE FROM couriers WHERE telegram_id = ANY($1::bigint[])', [[rollbackTelegramId, successTelegramId]]);

    require('../bot/courier-bot');
    assert.equal(typeof handlers.callback_query, 'function', 'обработчик кнопок зарегистрирован');

    await pool.query('DELETE FROM notification_outbox');
    await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes'); await pool.query('DELETE FROM orders');
    const courier = await db.createCourier({ name: 'Курьер-гард', phone: '+7 999 000-00-00', telegram_id: 900002, telegram_user: 'g', vehicle_type: 'авто' });
    const otherCourier = await db.createCourier({ name: 'Другой курьер', phone: '+7 999 000-00-01', telegram_id: 900003, telegram_user: 'other', vehicle_type: 'авто' });
    t.after(async () => {
        await pool.query('DELETE FROM notification_outbox');
        await pool.query('DELETE FROM route_stops'); await pool.query('DELETE FROM delivery_routes');
        await pool.query("DELETE FROM orders WHERE order_number LIKE 'AP-cg%'");
        await pool.query('DELETE FROM couriers WHERE id = ANY($1::int[])', [[courier.id, otherCourier.id]]);
        await pool.query('DELETE FROM couriers WHERE telegram_id = $1', [900004]);
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
    const press = async (data, replyMarkup = { inline_keyboard: [] }, messageExtras = {}, telegramId = 900002) => {
        calls.length = 0;
        await handlers.callback_query({ id: `q${++nextCallbackId}`, data, from: { id: telegramId, first_name: 'К' }, message: { chat: { id: telegramId, type: 'private' }, message_id: 55, reply_markup: replyMarkup, ...messageExtras } });
        await new Promise(r => setTimeout(r, 150));
    };
    const adminTexts = async () => (await pool.query("SELECT payload->>'text' AS t FROM notification_outbox WHERE bot = 'admin' AND method = 'sendMessage' ORDER BY id")).rows.map(r => r.t);
    const clientTexts = async () => (await pool.query("SELECT payload->>'text' AS t FROM notification_outbox WHERE bot = 'client' AND method = 'sendMessage' ORDER BY id")).rows.map(r => r.t);
    const courierPayload = async (key) => (await pool.query("SELECT payload FROM notification_outbox WHERE bot = 'courier' AND dedup_key = $1", [key])).rows[0]?.payload;

    // Прямой вызов callback с ID маршрута другого курьера не раскрывает данные и не меняет состояние.
    const foreignOrder = await db.createOrder({ order_number: 'AP-cg_foreign', user_id: 777099, user_name: 'К', name: 't', phone: '1',
        address: 'СПб, чужой адрес', zone: 'spb', city: 'c', street: 's', house: '99', items: [], subtotal: 1, total: 1, idempotency_key: 'cg_foreign' });
    for (const status of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) assert.equal(await db.updateOrderStatus(foreignOrder.id, status), true);
    const foreignRoute = await db.createRoute({ route_number: 'RL-CGFOREIGN', route_date: '2026-11-14', courier_id: otherCourier.id,
        status: 'assigned', total_orders: 1, enforceReadyOrders: true,
        stops: [{ order_id: String(foreignOrder.id), order_number: foreignOrder.order_number, address: foreignOrder.address, phone: '1',
            client_name: 'К', client_chat_id: foreignOrder.user_id, amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: '' }] });
    const foreignStopId = foreignRoute.stops[0].id;
    const foreignActions = ['showroute_' + foreignRoute.id, 'startroute_' + foreignRoute.id, 'deliver_' + foreignRoute.id + '_' + foreignStopId + '_accept'];
    for (const action of foreignActions) {
        await press(action);
        const denied = calls.find(x => x[0] === 'answerCallbackQuery');
        assert.ok(denied, 'чужое действие отклонено');
        assert.match(denied[2].text, /Нет доступа/);
        assert.equal(calls.some(x => x[0] === 'sendMessage'), false, 'данные чужого маршрута не отправлены в чат');
    }
    // Даже владелец курьерского аккаунта не может использовать старую маршрутную кнопку из группы.
    await press('showroute_' + foreignRoute.id, { inline_keyboard: [] }, { chat: { id: -100900002, type: 'supergroup' } });
    const groupDenied = calls.find(x => x[0] === 'answerCallbackQuery');
    assert.ok(groupDenied);
    assert.match(groupDenied[2].text, /личный чат/);
    assert.equal(calls.some(x => x[0] === 'sendMessage'), false, 'в группу не отправляются адреса и данные маршрута');
    assert.equal((await db.getRouteById(foreignRoute.id)).status, 'assigned', 'групповая кнопка не меняет маршрут');

    // Старая кнопка «Обновить» не должна открывать главный экран отключённому курьеру.
    const inactiveCourier = await db.createCourier({
        name: 'Отключённый курьер', phone: '+7 999 000-00-02',
        telegram_id: 900004, telegram_user: 'inactive', vehicle_type: 'авто', is_active: false
    });
    assert.ok(inactiveCourier.id);
    await press('refresh_main', { inline_keyboard: [] }, {}, 900004);
    const inactiveRefresh = calls.find(x => x[0] === 'sendMessage');
    assert.ok(inactiveRefresh, 'отключённому курьеру отправлено сообщение о закрытом доступе');
    assert.match(inactiveRefresh[2], /ещё не активирован|отключён/i);
    assert.equal(calls.some(x => x[0] === 'editMessageText'), false, 'главный экран и маршрутная сводка не открываются');
    assert.equal(calls.some(x => x[0] === 'sendMessage' && /АВТОПРОМОЙЛ — Курьер/.test(x[2])), false,
        'отключённому курьеру не показывается экран со сводкой');

    assert.equal((await db.getRouteById(foreignRoute.id)).status, 'assigned', 'чужой маршрут не изменён');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [foreignOrder.id])).rows[0].status, 'READY_FOR_SHIPMENT');
    // Callback ID должен быть строго десятичным: parseInt("123junk") не должен
    // превращать подменённую строку в действующий ID существующего маршрута/остановки.
    const malformed = await mk('cg_malformed');
    for (const payload of [
        `deliver_${malformed.route.id}junk_${malformed.stopId}_accept`,
        `deliver_${malformed.route.id}_${malformed.stopId}junk_accept`,
        `failreason_${malformed.route.id}_${malformed.stopId}junk_nohome`,
        `showroute_${malformed.route.id}junk`
    ]) {
        await press(payload);
        const rejected = calls.find(x => x[0] === 'answerCallbackQuery');
        assert.ok(rejected, 'malformed callback must be answered');
        assert.match(rejected[2].text, /Некорректное действие|Некорректный номер/);
    }
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [malformed.stopId])).rows[0].status, 'pending',
        'malformed IDs do not mutate a real stop');

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
    const startPrompt = await courierPayload(`route-all-accepted:${b.route.id}`);
    assert.ok(startPrompt, 'после принятия единственного заказа уведомление о старте маршрута сохранено в outbox');
    assert.match(startPrompt.text, /Все заказы маршрута .* приняты/);
    assert.ok(startPrompt.reply_markup.inline_keyboard.flat().some(button => button.callback_data === `startroute_${b.route.id}`));
    const acceptedCard = calls.find(c => c[0] === 'editMessageReplyMarkup');
    assert.ok(acceptedCard, 'карточка принятого заказа обновлена');
    assert.equal(
        acceptedCard[1].inline_keyboard.flat().some(button => /_arrived$/.test(button.callback_data || '')),
        false,
        'до общего старта у принятого заказа нет преждевременной кнопки «У клиента»'
    );
    assert.equal((await adminTexts()).length, 1); assert.match((await adminTexts())[0], /принял заказ \(забрал со склада\)/);
    await press(`deliver_${b.route.id}_${b.stopId}_accept`); // новый callback_query.id, те же callback_data
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM notification_outbox WHERE dedup_key = $1", [`route-all-accepted:${b.route.id}`])).rows[0].n, 1,
        'повторный callback не создаёт второе уведомление о готовности к старту');
    assert.equal((await adminTexts()).length, 1, 'повторный callback не дублирует уведомление администратору');

    // Курьер запускает маршрут из того же чата, не переходя на отдельный экран.
    await press(`startroute_${b.route.id}`);
    assert.equal((await db.getRouteById(b.route.id)).status, 'in_progress', 'кнопка из сообщения запускает маршрут');
    assert.equal((await adminTexts()).length, 2, 'админ получает отдельное уведомление о старте маршрута');
    assert.ok((await adminTexts())[1].startsWith('[МАРШРУТ]') && /начат курьером/i.test((await adminTexts())[1]));
    await press(`startroute_${b.route.id}`); // новый callback_query.id, маршрут уже начат
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM notification_outbox WHERE dedup_key = $1", [`route-start-card:${b.route.id}`])).rows[0].n, 1,
        'повторный callback старта не создаёт вторую карточку маршрута');
    assert.equal((await adminTexts()).length, 2, 'повторный callback старта не дублирует уведомление администратору');
    const enroutePrompt = await courierPayload(`route-start-card:${b.route.id}`);
    assert.ok(enroutePrompt, 'после общего старта маршрутная карточка сохранена в outbox');
    assert.ok(enroutePrompt.reply_markup.inline_keyboard.flat().some(button => button.callback_data === `deliver_${b.route.id}_${b.stopId}_enroute`));
    assert.match(enroutePrompt.text, /AP-cg2/);
    assert.match(enroutePrompt.text, /СПб, ул\. Т/);
    await pool.query("DELETE FROM notification_outbox WHERE bot = 'client'");

    await press(`deliver_${b.route.id}_${b.stopId}_enroute`);
    let texts = await clientTexts();
    assert.equal(texts.length, 1); assert.match(texts[0], /Курьер выехал/); assert.match(texts[0], /везёт ваш заказ/);
    assert.match(texts[0], /Для уточнения времени прибытия позвоните курьеру/);
    assert.match(texts[0], /\+7 999 000-00-00/);
    assert.doesNotMatch(texts[0], /ориентировочно|через ~|около \d{1,2}:\d{2}/i);
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

    // ===== Маршрут из трёх заказов: одно сообщение-карточка, номера, свободный выбор заказа =====
    await pool.query('DELETE FROM notification_outbox');
    const mkMulti = async (prefix, routeNumber, baseLat) => {
        const orders = [];
        for (let i = 1; i <= 3; i++) {
            const key = `${prefix}_${i}`;
            const o = await db.createOrder({ order_number: 'AP-' + key, user_id: 777010 + i, user_name: 'К', name: 't', phone: '1',
                address: `СПб, адрес ${i}`, zone: 'spb', city: 'c', street: 's', house: String(i), items: [], subtotal: 1, total: 1, idempotency_key: key });
            for (const status of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) assert.equal(await db.updateOrderStatus(o.id, status), true);
            orders.push(o);
        }
        const route = await db.createRoute({
            route_number: routeNumber, route_date: '2026-11-14', courier_id: courier.id, status: 'assigned',
            total_orders: 3, enforceReadyOrders: true,
            stops: orders.map((o, i) => ({
                order_id: String(o.id), order_number: o.order_number, stop_number: i + 1,
                address: o.address, lat: baseLat + i * 0.01, lon: 30.33 + i * 0.01,
                phone: '1', client_name: 'К', client_chat_id: o.user_id,
                amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: ''
            }))
        });
        for (const st of route.stops) await press(`deliver_${route.id}_${st.id}_accept`);
        return { orders, route, stops: route.stops };
    };
    const lastCard = () => {
        const edits = calls.filter(c => c[0] === 'editMessageText');
        return edits.length ? { text: edits.at(-1)[1], keyboard: edits.at(-1)[2].reply_markup.inline_keyboard } : null;
    };
    const hasBtn = (kb, data) => kb.flat().some(b => b.callback_data === data);
    const orderStatus = async (id) => (await pool.query('SELECT status FROM orders WHERE id = $1', [id])).rows[0].status;

    const M = await mkMulti('cg_multi', 'RL-CGMULTI', 59.93);
    const [s1, s2, s3] = M.stops;
    await press(`startroute_${M.route.id}`);
    const sent = await courierPayload(`route-start-card:${M.route.id}`);
    assert.ok(sent, 'после старта — одно маршрутное сообщение сохранено в outbox');
    const cardText = sent.text;
    assert.match(cardText, /1\. <b>AP-cg_multi_1/);
    assert.match(cardText, /2\. <b>AP-cg_multi_2/);
    assert.match(cardText, /3\. <b>AP-cg_multi_3/);
    assert.match(cardText, /Заказов: 3 · доставлено: 0 · не доставлено: 0 · осталось: 3/);
    assert.match(cardText, /Сейчас: заказ 1 из 3/);
    const kb0 = sent.reply_markup.inline_keyboard;
    assert.equal(kb0.flat().filter(b => b.url && /~/.test(b.url)).length >= 1, true, 'есть ссылка на весь маршрут');
    assert.ok(hasBtn(kb0, `deliver_${M.route.id}_${s1.id}_enroute`), 'для первого заказа кнопка «В пути»');
    assert.ok(hasBtn(kb0, `failed_${M.route.id}_${s1.id}`), 'кнопка «Не доставлено» с номером');
    assert.ok(kb0.flat().some(b => b.text === 'Выбрать №2') && kb0.flat().some(b => b.text === 'Выбрать №3'), 'курьер может выбрать любой заказ');
    assert.deepEqual(await clientTexts(), [], 'при старте клиентам ничего не уходит');

    // Курьер сам выбирает заказ №2 — то же сообщение перерисовывается, новых сообщений нет
    await press(`pickstop_${M.route.id}_${s2.id}`);
    assert.equal(calls.filter(c => c[0] === 'sendMessage').length, 0, 'выбор заказа не создаёт новых сообщений');
    let card = lastCard();
    assert.match(card.text, /Сейчас: заказ 2 из 3/);
    assert.ok(hasBtn(card.keyboard, `deliver_${M.route.id}_${s2.id}_enroute`));
    assert.ok(hasBtn(card.keyboard, `pickstop_${M.route.id}_${s1.id}`));

    // Едет к №2 (не к первому): порядок не навязывается; уведомляется только клиент №2
    await press(`deliver_${M.route.id}_${s2.id}_enroute`);
    assert.ok(!calls.some(c => c[0] === 'answerCallbackQuery' && c[2]?.show_alert), 'свободный выбор заказа не блокируется');
    let ct = await clientTexts();
    assert.equal(ct.length, 1); assert.match(ct[0], /AP-cg_multi_2/); assert.match(ct[0], /Курьер выехал/);
    card = lastCard();
    assert.match(card.text, /2\. <b>AP-cg_multi_2<\/b>[^\n]*\n\s+в пути к клиенту/);
    assert.ok(hasBtn(card.keyboard, `deliver_${M.route.id}_${s2.id}_arrived`), 'следующий шаг — «У клиента»');
    await press(`deliver_${M.route.id}_${s2.id}_enroute`);
    assert.equal((await clientTexts()).length, 1, 'повторное нажатие не дублирует сообщение клиенту');

    await press(`deliver_${M.route.id}_${s2.id}_arrived`);
    assert.equal((await clientTexts()).length, 2);
    assert.match(lastCard().text, /курьер у клиента/);
    // Прямая попытка изменить этап через DB adapter тоже блокируется — не только Telegram guard.
    assert.equal(await db.setStopStage(s3.id, 'enroute'), null,
        'БД не позволяет начать другой заказ, пока предыдущий имеет stage=arrived');
    assert.equal((await db.getRouteById(M.route.id)).stops.find(s => Number(s.id) === Number(s3.id)).stage, null);
    // Пока курьер у клиента №2, другой заказ в путь не берём
    await press(`deliver_${M.route.id}_${s3.id}_enroute`);
    const blocked = calls.find(c => c[0] === 'answerCallbackQuery');
    assert.ok(blocked[2].show_alert && /Сначала закончите заказ №2/.test(blocked[2].text));
    assert.equal((await clientTexts()).length, 2, 'клиент №3 не получил «Курьер выехал»');

    await press(`deliver_${M.route.id}_${s2.id}_done`);
    assert.equal(await orderStatus(M.orders[1].id), 'COMPLETED');
    card = lastCard();
    assert.match(card.text, /Заказов: 3 · доставлено: 1 · не доставлено: 0 · осталось: 2/);
    assert.match(card.text, /2\. <b>AP-cg_multi_2<\/b>[^\n]*\n\s+доставлен/);
    assert.ok(!hasBtn(card.keyboard, `deliver_${M.route.id}_${s2.id}_done`), 'у доставленного заказа кнопок нет');
    // кнопка на старом сообщении по уже доставленному заказу — предупреждение, а не повторная отправка
    const departureTexts = async () => (await clientTexts()).filter(t => /Курьер выехал/.test(t));
    const before = (await departureTexts()).length;
    await press(`deliver_${M.route.id}_${s2.id}_enroute`);
    assert.match(calls.find(c => c[0] === 'answerCallbackQuery')[2].text, /уже доставлен/);
    assert.equal((await departureTexts()).length, before, 'повторная кнопка доставленного заказа не отправляет повторное сообщение «Курьер выехал»');

    // ===== «Не доставлен» первого заказа: статус в админке меняется, одно сообщение, причина кодом =====
    await pool.query('DELETE FROM notification_outbox');
    await press(`failed_${M.route.id}_${s1.id}`);
    assert.equal(calls.filter(c => c[0] === 'sendMessage').length, 0, 'выбор причины — в том же сообщении');
    card = lastCard();
    assert.match(card.text, /почему не доставлен/);
    assert.ok(hasBtn(card.keyboard, `failreason_${M.route.id}_${s1.id}_nohome`));
    assert.ok(hasBtn(card.keyboard, `pickstop_${M.route.id}_${s1.id}`), '«Назад, заказ не отмечать»');
    for (const b of card.keyboard.flat()) assert.ok(Buffer.byteLength(b.callback_data || '') <= 64, 'callback_data не длиннее 64 байт');
    assert.equal(await orderStatus(M.orders[0].id), 'SHIPPING', 'пока причина не выбрана, статус не меняется');

    await press(`failreason_${M.route.id}_${s1.id}_nohome`);
    const st = await db.getRouteById(M.route.id);
    assert.equal(st.stops[0].status, 'failed');
    assert.equal(st.stops[0].fail_reason, 'Клиента нет дома');
    assert.equal(st.status, 'in_progress', 'маршрут остаётся в работе, пока есть заказ №3');
    assert.equal(await orderStatus(M.orders[0].id), 'DELIVERY_FAILED', 'в админке статус «Не доставлен», а не «В доставке»');
    assert.equal(calls.filter(c => c[0] === 'sendMessage').length, 0, 'после причины новых сообщений нет');
    card = lastCard();
    assert.match(card.text, /1\. <b>AP-cg_multi_1<\/b>[^\n]*\n\s+НЕ ДОСТАВЛЕН \(Клиента нет дома\)/);
    assert.match(card.text, /доставлено: 1 · не доставлено: 1 · осталось: 1/);
    assert.match(card.text, /Сейчас: заказ 3 из 3/);
    assert.ok(!hasBtn(card.keyboard, `deliver_${M.route.id}_${s1.id}_enroute`), 'для недоставленного кнопок нет');
    assert.ok((await adminTexts()).some(t => /НЕ ДОСТАВЛЕНО/.test(t) && /Клиента нет дома/.test(t) && /Не доставлен/.test(t)), 'админ-бот: статус и причина');
    assert.ok((await clientTexts()).some(t => /AP-cg_multi_1/.test(t) && /не доставлен/.test(t)), 'клиенту: попытка не удалась');
    await press(`failreason_${M.route.id}_${s1.id}_nohome`);   // повторное нажатие
    assert.equal((await adminTexts()).filter(t => /НЕ ДОСТАВЛЕНО/.test(t)).length, 1, 'админу сообщение не дублируется');

    // Последний заказ доставлен: маршрут завершается, итог в той же карточке
    await press(`deliver_${M.route.id}_${s3.id}_enroute`);
    await press(`deliver_${M.route.id}_${s3.id}_arrived`);
    await press(`deliver_${M.route.id}_${s3.id}_done`);
    assert.equal((await db.getRouteById(M.route.id)).status, 'completed');
    assert.match(lastCard().text, /Маршрут завершён\.<\/b> Доставлено: 2, не доставлено: 1/);
    assert.equal(lastCard().keyboard.flat().filter(b => b.callback_data).length, 0, 'у завершённого маршрута нет кнопок действий');

    // ===== Недоставленный заказ возвращается в работу: повторная отправка, отмена =====
    assert.equal(await db.updateOrderStatus(M.orders[0].id, 'READY_FOR_SHIPMENT'), true, 'недоставленный можно отправить повторно');
    assert.equal(await db.updateOrderStatus(M.orders[0].id, 'CANCELLED'), true, 'или отменить');
    assert.equal(await db.updateOrderStatus(M.orders[1].id, 'DELIVERY_FAILED'), 'TRANSITION_FORBIDDEN', 'доставленный в «не доставлен» не переводится');

    // ===== Причина «Другое»: ответное сообщение, без «следующего любого сообщения» =====
    const F = await mkMulti('cg_other', 'RL-CGOTHER', 59.96);
    await press(`startroute_${F.route.id}`);
    await press(`failreason_${F.route.id}_${F.stops[0].id}_other`);
    assert.match(lastCard().text, /Напишите причину/);
    assert.equal(await orderStatus(F.orders[0].id), 'SHIPPING', 'пока причина не написана, статус прежний');
    await handlers.message({ chat: { id: -100900002, type: 'supergroup' }, from: { id: 900002 }, text: 'групповая подмена' });
    assert.equal(await orderStatus(F.orders[0].id), 'SHIPPING', 'сообщение из группы не принимается как причина недоставки');
    await handlers.message({ chat: { id: 900002, type: 'private' }, from: { id: 900002 }, text: 'Домофон не работает' });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(await orderStatus(F.orders[0].id), 'DELIVERY_FAILED');
    assert.equal((await db.getRouteById(F.route.id)).stops[0].fail_reason, 'Домофон не работает');

    // Между выбором причины «Другое» и текстовым ответом маршрут может быть переназначен.
    // Отложенное сообщение прежнего курьера не должно менять чужую остановку.
    const reassigned = await mk('cg_other_reassigned');
    await press(`startroute_${reassigned.route.id}`);
    await press(`failreason_${reassigned.route.id}_${reassigned.stopId}_other`);
    await pool.query('UPDATE delivery_routes SET courier_id = $1 WHERE id = $2', [otherCourier.id, reassigned.route.id]);
    await handlers.message({ chat: { id: 900002, type: 'private' }, from: { id: 900002 }, text: 'подмена после переназначения' });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await orderStatus(reassigned.o.id), 'READY_FOR_SHIPMENT', 'старый курьер не меняет заказ после переназначения маршрута');
    assert.equal((await db.getRouteById(reassigned.route.id)).stops[0].status, 'pending', 'отложенный ответ не меняет состояние остановки');

    // Даже если маршрут остался назначен курьеру, его отключение до текстового ответа закрывает доступ.
    const disabled = await mk('cg_other_disabled');
    await press(`startroute_${disabled.route.id}`);
    await press(`failreason_${disabled.route.id}_${disabled.stopId}_other`);
    await pool.query('UPDATE couriers SET is_active = false WHERE id = $1', [courier.id]);
    await handlers.message({ chat: { id: 900002, type: 'private' }, from: { id: 900002 }, text: 'ответ после отключения' });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await orderStatus(disabled.o.id), 'READY_FOR_SHIPMENT', 'отключённый курьер не меняет статус через отложенный ответ');
    await pool.query('UPDATE couriers SET is_active = true WHERE id = $1', [courier.id]);

    await handlers.message({ chat: { id: 900002, type: 'private' }, from: { id: 900002 }, text: 'просто сообщение' });
    assert.equal(await orderStatus(F.orders[1].id), 'SHIPPING', 'посторонние сообщения заказы не трогают');
});
