'use strict';
// Нужна база: TEST_DATABASE_URL. Сохранность заказов: параллельные повторы, перезапуск сервера,
// обрыв связи с PostgreSQL посреди оформления. Настоящий bot.js (Telegram — заглушка) + TCP-прокси к базе,
// который по команде рвёт соединение в нужный момент.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';
const TOKEN = '1:reliab';
const UID = 777101;

function signedInitData(user) {
    const f = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH', user: JSON.stringify(user) };
    const check = Object.keys(f).sort().map(k => `${k}=${f[k]}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    f.hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams(f).toString();
}

// Прокси к базе: rules.* — одноразовые «ловушки»
function startProxy(target) {
    const t = new URL(target);
    const rules = { killBeforeInsert: false, dropAnswerAfterCommit: false, refuseConnections: false };
    const sockets = new Set();
    const srv = net.createServer((client) => {
        if (rules.refuseConnections) { client.destroy(); return; }
        const up = net.connect({ host: t.hostname, port: Number(t.port) || 5432 });
        sockets.add(client); sockets.add(up);
        let muted = false;
        const kill = () => { client.destroy(); up.destroy(); };
        client.on('error', () => {}); up.on('error', () => {});
        client.on('close', () => { sockets.delete(client); up.destroy(); });
        up.on('close', () => { sockets.delete(up); client.destroy(); });
        client.on('data', (buf) => {
            const s = buf.toString('latin1');
            if (rules.killBeforeInsert && s.includes('INSERT INTO orders')) { rules.killBeforeInsert = false; kill(); return; }
            if (rules.dropAnswerAfterCommit && s[0] === 'Q' && s.slice(5) === 'COMMIT\0') {
                rules.dropAnswerAfterCommit = false;
                muted = true;                       // сервер получит COMMIT и выполнит его, но клиент ответа не увидит
                up.write(buf);
                setTimeout(kill, 150);
                return;
            }
            up.write(buf);
        });
        up.on('data', (buf) => { if (!muted) client.write(buf); });
    });
    return new Promise(res => srv.listen(0, '127.0.0.1', () => res({
        port: srv.address().port, rules,
        killAll: () => { for (const s of sockets) s.destroy(); },
        close: () => { for (const s of sockets) s.destroy(); srv.close(); }
    })));
}

async function startServer(dbUrl) {
    const port = 4100 + Math.floor(Math.random() * 800);
    const child = spawn(process.execPath, ['-r', path.join(__dirname, 'fake-telegram-preload.js'), path.join(__dirname, '..', 'bot', 'bot.js')], {
        env: { ...process.env, PORT: String(port), DATABASE_URL: dbUrl, BOT_TOKEN: TOKEN, WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y',
               WEBHOOK_SECRET: 's'.repeat(32), ADMIN_CHAT_ID: '4242', OUTBOX_DISABLED: '1', NODE_ENV: 'test', PG_APP_NAME: 'gulf-bot-under-test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const srv = { port, child, log: '', exited: false };
    child.stdout.on('data', d => srv.log += d); child.stderr.on('data', d => srv.log += d);
    child.on('exit', () => { srv.exited = true; });
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).status < 500) return srv; } catch { /* ещё не запустился */ }
        await new Promise(r => setTimeout(r, 250));
    }
    child.kill();
    assert.fail('сервер не запустился:\n' + srv.log.slice(-1500));
}

function stopServer(srv) {
    return new Promise(res => { if (srv.exited) return res(); srv.child.once('exit', () => res()); srv.child.kill('SIGTERM'); setTimeout(() => { srv.child.kill('SIGKILL'); }, 8000).unref(); });
}

function body(pid, extra = {}) {
    return JSON.stringify({ items: [{ productId: pid, qty: 1 }], phone: '+79991112299', address: 'Санкт-Петербург, ул. Тестовая, д. 5',
        city: 'Санкт-Петербург', street: 'Тестовая', house: '5', zone: 'spb', deliveryType: 'delivery', payment: 'cash', ...extra });
}
function post(srv, pid, key, extra) {
    const headers = { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': signedInitData({ id: UID, first_name: 'Тест' }) };
    if (key) headers['Idempotency-Key'] = key;
    return fetch(`http://127.0.0.1:${srv.port}/api/order`, { method: 'POST', headers, body: body(pid, extra) });
}

let shared = null;
test.after(async () => { if (shared) await shared.end(); });

async function setup(t) {
    process.env.DATABASE_URL = DB;
    const { pool, initDB } = require('../bot/db');
    if (!shared) { await initDB(); shared = pool; }
    await pool.query('DELETE FROM notification_outbox');
    await pool.query('DELETE FROM orders WHERE user_id = $1', [UID]);
    const pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('REL-oil', 500, true, 1000) RETURNING id")).rows[0].id;
    t.after(async () => {
        await pool.query('DELETE FROM notification_outbox');
        await pool.query('DELETE FROM orders WHERE user_id = $1', [UID]);
        await pool.query('DELETE FROM products WHERE id = $1', [pid]);
    });
    return { pool, pid };
}
const count = async (pool) => Number((await pool.query('SELECT COUNT(*) AS c FROM orders WHERE user_id = $1', [UID])).rows[0].c);

test('двойная отправка одновременно (одинаковый ключ): один заказ, оба ответа успешны', { skip }, async (t) => {
    const { pool, pid } = await setup(t);
    const srv = await startServer(DB); t.after(() => stopServer(srv));
    const key = 'race-' + Date.now();
    const rs = await Promise.all(Array.from({ length: 6 }, () => post(srv, pid, key)));
    const js = await Promise.all(rs.map(r => r.json()));
    assert.deepEqual(rs.map(r => r.status), [200, 200, 200, 200, 200, 200], JSON.stringify(js) + srv.log.slice(-800));
    assert.equal(new Set(js.map(j => j.orderId)).size, 1, 'во всех ответах один номер заказа');
    assert.equal(await count(pool), 1, 'в базе ровно один заказ');
    const admin = (await pool.query("SELECT COUNT(*) AS c FROM notification_outbox WHERE bot = 'admin'")).rows[0].c;
    assert.equal(Number(admin), 1, 'админу ушло одно уведомление, а не шесть');
});

test('повтор после перезапуска сервера: заказ на месте, повтор с тем же ключом не создаёт второй', { skip }, async (t) => {
    const { pool, pid } = await setup(t);
    const key = 'restart-' + Date.now();
    let srv = await startServer(DB);
    const first = await (await post(srv, pid, key)).json();
    assert.equal(first.success, true);
    await stopServer(srv);
    assert.equal(await count(pool), 1, 'после остановки сервера заказ сохранён');
    srv = await startServer(DB); t.after(() => stopServer(srv));
    assert.equal(await count(pool), 1, 'после запуска нового сервера заказ сохранён');
    const again = await (await post(srv, pid, key)).json();     // «память» сервера пуста — работает только ключ в базе
    assert.equal(again.success, true); assert.equal(again.duplicate, true); assert.equal(again.orderId, first.orderId);
    assert.equal(await count(pool), 1);
});

test('обрыв связи с базой ДО записи заказа (через прокси)', { skip }, async (t) => {
    const { pool, pid } = await setup(t);
    const u = new URL(DB);
    const proxy = await startProxy(DB); t.after(() => proxy.close());
    u.host = `127.0.0.1:${proxy.port}`;
    const srv = await startServer(u.toString()); t.after(() => stopServer(srv));
    proxy.rules.killBeforeInsert = true;
    const r = await post(srv, pid, 'cut1-' + Date.now());
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j) + '\n' + srv.log.slice(-1200));
    assert.equal(j.success, true);
    assert.equal(await count(pool), 1, 'заказ создан ровно один раз');
    assert.equal(srv.exited, false, 'сервер не упал');
});

test('обрыв ПОСЛЕ COMMIT, ответ не дошёл (с ключом): повтор находит уже записанный заказ, дубля нет', { skip }, async (t) => {
    const { pool, pid } = await setup(t);
    const u = new URL(DB);
    const proxy = await startProxy(DB); t.after(() => proxy.close());
    u.host = `127.0.0.1:${proxy.port}`;
    const srv = await startServer(u.toString()); t.after(() => stopServer(srv));
    proxy.rules.dropAnswerAfterCommit = true;
    const r = await post(srv, pid, 'cut2-' + Date.now());
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j) + '\n' + srv.log.slice(-1200));
    assert.equal(j.success, true);
    assert.equal(await count(pool), 1, 'заказ один, хотя COMMIT выполнился дважды «в глазах» клиента');
    const admin = (await pool.query("SELECT COUNT(*) AS c FROM notification_outbox WHERE bot = 'admin'")).rows[0].c;
    assert.equal(Number(admin), 1);
});

test('обрыв ПОСЛЕ COMMIT без ключа: честный ответ «повторите» (503), клиент не получает ложного успеха', { skip }, async (t) => {
    const { pool, pid } = await setup(t);
    const u = new URL(DB);
    const proxy = await startProxy(DB); t.after(() => proxy.close());
    u.host = `127.0.0.1:${proxy.port}`;
    const srv = await startServer(u.toString()); t.after(() => stopServer(srv));
    proxy.rules.dropAnswerAfterCommit = true;
    const r = await post(srv, pid, null);
    const j = await r.json();
    assert.equal(r.status, 503, JSON.stringify(j));
    assert.equal(j.success, false);
    assert.equal(j.retry, true);
    assert.ok(await count(pool) <= 1, 'дубля нет');
});

test('база недоступна всё время: ответ 503 «повторите позже», сервер жив и после возврата базы принимает заказы', { skip }, async (t) => {
    const { pool, pid } = await setup(t);
    const u = new URL(DB);
    const proxy = await startProxy(DB); t.after(() => proxy.close());
    u.host = `127.0.0.1:${proxy.port}`;
    const srv = await startServer(u.toString()); t.after(() => stopServer(srv));
    proxy.killAll(); proxy.rules.refuseConnections = true;
    const r = await post(srv, pid, 'down-' + Date.now());
    const j = await r.json();
    assert.equal(r.status, 503, JSON.stringify(j));
    assert.equal(j.retry, true);
    assert.equal(await count(pool), 0, 'ничего не записано');
    proxy.rules.refuseConnections = false;
    const r2 = await post(srv, pid, 'down-' + Date.now());
    assert.equal(r2.status, 200, srv.log.slice(-1200));
    assert.equal(await count(pool), 1);
    assert.equal(srv.exited, false, 'сервер не падал');
});

test('перезапуск (SIGTERM): процесс завершается сам с кодом 0 и закрывает все соединения с базой', { skip }, async (t) => {
    const { pool, pid } = await setup(t);
    const srv = await startServer(DB);
    const r = await post(srv, pid, 'term-' + Date.now());
    assert.equal(r.status, 200);
    const conns = async () => Number((await pool.query("SELECT COUNT(*) AS c FROM pg_stat_activity WHERE application_name = 'gulf-bot-under-test'")).rows[0].c);
    assert.ok(await conns() > 0, 'до остановки сервер держит соединения');
    const code = await new Promise(res => { srv.child.once('exit', (c) => res(c)); srv.child.kill('SIGTERM'); });
    assert.equal(code, 0, srv.log.slice(-800));
    await new Promise(r2 => setTimeout(r2, 300));
    assert.equal(await conns(), 0, 'после остановки соединений с базой не осталось');
    assert.equal(await count(pool), 1, 'заказ сохранился после перезапуска');
});
