'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('./test-db').testDatabaseUrl();

test('сотрудники: индивидуальный вход, роли, отзыв сессий и защита последнего администратора', {
    skip: DB ? false : 'нет TEST_DATABASE_URL'
}, async t => {
    Object.assign(process.env, {
        DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x',
        WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y',
        ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y',
        ADMIN_API_KEY: 'test-admin-key-0123456789'
    });
    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const { createAdminAuth } = require('../bot/admin-auth');
    const { requirePermission, requireOrderStatusPermission } = require('../bot/admin-permissions');
    await initDB();
    await pool.query('DELETE FROM admin_sessions');
    await pool.query('DELETE FROM admin_audit');
    await pool.query('DELETE FROM admin_users');

    const auth = createAdminAuth({ pool, getKey: () => process.env.ADMIN_API_KEY, failDelayMs: 0 });
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    auth.registerRoutes(app);
    app.get('/api/test/customers', auth.verifyAdmin, requirePermission('customers.view'), (_req, res) => res.json({ ok: true }));
    app.put('/api/test/order-status', auth.verifyAdmin, requireOrderStatusPermission, (_req, res) => res.json({ ok: true }));
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    let raceServer = null;
    t.after(async () => { server.close(); if (raceServer) raceServer.close(); await pool.end(); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const origin = 'https://127.0.0.1:' + server.address().port;
    const call = (path, { method = 'GET', body, cookie, ip = '10.10.10.1' } = {}) => fetch(base + path, {
        method,
        headers: {
            'content-type': 'application/json', 'x-forwarded-proto': 'https',
            'x-forwarded-for': ip, origin,
            ...(cookie ? { cookie } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
    });
    const cookieOf = response => {
        const setCookie = response.headers.getSetCookie().find(v => v.startsWith('__Host-admin_session='));
        assert.ok(setCookie, 'сервер не выдал secure session cookie');
        return setCookie.split(';')[0];
    };
    const legacyLogin = async () => {
        const r = await call('/api/admin/login', { method: 'POST', body: { key: process.env.ADMIN_API_KEY } });
        assert.equal(r.status, 200);
        return cookieOf(r);
    };
    const create = (cookie, payload) => call('/api/admin/staff', { method: 'POST', cookie, body: payload });
    const adminCookie = await legacyLogin();

    // Старый администратор может безопасно создать первую индивидуальную учётную запись.
    const ownerCreate = await create(adminCookie, {
        login: 'owner.admin', displayName: 'Владелец', password: 'Owner-Password-2026!', role: 'admin'
    });
    assert.equal(ownerCreate.status, 201);
    const owner = await ownerCreate.json();
    assert.ok(owner.id);
    assert.equal((await pool.query('SELECT password_hash FROM admin_users WHERE id=$1', [owner.id])).rows[0].password_hash.includes('Owner-Password-2026!'), false);

    // Индивидуальная учётная запись продолжает работать независимо от старого ADMIN_API_KEY.
    const savedAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = '';
    const ownerLogin = await call('/api/admin/login', {
        method: 'POST', body: { login: 'owner.admin', password: 'Owner-Password-2026!' }, ip: '10.10.10.9'
    });
    assert.equal(ownerLogin.status, 200);
    const ownerCookie = cookieOf(ownerLogin);
    const ownerMe = await (await call('/api/admin/me', { cookie: ownerCookie })).json();
    assert.equal(ownerMe.role, 'admin');
    assert.equal(ownerMe.legacy, false);
    process.env.ADMIN_API_KEY = savedAdminKey;

    // Неизвестные роли (в том числе courier) нельзя записать.
    assert.equal((await create(adminCookie, {
        login: 'courier.one', displayName: 'Не добавлять', password: 'Courier-Password-2026!', role: 'courier'
    })).status, 400);

    const operatorCreate = await create(adminCookie, {
        login: 'operator.one', displayName: 'Оператор', password: 'Operator-Password-2026!', role: 'operator'
    });
    assert.equal(operatorCreate.status, 201);
    const operator = await operatorCreate.json();

    const loginOperator = await call('/api/admin/login', {
        method: 'POST', body: { login: 'OPERATOR.ONE', password: 'Operator-Password-2026!' }, ip: '10.10.10.2'
    });
    assert.equal(loginOperator.status, 200);
    const operatorCookie = cookieOf(loginOperator);
    const me = await (await call('/api/admin/me', { cookie: operatorCookie })).json();
    assert.equal(me.role, 'operator');
    assert.equal(me.legacy, false);
    assert.ok(me.permissions.includes('orders.process'));
    assert.equal(me.permissions.includes('customers.view'), false);
    assert.equal((await call('/api/admin/staff', { cookie: operatorCookie })).status, 403);
    assert.equal((await call('/api/test/customers', { cookie: operatorCookie })).status, 403);

    // Оператор запускает сборку; Кладовщик подтверждает готовность к отправке.
    const warehouseCreate = await create(adminCookie, {
        login: 'warehouse.one', displayName: 'Кладовщик', password: 'Warehouse-Password-2026!', role: 'warehouse'
    });
    assert.equal(warehouseCreate.status, 201);
    const warehouse = await warehouseCreate.json();
    const loginWarehouse = await call('/api/admin/login', {
        method: 'POST', body: { login: 'warehouse.one', password: 'Warehouse-Password-2026!' }, ip: '10.10.10.3'
    });
    const warehouseCookie = cookieOf(loginWarehouse);
    assert.equal((await call('/api/test/order-status', { method: 'PUT', cookie: operatorCookie, body: { status: 'ASSEMBLING' } })).status, 200);
    assert.equal((await call('/api/test/order-status', { method: 'PUT', cookie: warehouseCookie, body: { status: 'READY_FOR_SHIPMENT' } })).status, 200);
    assert.equal((await call('/api/test/order-status', { method: 'PUT', cookie: warehouseCookie, body: { status: 'CANCELLED' } })).status, 403);

    // Смена роли немедленно отзывает старую сессию; новая роль действует после повторного входа.
    const changed = await call('/api/admin/staff/' + operator.id, {
        method: 'PATCH', cookie: adminCookie, body: { role: 'manager' }
    });
    assert.equal(changed.status, 200);
    assert.equal((await call('/api/admin/me', { cookie: operatorCookie })).status, 401);
    const managerLogin = await call('/api/admin/login', {
        method: 'POST', body: { login: 'operator.one', password: 'Operator-Password-2026!' }, ip: '10.10.10.4'
    });
    const managerCookie = cookieOf(managerLogin);
    assert.equal((await call('/api/test/customers', { cookie: managerCookie })).status, 200);

    // Race: login has read the old hash, then password reset revokes sessions before login creates one.
    // The login-side proxy pauses exactly after the SELECT result, making the race deterministic.
    let releaseLoginQuery;
    let signalLoginQuery;
    const loginQueryPaused = new Promise(resolve => { signalLoginQuery = resolve; });
    const loginQueryRelease = new Promise(resolve => { releaseLoginQuery = resolve; });
    const loginPool = Object.create(pool);
    loginPool.query = async (sql, params) => {
        const result = await pool.query(sql, params);
        if (String(sql).includes('SELECT id, login, display_name, password_hash, role, is_active FROM admin_users') &&
            params && params[0] === 'operator.one') {
            signalLoginQuery();
            await loginQueryRelease;
        }
        return result;
    };
    loginPool.connect = (...args) => pool.connect(...args);
    const raceAuth = createAdminAuth({ pool: loginPool, getKey: () => process.env.ADMIN_API_KEY, failDelayMs: 0 });
    const raceApp = express(); raceApp.set('trust proxy', 1); raceApp.use(express.json()); raceAuth.registerRoutes(raceApp);
    raceServer = await new Promise(resolve => { const srv = raceApp.listen(0, '127.0.0.1', () => resolve(srv)); });
    const raceBase = 'http://127.0.0.1:' + raceServer.address().port;
    const staleLoginPromise = fetch(raceBase + '/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.10.10.5', origin },
        body: JSON.stringify({ login: 'operator.one', password: 'Operator-Password-2026!' }),
        redirect: 'manual'
    });
    await loginQueryPaused;
    const resetPassword = await call('/api/admin/staff/' + operator.id + '/password', {
        method: 'POST', cookie: adminCookie, body: { password: 'New-Operator-Password-2026!' }
    });
    assert.equal(resetPassword.status, 200);
    releaseLoginQuery();
    const staleLogin = await staleLoginPromise;
    assert.equal(staleLogin.status, 401, 'login verified against a stale password hash must be rejected');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM admin_sessions WHERE staff_user_id = $1', [operator.id])).rows[0].n, 0,
        'no session may be inserted after the reset transaction revoked existing sessions');
    assert.equal((await call('/api/admin/me', { cookie: managerCookie })).status, 401);
    assert.equal((await call('/api/admin/login', {
        method: 'POST', body: { login: 'operator.one', password: 'Operator-Password-2026!' }, ip: '10.10.10.6'
    })).status, 401);

    // Последнего активного администратора отключить нельзя.
    const lastAdmin = await call('/api/admin/staff/' + owner.id, {
        method: 'PATCH', cookie: adminCookie, body: { isActive: false }
    });
    assert.equal(lastAdmin.status, 409);

    // Отключение сотрудника отзывает его сессии.
    const deactivated = await call('/api/admin/staff/' + warehouse.id, {
        method: 'PATCH', cookie: adminCookie, body: { isActive: false }
    });
    assert.equal(deactivated.status, 200);
    assert.equal((await call('/api/admin/me', { cookie: warehouseCookie })).status, 401);
    assert.equal((await call('/api/admin/login', {
        method: 'POST', body: { login: 'warehouse.one', password: 'Warehouse-Password-2026!' }, ip: '10.10.10.6'
    })).status, 401, 'отключённый сотрудник не может войти заново');

    const audit = (await pool.query('SELECT action, actor_role FROM admin_audit ORDER BY id')).rows;
    assert.ok(audit.some(row => row.action === 'staff_created' && row.actor_role === 'admin'));
    assert.ok(audit.some(row => row.action === 'staff_updated' && row.actor_role === 'admin'));
});
