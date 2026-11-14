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
    class FakeBot {
        on(ev, fn) { handlers[ev] = fn; }
        once() {}
        onText() {}
        getMe() { return Promise.resolve({ id: 1, username: 'x' }); }
        setMyCommands() { return Promise.resolve(true); }
        sendMessage(...a) { calls.push(['sendMessage', ...a]); return Promise.resolve({ message_id: 1 }); }
        answerCallbackQuery(...a) { calls.push(['answerCallbackQuery', ...a]); return Promise.resolve(true); }
        editMessageReplyMarkup(...a) { calls.push(['editMessageReplyMarkup', ...a]); return Promise.resolve(true); }
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
        const route = await db.createRoute({ route_number: 'RL-' + key.slice(-3), route_date: '2026-11-14', courier_id: courier.id, status: 'assigned', total_orders: 1,
            stops: [{ order_id: String(o.id), order_number: o.order_number, address: o.address, phone: '1', client_name: 'К', client_chat_id: o.user_id, amount_to_pay: 0, payment_status: 'paid', status: 'pending', comment: '' }] });
        await db.updateOrderStatus(o.id, 'SHIPPING');
        return { o, route, stopId: route.stops[0].id };
    };
    const press = async (data) => {
        calls.length = 0;
        await handlers.callback_query({ id: 'q1', data, from: { id: 900002, first_name: 'К' }, message: { chat: { id: 900002 }, message_id: 55, reply_markup: { inline_keyboard: [] } } });
        await new Promise(r => setTimeout(r, 150));
    };
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
    assert.equal((await pool.query('SELECT status FROM route_stops WHERE id = $1', [a.stopId])).rows[0].status, 'cancelled', 'остановка не перезаписана');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [a.o.id])).rows[0].status, 'CANCELLED');

    // контроль: обычный заказ принимается, клиент получает «Курьер в пути»
    const b = await mk('cg2');
    await press(`deliver_${b.route.id}_${b.stopId}_accept`);
    assert.ok(!calls.some(c => c[0] === 'answerCallbackQuery' && c[2] && c[2].show_alert), 'предупреждения нет');
    const texts = await clientTexts();
    assert.equal(texts.length, 1); assert.match(texts[0], /Курьер в пути/);
});
