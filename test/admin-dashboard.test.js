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
