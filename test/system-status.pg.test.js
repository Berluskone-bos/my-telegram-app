'use strict';
// Нужна база: TEST_DATABASE_URL. Блок «Состояние системы» в админке: связь с базой, очередь уведомлений, опрос админ-бота.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('system-status: только после входа, показывает базу и очередь уведомлений', { skip }, async (t) => {
    Object.assign(process.env, {
        DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y',
        ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y', ADMIN_API_KEY: 'test-admin-key-0123456789', ADMIN_POLLING: 'off'
    });
    process.env.COURIER_BOT_TOKEN = '1:c';   // без токена курьерского бота маршруты не регистрируются (так устроен модуль)
    require('./fake-telegram-preload');       // вместо настоящего Telegram — заглушка
    const express = require('express');
    const { pool, initDB } = require('../bot/db');
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
    t.after(async () => { server.close(); await pool.query('DELETE FROM notification_outbox'); await pool.end(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const H = { 'content-type': 'application/json', 'x-forwarded-proto': 'https' };

    assert.equal((await fetch(base + '/api/admin/system-status', { headers: H })).status, 401, 'без входа — отказ');

    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { ...H, 'x-forwarded-for': '9.9.9.7' }, body: JSON.stringify({ key: process.env.ADMIN_API_KEY }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find(c => c.startsWith('__Host-admin_session=')).split(';')[0];

    await pool.query(`INSERT INTO notification_outbox (bot, payload, status, sent_at) VALUES ('admin', '{}', 'sent', NOW())`);
    await pool.query(`INSERT INTO notification_outbox (bot, payload, status, last_error) VALUES ('admin', '{}', 'failed', 'chat not found')`);
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
    assert.ok(s.lastAdminNotificationAt);
    assert.equal(s.adminPolling.enabled, false, 'опрос выключен переменной ADMIN_POLLING=off');
});
