'use strict';
// Нужна база: TEST_DATABASE_URL. Блок «Состояние системы» в админке: связь с базой, очередь уведомлений, опрос админ-бота.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('system-status: только после входа, показывает базу и очередь уведомлений', { skip }, async (t) => {
    Object.assign(process.env, {
        DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y',
        ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y', ADMIN_API_KEY: 'test-admin-key-0123456789', ADMIN_POLLING: 'off', OUTBOX_DISABLED: '1'
    });
    process.env.COURIER_BOT_TOKEN = '1:c';   // без токена курьерского бота маршруты не регистрируются (так устроен модуль)
    require('./fake-telegram-preload');       // вместо настоящего Telegram — заглушка
    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const db = require('../bot/db-adapter');
    await initDB();
    await pool.query('DELETE FROM admin_sessions');
    await pool.query('DELETE FROM notification_outbox');
    const { registerCourierRoutes } = require('../bot/courier-bot');
    const auth = require('../bot/admin-auth').instance();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    auth.registerRoutes(app);
    registerCourierRoutes(app);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    let rbacRouteId = null;
    let rbacCourierId = null;
    t.after(async () => {
        server.close();
        if (rbacRouteId) await pool.query('DELETE FROM delivery_routes WHERE id = $1', [rbacRouteId]);
        if (rbacCourierId) await pool.query('DELETE FROM couriers WHERE id = $1', [rbacCourierId]);
        await pool.query("DELETE FROM admin_sessions WHERE staff_user_id IN (SELECT id FROM admin_users WHERE login = 'rbac.operator')");
        await pool.query("DELETE FROM admin_users WHERE login = 'rbac.operator'");
        await pool.query('DELETE FROM notification_outbox');
        await pool.end();
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const H = { 'content-type': 'application/json', 'x-forwarded-proto': 'https' };
    const Hsame = { ...H, origin: base.replace(/^http:/, 'https:') };

    assert.equal((await fetch(base + '/api/admin/system-status', { headers: H })).status, 401, 'без входа — отказ');
    assert.equal((await fetch(base + '/api/admin/outbox/1/retry', { method: 'POST', headers: H })).status, 401, 'повтор failed без входа запрещён');

    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { ...H, 'x-forwarded-for': '9.9.9.7' }, body: JSON.stringify({ key: process.env.ADMIN_API_KEY }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find(c => c.startsWith('__Host-admin_session=')).split(';')[0];

    await pool.query(`INSERT INTO notification_outbox (bot, payload, status, sent_at) VALUES ('admin', '{}', 'sent', NOW())`);
    const failed = await pool.query(`INSERT INTO notification_outbox (bot, payload, status, last_error) VALUES ('admin', '{}', 'failed', 'chat not found') RETURNING id`);
    const failedId = Number(failed.rows[0].id);
    await pool.query(`INSERT INTO notification_outbox (bot, payload, status) VALUES ('admin', '{}', 'pending')`);

    const r = await fetch(base + '/api/admin/system-status', { headers: { ...H, cookie } });
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.equal(s.db.ok, true);
    assert.ok(s.db.pingMs >= 0);
    assert.equal(s.outbox.sent, 1);
    assert.equal(s.outbox.failed, 1);
    assert.equal(s.outbox.pending, 1);
    assert.equal(s.lastFailed.error, 'chat not found');
    assert.equal(s.lastFailed.id, String(failedId));
    assert.deepEqual(s.failedItems.map(x => x.id), [String(failedId)]);
    assert.equal(Object.prototype.hasOwnProperty.call(s.failedItems[0], 'payload'), false, 'содержимое уведомления с ПДн не выдаётся в статусе');
    assert.ok(s.lastAdminNotificationAt);
    assert.equal(s.adminPolling.enabled, false, 'опрос выключен переменной ADMIN_POLLING=off');

    const retry = await fetch(base + `/api/admin/outbox/${failedId}/retry`, { method: 'POST', headers: { ...Hsame, cookie }, body: '{}' });
    assert.equal(retry.status, 202, 'администратор может вернуть failed в очередь');
    assert.deepEqual(await retry.json(), { success: true, id: failedId, status: 'pending' });
    const recovered = await pool.query('SELECT status, attempts, last_error, locked_until FROM notification_outbox WHERE id = $1', [failedId]);
    assert.equal(recovered.rows[0].status, 'pending');
    assert.equal(recovered.rows[0].attempts, 0);
    assert.equal(recovered.rows[0].last_error, null);
    assert.equal(recovered.rows[0].locked_until, null);

    const duplicateRetry = await fetch(base + `/api/admin/outbox/${failedId}/retry`, { method: 'POST', headers: { ...Hsame, cookie }, body: '{}' });
    assert.equal(duplicateRetry.status, 409, 'нельзя повторно поставить уже pending');
    assert.equal((await fetch(base + '/api/admin/outbox/999999999/retry', { method: 'POST', headers: { ...Hsame, cookie }, body: '{}' })).status, 404);
    assert.equal((await fetch(base + '/api/admin/outbox/nope/retry', { method: 'POST', headers: { ...Hsame, cookie }, body: '{}' })).status, 400);
    assert.equal((await fetch(base + '/api/admin/outbox/1e3/retry', { method: 'POST', headers: { ...Hsame, cookie }, body: '{}' })).status, 400, 'ID не должен принимать scientific notation');

    const postAdminJson = (path, body) => fetch(base + path, {
        method: 'POST', headers: { ...Hsame, cookie }, body: JSON.stringify(body)
    });
    assert.equal((await postAdminJson('/api/routes/build', { courier_id: '1e3', order_ids: [1] })).status, 400,
        'ID курьера не принимает scientific notation');
    assert.equal((await postAdminJson('/api/routes/build', { courier_id: '1', order_ids: ['1e3'] })).status, 400,
        'ID заказа в маршруте должен быть десятичным');
    assert.equal((await postAdminJson('/api/map-links/route', { stops: {} })).status, 400,
        'API маршрутов навигации требует массив координат');
    assert.equal((await postAdminJson('/api/map-links/route', { stops: [{ lat: 999, lon: 0 }, { lat: 0, lon: 0 }] })).status, 400,
        'API маршрутов навигации отклоняет недопустимые координаты');
    assert.equal((await postAdminJson('/api/routes/1junk/optimize', {})).status, 400,
        'ID маршрута не принимает суффикс');
    const invalidStatusId = await fetch(base + '/api/orders/1junk/status', {
        method: 'PUT', headers: { ...Hsame, cookie }, body: JSON.stringify({ status: 'CONFIRMED' })
    });
    assert.equal(invalidStatusId.status, 400, 'ID заказа не принимает суффикс');


    // RBAC: оператору нужна статистика доставки, но денежные итоги маршрутов ему не положены.
    const staff = await fetch(base + '/api/admin/staff', {
        method: 'POST', headers: { ...Hsame, cookie }, body: JSON.stringify({
            login: 'rbac.operator', displayName: 'Оператор RBAC',
            password: 'Operator-Password-2026!', role: 'operator'
        })
    });
    assert.equal(staff.status, 201);
    const operatorLogin = await fetch(base + '/api/admin/login', {
        method: 'POST', headers: { ...Hsame, 'x-forwarded-for': '9.9.9.8' },
        body: JSON.stringify({ login: 'rbac.operator', password: 'Operator-Password-2026!' })
    });
    assert.equal(operatorLogin.status, 200);
    const operatorCookie = operatorLogin.headers.getSetCookie().find(c => c.startsWith('__Host-admin_session=')).split(';')[0];

    const statsDate = new Date().toISOString().slice(0, 10);
    const beforeAdminStats = await (await fetch(base + `/api/dispatch/stats?date=${statsDate}`, {
        headers: { ...H, cookie }
    })).json();

    const courier = await db.createCourier({
        name: 'RBAC test courier', phone: '+70000000000',
        telegram_id: 880000000 + (Date.now() % 1000000),
        telegram_user: 'rbac_test', vehicle_type: 'авто'
    });
    rbacCourierId = courier.id;
    const route = await db.createRoute({
        route_number: 'RBAC-' + Date.now().toString().slice(-10), route_date: statsDate,
        courier_id: courier.id, status: 'assigned', total_orders: 2,
        cash_to_collect: 1500, cash_collected: 500, stops: []
    });
    rbacRouteId = route.id;

    const adminDispatchStats = await (await fetch(base + `/api/dispatch/stats?date=${statsDate}`, {
        headers: { ...H, cookie }
    })).json();
    assert.equal(Number(adminDispatchStats.cash_to_collect) - Number(beforeAdminStats.cash_to_collect), 1500, 'администратор с sales.view видит денежные итоги маршрута');
    assert.equal(Number(adminDispatchStats.cash_collected) - Number(beforeAdminStats.cash_collected), 500);

    const operatorDispatchStatsResponse = await fetch(base + `/api/dispatch/stats?date=${statsDate}`, {
        headers: { ...H, cookie: operatorCookie }
    });
    assert.equal(operatorDispatchStatsResponse.status, 200, 'оператор может видеть операционную статистику маршрутов');
    const operatorDispatchStats = await operatorDispatchStatsResponse.json();
    assert.equal(Number(operatorDispatchStats.total_routes), Number(adminDispatchStats.total_routes));
    assert.equal(Number(operatorDispatchStats.delivered), Number(adminDispatchStats.delivered));
    assert.equal(operatorDispatchStats.cash_to_collect, null, 'оператору не раскрывается сумма к сбору');
    assert.equal(operatorDispatchStats.cash_collected, null, 'оператору не раскрывается собранная сумма');

    // Strict decimal IDs: Number() alone also accepts scientific and hexadecimal notation.
    for (const invalidId of ['1e3', '0x10']) {
        assert.equal((await fetch(base + '/api/orders/' + invalidId, { headers: { ...H, cookie } })).status, 400,
            'GET заказа отклоняет не десятичный ID: ' + invalidId);
        assert.equal((await fetch(base + '/api/orders/' + invalidId + '/assign', {
            method: 'POST', headers: { ...Hsame, cookie }, body: JSON.stringify({ courier_id: '1' })
        })).status, 400, 'назначение отклоняет не десятичный ID заказа: ' + invalidId);
        assert.equal((await fetch(base + '/api/products/' + invalidId + '/stock', {
            method: 'PATCH', headers: { ...Hsame, cookie }, body: JSON.stringify({ stock: 1, expected_stock: 0 })
        })).status, 400, 'изменение остатков отклоняет не десятичный ID: ' + invalidId);
        assert.equal((await fetch(base + '/api/products/' + invalidId, {
            method: 'PUT', headers: { ...Hsame, cookie }, body: JSON.stringify({ name: 'invalid' })
        })).status, 400, 'редактирование товара отклоняет не десятичный ID: ' + invalidId);
        for (const suffix of ['/password', '/revoke-sessions']) {
            const body = suffix === '/password' ? { password: 'New-Password-2026!' } : {};
            assert.equal((await fetch(base + '/api/admin/staff/' + invalidId + suffix, {
                method: 'POST', headers: { ...Hsame, cookie }, body: JSON.stringify(body)
            })).status, 400, 'операция сотрудника отклоняет не десятичный ID: ' + invalidId + suffix);
        }
        assert.equal((await fetch(base + '/api/admin/staff/' + invalidId, {
            method: 'PATCH', headers: { ...Hsame, cookie }, body: JSON.stringify({ displayName: 'invalid' })
        })).status, 400, 'изменение сотрудника отклоняет не десятичный ID: ' + invalidId);
    }
    assert.equal((await fetch(base + '/api/orders/1/assign', {
        method: 'POST', headers: { ...Hsame, cookie }, body: JSON.stringify({ courier_id: '1e3' })
    })).status, 400, 'назначение отклоняет scientific notation в ID курьера');

});
