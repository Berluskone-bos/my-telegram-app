'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('./test-db').testDatabaseUrl();

test('admin API: HTTP permission matrix for admin, manager, operator and warehouse', {
    skip: DB ? false : 'нет TEST_DATABASE_URL'
}, async t => {
    const tag = Date.now().toString();
    const prefix = 'rbac.matrix.' + tag.slice(-7) + '.';
    const password = 'RBAC-Matrix-Password-2026!';
    const roles = ['manager', 'operator', 'warehouse'];
    const logins = Object.fromEntries(roles.map(role => [role, prefix + role]));

    Object.assign(process.env, {
        DATABASE_URL: DB,
        WEBHOOK_SECRET: 's'.repeat(32),
        BOT_TOKEN: '1:x',
        WEB_APP_URL: 'https://x.y',
        WEBHOOK_URL: 'https://x.y',
        ADMIN_CHAT_ID: '1',
        ADMIN_BOT_TOKEN: '1:y',
        ADMIN_API_KEY: 'rbac-matrix-test-key-0123456789',
        ADMIN_POLLING: 'off',
        OUTBOX_DISABLED: '1',
        COURIER_BOT_TOKEN: '1:c'
    });
    require('./fake-telegram-preload');
    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const { createAdminAuth } = require('../bot/admin-auth');
    const { registerCourierRoutes } = require('../bot/courier-bot');
    await initDB();

    await pool.query('DELETE FROM admin_sessions WHERE staff_user_id IN (SELECT id FROM admin_users WHERE login LIKE $1)', [prefix + '%']);
    await pool.query('DELETE FROM admin_users WHERE login LIKE $1', [prefix + '%']);

    const auth = createAdminAuth({ pool, getKey: () => process.env.ADMIN_API_KEY, failDelayMs: 0 });
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    auth.registerRoutes(app);
    registerCourierRoutes(app);
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
    const request = (path, cookie, { method = 'GET', body } = {}) => fetch(base + path, {
        method,
        headers: { ...(method === 'GET' ? H : Hsame), cookie },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const roleCookies = {};

    t.after(async () => {
        server.close();
        await pool.query('DELETE FROM admin_sessions WHERE staff_user_id IN (SELECT id FROM admin_users WHERE login LIKE $1)', [prefix + '%']);
        await pool.query('DELETE FROM admin_users WHERE login LIKE $1', [prefix + '%']);
        await pool.end();
    });

    const legacy = await fetch(base + '/api/admin/login', {
        method: 'POST',
        headers: { ...H, 'x-forwarded-for': '10.61.0.1' },
        body: JSON.stringify({ key: process.env.ADMIN_API_KEY })
    });
    assert.equal(legacy.status, 200);
    roleCookies.admin = cookieOf(legacy);

    for (let i = 0; i < roles.length; i++) {
        const role = roles[i];
        const created = await request('/api/admin/staff', roleCookies.admin, {
            method: 'POST',
            body: { login: logins[role], displayName: 'RBAC ' + role, password, role }
        });
        assert.equal(created.status, 201, 'admin creates ' + role);
        const loggedIn = await fetch(base + '/api/admin/login', {
            method: 'POST',
            headers: { ...H, 'x-forwarded-for': '10.61.0.' + (i + 2) },
            body: JSON.stringify({ login: logins[role], password })
        });
        assert.equal(loggedIn.status, 200, role + ' authenticates');
        roleCookies[role] = cookieOf(loggedIn);
    }

    const getCases = [
        ['/api/orders', ['admin', 'manager', 'operator', 'warehouse']],
        ['/api/orders/customers', ['admin', 'manager']],
        ['/api/routes', ['admin', 'operator']],
        ['/api/couriers', ['admin', 'operator']],
        ['/api/dispatch/stats', ['admin', 'operator']],
        ['/api/dispatch/unassigned-orders', ['admin']],
        ['/api/analytics', ['admin']],
        ['/api/admin/system-status', ['admin']],
        ['/api/admin/audit', ['admin']],
        ['/api/admin/staff', ['admin']],
        ['/api/products', ['admin', 'warehouse']]
    ];
    for (const [path, allowed] of getCases) {
        for (const role of ['admin', ...roles]) {
            const response = await request(path, roleCookies[role]);
            assert.equal(response.status, allowed.includes(role) ? 200 : 403,
                role + ' access to ' + path);
        }
    }

    const mutationCases = [
        {
            name: 'route build', path: '/api/routes/build', method: 'POST', body: {},
            allowed: ['admin', 'operator'], allowedStatuses: [400]
        },
        {
            name: 'map route', path: '/api/map-links/route', method: 'POST', body: { stops: {} },
            allowed: ['admin', 'operator'], allowedStatuses: [400]
        },
        {
            name: 'single order assignment', path: '/api/orders/999999999/assign', method: 'POST', body: { courier_id: '999999999' },
            allowed: ['admin', 'operator'], allowedStatuses: [404, 400]
        },
        {
            name: 'order process status', path: '/api/orders/999999999/status', method: 'PUT', body: { status: 'ASSEMBLING' },
            allowed: ['admin', 'manager', 'operator'], allowedStatuses: [404]
        },
        {
            name: 'warehouse fulfillment status', path: '/api/orders/999999999/status', method: 'PUT', body: { status: 'READY_FOR_SHIPMENT' },
            allowed: ['admin', 'warehouse'], allowedStatuses: [404]
        },
        {
            name: 'stock update', path: '/api/products/999999999/stock', method: 'PATCH', body: { stock: 1, expected_stock: 0 },
            allowed: ['admin', 'warehouse'], allowedStatuses: [404]
        },
        {
            name: 'product update', path: '/api/products/999999999', method: 'PUT', body: { name: 'RBAC test' },
            allowed: ['admin'], allowedStatuses: [404]
        },
        {
            name: 'product creation', path: '/api/products', method: 'POST', body: {},
            allowed: ['admin'], allowedStatuses: [400]
        },
        {
            name: 'outbox retry', path: '/api/admin/outbox/999999999/retry', method: 'POST', body: {},
            allowed: ['admin'], allowedStatuses: [404]
        },
        {
            name: 'route optimization', path: '/api/routes/999999999/optimize', method: 'POST', body: {},
            allowed: ['admin'], allowedStatuses: [404]
        }
    ];
    for (const item of mutationCases) {
        for (const role of ['admin', ...roles]) {
            const response = await request(item.path, roleCookies[role], { method: item.method, body: item.body });
            if (!item.allowed.includes(role)) {
                assert.equal(response.status, 403, role + ' forbidden: ' + item.name);
            } else {
                assert.ok(item.allowedStatuses.includes(response.status),
                    role + ' authorized request reaches handler: ' + item.name + ' returned ' + response.status);
            }
        }
    }

    // Courier-only final delivery states must not be writable through the staff order-status API.
    for (const role of ['admin', 'manager', 'operator', 'warehouse']) {
        const response = await request('/api/orders/999999999/status', roleCookies[role], {
            method: 'PUT', body: { status: 'DELIVERED' }
        });
        assert.equal(response.status, 403, role + ' cannot mark delivery complete from admin order API');
    }
});
