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
    let testCourierId = null, testRouteId = null, testOrderId = null, testProductId = null;

    t.after(async () => {
        server.close();
        if (testRouteId) {
            await pool.query('DELETE FROM route_stops WHERE route_id = $1', [testRouteId]);
            await pool.query('DELETE FROM delivery_routes WHERE id = $1', [testRouteId]);
        }
        if (testOrderId) await pool.query('DELETE FROM orders WHERE id = $1', [testOrderId]);
        if (testProductId) { await pool.query('DELETE FROM product_approvals WHERE product_id = $1', [testProductId]); await pool.query('DELETE FROM products WHERE id = $1', [testProductId]); }
        if (testCourierId) await pool.query('DELETE FROM couriers WHERE id = $1', [testCourierId]);
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
    const staffIds = {};
    for (const role of roles) {
        const row = await pool.query('SELECT id FROM admin_users WHERE login = $1', [logins[role]]);
        assert.equal(row.rowCount, 1);
        staffIds[role] = Number(row.rows[0].id);
    }

    const productInsert = await pool.query(
        "INSERT INTO products (name, price, active, stock) VALUES ($1, 100, true, 10) RETURNING id",
        ['RBAC approvals ' + tag]);
    testProductId = Number(productInsert.rows[0].id);

    // Courier access is managed from the admin panel, and archive never deletes history.
    const courierInsert = await pool.query(
        `INSERT INTO couriers (name, phone, telegram_id, telegram_user, vehicle_type, is_active)
         VALUES ($1, $2, $3, $4, 'легковая', false) RETURNING id`,
        ['RBAC courier ' + tag, '70000000000', 900000000 + Number(tag.slice(-6)), 'rbac_' + tag.slice(-6)]);
    testCourierId = courierInsert.rows[0].id;
    const courierList = await request('/api/admin/couriers', roleCookies.admin);
    assert.equal(courierList.status, 200);
    assert.ok((await courierList.json()).some(c => Number(c.id) === Number(testCourierId)));
    const activated = await request('/api/admin/couriers/' + testCourierId, roleCookies.admin, {
        method: 'PATCH', body: { is_active: true }
    });
    assert.equal(activated.status, 200, 'admin can activate a courier');
    const routeInsert = await pool.query(
        `INSERT INTO delivery_routes (route_number, route_date, courier_id, status, total_orders)
         VALUES ($1, CURRENT_DATE, $2, 'assigned', 1) RETURNING id`,
        ['RB' + tag.slice(-10), testCourierId]);
    testRouteId = routeInsert.rows[0].id;
    const orderInsert = await pool.query(
        `INSERT INTO orders (order_number, user_name, status, delivery_type)
         VALUES ($1, 'RBAC test', 'SHIPPING', 'delivery') RETURNING id`,
        ['RBAC-TEST-' + tag.slice(-8)]);
    testOrderId = orderInsert.rows[0].id;
    await pool.query(
        `INSERT INTO route_stops (route_id, order_id, order_number, stop_number, address, status)
         VALUES ($1, $2, $3, 1, 'Тестовый адрес', 'pending')`, [testRouteId, String(testOrderId), 'RBAC-TEST-' + tag.slice(-8)]);
    const blockedDeactivate = await request('/api/admin/couriers/' + testCourierId, roleCookies.admin, {
        method: 'PATCH', body: { is_active: false }
    });
    assert.equal(blockedDeactivate.status, 409, 'cannot deactivate a courier with an unfinished delivery');
    const blockedArchive = await request('/api/admin/couriers/' + testCourierId, roleCookies.admin, { method: 'DELETE' });
    assert.equal(blockedArchive.status, 409, 'cannot archive a courier with an unfinished delivery');
    await pool.query("UPDATE orders SET status = 'COMPLETED' WHERE id = $1", [testOrderId]);
    // A stale pending route stop must not block archiving when its order is already completed.
    const deactivated = await request('/api/admin/couriers/' + testCourierId, roleCookies.admin, {
        method: 'PATCH', body: { is_active: false }
    });
    assert.equal(deactivated.status, 200, 'admin can deactivate a courier after active deliveries finish');
    const archived = await request('/api/admin/couriers/' + testCourierId, roleCookies.admin, { method: 'DELETE' });
    assert.equal(archived.status, 200, 'admin can archive a courier after route completion');
    const archivedRow = await pool.query('SELECT is_active, archived_at FROM couriers WHERE id = $1', [testCourierId]);
    assert.equal(archivedRow.rows[0].is_active, false);
    assert.ok(archivedRow.rows[0].archived_at, 'archive timestamp is saved without deleting courier history');
    const cannotReactivate = await request('/api/admin/couriers/' + testCourierId, roleCookies.admin, {
        method: 'PATCH', body: { is_active: true }
    });
    assert.equal(cannotReactivate.status, 404, 'archived courier cannot be reactivated');

    // CSRF: unsafe admin requests require the exact same origin, including a present Origin header.
    const foreignOrigin = await fetch(base + '/api/admin/staff', {
        method: 'POST',
        headers: { ...Hsame, origin: 'https://attacker.example', cookie: roleCookies.admin },
        body: JSON.stringify({ login: prefix + 'csrf.foreign', displayName: 'CSRF', password, role: 'manager' })
    });
    assert.equal(foreignOrigin.status, 403, 'admin session cannot be used from a foreign origin');
    const missingOrigin = await fetch(base + '/api/admin/staff', {
        method: 'POST',
        headers: { ...H, cookie: roleCookies.admin },
        body: JSON.stringify({ login: prefix + 'csrf.missing', displayName: 'CSRF', password, role: 'manager' })
    });
    assert.equal(missingOrigin.status, 403, 'unsafe admin request without Origin is rejected');

    const getCases = [
        ['/api/orders', ['admin', 'manager', 'operator', 'warehouse']],
        ['/api/orders/customers', ['admin', 'manager']],
        ['/api/routes', ['admin', 'operator']],
        ['/api/couriers', ['admin', 'operator']],
        ['/api/dispatch/stats', ['admin', 'operator']],
        ['/api/dispatch/unassigned-orders', ['admin']],
        // Sales analytics contain revenue/payment metrics: only roles with sales.view may access them.
        ['/api/orders/stats?from=2026-11-01&to=2026-11-22', ['admin', 'manager']],
        ['/api/orders/kpi', ['admin', 'manager']],
        ['/api/analytics/shop?from=2026-11-01&to=2026-11-22', ['admin', 'manager']],
        ['/api/analytics', ['admin']],
        ['/api/admin/system-status', ['admin']],
        ['/api/admin/audit', ['admin']],
        ['/api/admin/staff', ['admin']],
        ['/api/admin/couriers', ['admin']],
        ['/api/products', ['admin', 'warehouse']],
        ['/api/products/' + testProductId + '/approvals', ['admin']]
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
            name: 'product approvals replacement', path: '/api/products/' + testProductId + '/approvals', method: 'PUT',
            body: { approvals: ['API SP', 'ACEA C3'] }, allowed: ['admin'], allowedStatuses: [200]
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
            name: 'courier activation', path: '/api/admin/couriers/999999999', method: 'PATCH', body: { is_active: true },
            allowed: ['admin'], allowedStatuses: [404]
        },
        {
            name: 'courier archive', path: '/api/admin/couriers/999999999', method: 'DELETE', body: {},
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

    const savedApprovals = await pool.query('SELECT approval FROM product_approvals WHERE product_id = $1 ORDER BY approval', [testProductId]);
    assert.deepEqual(savedApprovals.rows.map(row => row.approval), ['ACEA C3', 'API SP'],
        'manager/operator/warehouse 403 responses must not mutate approvals on a real product');
    assert.equal((await request('/api/products/999999999/approvals', roleCookies.admin)).status, 404,
        'GET approvals for a nonexistent product returns 404');
    const missingApprovalsWrite = await request('/api/products/999999999/approvals', roleCookies.admin, {
        method: 'PUT', body: { approvals: [] }
    });
    assert.equal(missingApprovalsWrite.status, 404, 'empty replacement cannot report success for a nonexistent product');

    for (const malformedId of ['1e2', '0x10', '+10', ' 10']) {
        const response = await request('/api/products/' + encodeURIComponent(malformedId) + '/approvals', roleCookies.admin);
        assert.equal(response.status, 400, 'non-decimal product ID is rejected: ' + JSON.stringify(malformedId));
    }

    // Staff object IDs are protected by the staff.manage permission, not just by using a missing ID.
    const targetStaffId = staffIds.manager;
    const staffMutationAttempts = [
        { path: '/api/admin/staff/' + targetStaffId, method: 'PATCH', body: { displayName: 'forbidden edit' } },
        { path: '/api/admin/staff/' + targetStaffId + '/password', method: 'POST', body: { password: 'Unauthorized-Password-2026!' } },
        { path: '/api/admin/staff/' + targetStaffId + '/revoke-sessions', method: 'POST', body: {} }
    ];
    for (const role of roles) {
        for (const attempt of staffMutationAttempts) {
            const response = await request(attempt.path, roleCookies[role], { method: attempt.method, body: attempt.body });
            assert.equal(response.status, 403, role + ' cannot mutate staff object ' + targetStaffId + ' via ' + attempt.path);
        }
    }
    const untouchedStaff = await pool.query('SELECT display_name FROM admin_users WHERE id = $1', [targetStaffId]);
    assert.equal(untouchedStaff.rows[0].display_name, 'RBAC manager');

    // Admin password reset and session revocation must commit atomically.
    const reset = await request('/api/admin/staff/' + targetStaffId + '/password', roleCookies.admin, {
        method: 'POST', body: { password: 'Reset-Password-2026-Strong!' }
    });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).sessionsRevoked, true);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM admin_sessions WHERE staff_user_id = $1', [targetStaffId])).rows[0].n, 0);
    assert.equal((await request('/api/orders', roleCookies.manager)).status, 401, 'password reset revokes existing manager session');

    const adminOnlyAfterReset = await request('/api/admin/staff', roleCookies.admin);
    assert.equal(adminOnlyAfterReset.status, 200, 'admin session remains valid after resetting another staff member');

    // Courier-only final delivery states must not be writable through the staff order-status API.
    for (const role of ['admin', 'manager', 'operator', 'warehouse']) {
        const response = await request('/api/orders/999999999/status', roleCookies[role], {
            method: 'PUT', body: { status: 'DELIVERED' }
        });
        assert.equal(response.status, role === 'manager' ? 401 : 403,
            role + ' cannot mark delivery complete from admin order API');
    }
});
