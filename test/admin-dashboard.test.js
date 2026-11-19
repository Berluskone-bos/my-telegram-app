'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminDashboardRoutes, validDate } = require('../bot/admin-dashboard');

test('validDate accepts only real YYYY-MM-DD dates', () => {
    assert.equal(validDate('2026-11-19'), true);
    assert.equal(validDate('2026-02-29'), false);
    assert.equal(validDate('19.11.2026'), false);
    assert.equal(validDate('2026-1-09'), false);
});

test('dashboard route rejects malformed date before querying database', async () => {
    let handlers;
    const app = { get(path, ...fns) { assert.equal(path, '/api/admin/dashboard'); handlers = fns; } };
    const pool = { query() { throw new Error('database must not be queried'); } };
    registerAdminDashboardRoutes(app, { pool, verifyAdmin(req, _res, next) { req.admin = { role: 'admin' }; next(); } });

    let statusCode = 200;
    let body;
    const res = {
        status(code) { statusCode = code; return this; },
        json(value) { body = value; return this; }
    };
    const req = { query: { date: '2026-02-30' }, admin: null };
    await new Promise((resolve, reject) => handlers[0](req, res, err => err ? reject(err) : handlers[1](req, res, () => Promise.resolve(handlers[2](req, res)).then(resolve, reject))));
    assert.equal(statusCode, 400);
    assert.match(body.error, /YYYY-MM-DD/);
});

async function getDashboardForRole(role) {
    let handlers;
    const app = { get(path, ...fns) { assert.equal(path, '/api/admin/dashboard'); handlers = fns; } };
    const recentOrder = {
        id: 17,
        orderNumber: 'AP-123',
        customerName: 'Иван Петров',
        total: 2500,
        status: 'ASSEMBLING',
        deliveryType: 'delivery',
        createdAt: '2026-11-19T10:00:00'
    };
    const pool = {
        async query(sql) {
            if (sql.includes('COUNT(DISTINCT user_id)')) return { rows: [{ customers: 1 }] };
            if (sql.includes('SELECT o.id, o.order_number')) return { rows: [recentOrder] };
            if (sql.includes('SELECT id, brand')) return { rows: [] };
            if (sql.includes('COUNT(*) FILTER')) return { rows: [{ products: 2, lowStockCount: 0 }] };
            if (sql.includes('TO_CHAR(d.day')) {
                return { rows: [{
                    businessDate: '2026-11-19', orders: 1, newOrders: 0, activeOrders: 1,
                    revenue: 2500, cancelled: 0, delivered: 0, shipping: 0
                }] };
            }
            throw new Error('Unexpected dashboard query: ' + sql.slice(0, 80));
        }
    };
    registerAdminDashboardRoutes(app, {
        pool,
        verifyAdmin(req, _res, next) { req.admin = { role }; next(); }
    });

    let body;
    const res = {
        set() { return this; },
        status(code) { throw new Error('Unexpected HTTP status ' + code); },
        json(value) { body = value; return this; }
    };
    const req = { query: {}, admin: null };
    handlers[0](req, res, () => {});
    handlers[1](req, res, () => {});
    await handlers[2](req, res);
    return body;
}

for (const role of ['admin', 'manager']) {
    test('dashboard preserves customer names for ' + role + ' role with customers.view', async () => {
        const body = await getDashboardForRole(role);
        assert.equal(body.recentOrders[0].customerName, 'Иван Петров');
    });
}

for (const role of ['operator', 'warehouse']) {
    test('dashboard omits customer names for ' + role + ' role without customers.view', async () => {
        const body = await getDashboardForRole(role);
        assert.equal(Object.hasOwn(body.recentOrders[0], 'customerName'), false);
        assert.equal(body.recentOrders[0].orderNumber, 'AP-123');
    });
}
