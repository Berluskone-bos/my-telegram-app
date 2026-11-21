'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('./test-db').testDatabaseUrl();

test('admin dashboard: sales totals and customer names are filtered by role', {
    skip: DB ? false : 'нет TEST_DATABASE_URL'
}, async t => {
    const tag = Date.now().toString();
    const orderNumber = 'RBAC-DASH-' + tag;
    const logins = ['admin', 'manager', 'operator', 'warehouse'].map(role => 'dashboard.rbac.' + role + '.' + tag.slice(-6));
    const password = 'Dashboard-RBAC-2026!';
    Object.assign(process.env, {
        DATABASE_URL: DB,
        WEBHOOK_SECRET: 's'.repeat(32),
        ADMIN_API_KEY: 'dashboard-test-key-0123456789'
    });

    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const db = require('../bot/db-adapter');
    const { createAdminAuth } = require('../bot/admin-auth');
    const { registerAdminDashboardRoutes } = require('../bot/admin-dashboard');
    await initDB();

    await pool.query('DELETE FROM admin_sessions WHERE staff_user_id IN (SELECT id FROM admin_users WHERE login LIKE $1)', ['dashboard.rbac.%']);
    await pool.query('DELETE FROM admin_users WHERE login LIKE $1', ['dashboard.rbac.%']);

    const auth = createAdminAuth({ pool, getKey: () => process.env.ADMIN_API_KEY, failDelayMs: 0 });
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    auth.registerRoutes(app);
    registerAdminDashboardRoutes(app, { pool, verifyAdmin: auth.verifyAdmin });
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    const H = { 'content-type': 'application/json', 'x-forwarded-proto': 'https' };
    const Hsame = { ...H, origin: base.replace(/^http:/, 'https:') };
    const cookieOf = response => {
        const value = response.headers.getSetCookie().find(item => item.startsWith('__Host-admin_session='));
        assert.ok(value, 'session cookie must be issued');
        return value.split(';')[0];
    };
    const call = (path, cookie) => fetch(base + path, { headers: { ...H, cookie } });

    let orderId = null;
    t.after(async () => {
        server.close();
        if (orderId) await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
        await pool.query('DELETE FROM admin_sessions WHERE staff_user_id IN (SELECT id FROM admin_users WHERE login LIKE $1)', ['dashboard.rbac.%']);
        await pool.query('DELETE FROM admin_users WHERE login LIKE $1', ['dashboard.rbac.%']);
        await pool.end();
    });

    const legacyLogin = await fetch(base + '/api/admin/login', {
        method: 'POST', headers: { ...H, 'x-forwarded-for': '10.50.0.1' },
        body: JSON.stringify({ key: process.env.ADMIN_API_KEY })
    });
    assert.equal(legacyLogin.status, 200);
    const adminCookie = cookieOf(legacyLogin);

    const roleCookies = { admin: adminCookie };
    for (const role of ['manager', 'operator', 'warehouse']) {
        const created = await fetch(base + '/api/admin/staff', {
            method: 'POST', headers: { ...Hsame, cookie: adminCookie },
            body: JSON.stringify({
                login: logins[['admin','manager','operator','warehouse'].indexOf(role)],
                displayName: 'RBAC ' + role, password, role
            })
        });
        assert.equal(created.status, 201, 'admin can create ' + role);
        const login = await fetch(base + '/api/admin/login', {
            method: 'POST', headers: { ...H, 'x-forwarded-for': '10.50.0.' + (2 + ['manager','operator','warehouse'].indexOf(role)) },
            body: JSON.stringify({ login: logins[['admin','manager','operator','warehouse'].indexOf(role)], password })
        });
        assert.equal(login.status, 200, role + ' can authenticate');
        roleCookies[role] = cookieOf(login);
    }

    const order = await db.createOrder({
        order_number: orderNumber,
        user_id: 990000000 + Number(tag.slice(-6)),
        user_name: 'RBAC Dashboard Customer',
        phone: '+79990001122',
        address: 'Санкт-Петербург, тестовый адрес',
        zone: 'spb', city: 'Санкт-Петербург', street: 'Тестовая', house: '1',
        comment: 'private dashboard comment',
        items: [], subtotal: 2450, total: 2450,
        idempotency_key: 'dashboard-rbac-' + tag,
        status: 'NEW'
    });
    orderId = order.id;
    const date = (await pool.query("SELECT (NOW() AT TIME ZONE 'Europe/Moscow')::date::text AS day")).rows[0].day;

    for (const role of ['admin', 'manager', 'operator', 'warehouse']) {
        const response = await call('/api/admin/dashboard?date=' + date, roleCookies[role]);
        assert.equal(response.status, 200, role + ' can view operational dashboard');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const payload = await response.json();
        const recent = payload.recentOrders.find(item => item.orderNumber === orderNumber);
        assert.ok(recent, 'test order appears in dashboard for ' + role);
        assert.equal(typeof payload.summary.orders, 'number');
        const salesAllowed = role === 'admin' || role === 'manager';
        const customersAllowed = role === 'admin' || role === 'manager';
        assert.equal(payload.summary.revenue !== null, salesAllowed, role + ' sales summary visibility');
        assert.equal(Object.prototype.hasOwnProperty.call(recent, 'total'), salesAllowed,
            role + ' must only receive per-order totals with sales.view');
        assert.equal(Object.prototype.hasOwnProperty.call(recent, 'customerName'), customersAllowed,
            role + ' must only receive customer names with customers.view');
    }
});
