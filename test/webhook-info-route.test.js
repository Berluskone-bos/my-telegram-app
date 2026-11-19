'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerWebhookInfoRoute } = require('../bot/webhook-info-route');

test('webhook-info requires an authenticated administrator session', async () => {
    let routeHandlers;
    let calls = 0;
    const app = { get(path, ...handlers) {
        assert.equal(path, '/api/webhook-info');
        routeHandlers = handlers;
    }};
    const bot = { async getWebHookInfo() { calls++; return { url: 'https://example.invalid/webhook' }; } };
    const rateLimit = (max, windowMs) => {
        assert.equal(max, 5);
        assert.equal(windowMs, 60000);
        return (_req, _res, next) => next();
    };
    const verifyAdmin = (req, _res, next) => {
        req.admin = { role: req.role };
        next();
    };
    registerWebhookInfoRoute(app, { bot, rateLimit, verifyAdmin });

    async function request(role) {
        let statusCode = 200;
        let body;
        let finish;
        const completed = new Promise(resolve => { finish = resolve; });
        const req = { role, admin: null };
        const res = {
            status(code) { statusCode = code; return this; },
            json(value) { body = value; finish(); return this; }
        };
        const run = (index) => {
            if (index >= routeHandlers.length) return;
            const handler = routeHandlers[index];
            if (index === routeHandlers.length - 1) {
                Promise.resolve(handler(req, res)).then(finish, finish);
            } else {
                handler(req, res, () => run(index + 1));
            }
        };
        run(0);
        await completed;
        return { statusCode, body };
    }

    const manager = await request('manager');
    assert.equal(manager.statusCode, 403);
    assert.equal(calls, 0, 'unauthorized request must not call Telegram API');

    const admin = await request('admin');
    assert.equal(admin.statusCode, 200);
    assert.deepEqual(admin.body, { url: 'https://example.invalid/webhook' });
    assert.equal(calls, 1);
});

test('webhook-info hides Telegram API errors behind sanitized server response', async () => {
    let handlers;
    const app = { get(_path, ...registered) { handlers = registered; } };
    const rateLimit = () => (_req, _res, next) => next();
    const verifyAdmin = (req, _res, next) => { req.admin = { role: 'admin' }; next(); };
    registerWebhookInfoRoute(app, {
        app, rateLimit, verifyAdmin,
        bot: { async getWebHookInfo() { throw new Error('secret-token-leak'); } },
        sanitizeLog: () => 'Telegram API error'
    });
    let statusCode = 200;
    let body;
    const req = { admin: null };
    const res = {
        status(code) { statusCode = code; return this; },
        json(value) { body = value; return this; }
    };
    await new Promise(resolve => {
        const invoke = i => i === handlers.length - 1
            ? Promise.resolve(handlers[i](req, res)).then(resolve)
            : handlers[i](req, res, () => invoke(i + 1));
        invoke(0);
    });
    assert.equal(statusCode, 500);
    assert.deepEqual(body, { error: 'Telegram API error' });
    assert.equal(JSON.stringify(body).includes('secret-token-leak'), false);
});
