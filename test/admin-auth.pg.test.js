'use strict';
// Нужна база: TEST_DATABASE_URL=postgres://… npm test   (без переменной тест пропускается; в GitHub Actions база поднимается сама)
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('вход в админку: cookie, сессии, защита от подбора и CSRF, журнал', { skip }, async (t) => {
    Object.assign(process.env, {
        DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y',
        WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y', ADMIN_API_KEY: 'test-admin-key-0123456789'
    });
    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const { createAdminAuth } = require('../bot/admin-auth');
    await initDB();
    await pool.query('DELETE FROM admin_sessions'); await pool.query('DELETE FROM admin_audit');

    const KEY = process.env.ADMIN_API_KEY;
    let key = KEY;
    const auth = createAdminAuth({ pool, getKey: () => key, failDelayMs: 0, maxFails: 5, blockMs: 60_000 });
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    auth.registerRoutes(app);
    app.get('/api/secret', auth.verifyAdmin, (req, res) => res.json({ ok: true }));
    app.put('/api/secret/:id', auth.verifyAdmin, (req, res) => res.json({ ok: true, status: req.body.status }));
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    t.after(async () => { server.close(); await pool.end(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const HTTPS = { 'x-forwarded-proto': 'https' };
    const origin = `https://127.0.0.1:${server.address().port}`;
    const call = (path, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(base + path, {
        method, headers: { 'content-type': 'application/json', ...HTTPS, ...(cookie ? { cookie } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined, redirect: 'manual'
    });
    const login = async (k = KEY, ip = '9.9.9.1') => call('/api/admin/login', { method: 'POST', body: { key: k }, headers: { 'x-forwarded-for': ip } });

    // 1. без входа — 401, старый заголовок x-admin-key не работает
    assert.equal((await call('/api/secret')).status, 401);
    assert.equal((await call('/api/secret', { headers: { 'x-admin-key': KEY } })).status, 401);

    // 2. вход: cookie HttpOnly + Secure + SameSite=Strict + __Host-, токен в БД только в виде хэша
    const ok = await login();
    assert.equal(ok.status, 200);
    const sc = ok.headers.getSetCookie().find(c => c.startsWith('__Host-admin_session='));
    assert.ok(sc, 'нет cookie __Host-admin_session');
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(part), 'в cookie нет ' + part);
    assert.ok(!/Domain=/i.test(sc));
    const token = decodeURIComponent(sc.split(';')[0].split('=')[1]);
    const cookie = sc.split(';')[0];
    const rows = (await pool.query('SELECT token_hash FROM admin_sessions')).rows;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, token);
    assert.equal(rows[0].token_hash.length, 64);

    // 3. сессия работает; чтение без Origin можно, изменение — только с Origin этого же сайта
    assert.equal((await call('/api/secret', { cookie })).status, 200);
    assert.equal((await call('/api/admin/me', { cookie })).status, 200);
    assert.equal((await call('/api/secret/1', { method: 'PUT', cookie, body: { status: 'CANCELLED' } })).status, 403, 'без Origin');
    assert.equal((await call('/api/secret/1', { method: 'PUT', cookie, body: { status: 'X' }, headers: { origin: 'https://evil.example' } })).status, 403, 'чужой Origin');
    const put = await call('/api/secret/1', { method: 'PUT', cookie, body: { status: 'CANCELLED' }, headers: { origin } });
    assert.equal(put.status, 200);

    // 4. срок: просрочка по бездействию и по абсолютному сроку
    await pool.query("UPDATE admin_sessions SET last_seen = NOW() - INTERVAL '3 hours'");
    assert.equal((await call('/api/secret', { cookie })).status, 401, 'бездействие > 2 ч');
    await pool.query("UPDATE admin_sessions SET last_seen = NOW(), expires_at = NOW() - INTERVAL '1 minute'");
    assert.equal((await call('/api/secret', { cookie })).status, 401, 'срок сессии истёк');

    // 5. выход удаляет сессию
    const ok2 = await login(); const cookie2 = ok2.headers.getSetCookie().find(c => c.startsWith('__Host-admin_session=')).split(';')[0];
    assert.equal((await call('/api/secret', { cookie: cookie2 })).status, 200);
    assert.equal((await call('/api/admin/logout', { method: 'POST', cookie: cookie2, headers: { origin } })).status, 200);
    assert.equal((await call('/api/secret', { cookie: cookie2 })).status, 401);

    // 6. подбор: 5 неверных ключей — блок, даже верный ключ с этого IP не пускает; другой IP не затронут
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong-' + i, '7.7.7.7')).status, 401);
    const blocked = await login(KEY, '7.7.7.7');
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
    assert.equal((await login(KEY, '8.8.8.8')).status, 200);

    // 7. вход с чужого Origin отклоняется
    assert.equal((await call('/api/admin/login', { method: 'POST', body: { key: KEY }, headers: { origin: 'https://evil.example', 'x-forwarded-for': '6.6.6.6' } })).status, 403);

    // 8. ключ не задан — админка отключена
    key = '';
    assert.equal((await login()).status, 503);
    assert.equal((await call('/api/secret', { cookie })).status, 503);
    key = KEY;

    // 9. журнал: есть входы, ошибки, изменение, CSRF, выход; ключа и токенов в нём нет
    const audit = (await pool.query('SELECT * FROM admin_audit ORDER BY id')).rows;
    const actions = audit.map(a => a.action);
    for (const a of ['login_ok', 'login_fail', 'csrf_blocked', 'logout']) assert.ok(actions.includes(a), 'нет записи ' + a);
    const change = audit.find(a => a.action.startsWith('PUT '));
    assert.ok(change && change.detail === 'status=CANCELLED' && change.status === 200);
    const dump = JSON.stringify(audit);
    assert.ok(!dump.includes(KEY) && !dump.includes(token));

    // 10. страница /admin отдаётся сервером с жёстким CSP
    const page = await call('/admin');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
});
