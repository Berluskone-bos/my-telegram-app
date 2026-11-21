'use strict';
// Нужна база: TEST_DATABASE_URL. Замок опроса (только один экземпляр опрашивает Telegram) и поведение опроса при сбоях сети.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const { createPollLock, startGuardedPolling } = require('../bot/poll-guard');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 6000, what = 'условие') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
    assert.fail('не дождались: ' + what);
}
const quietLog = () => { const lines = []; return { lines, log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) }; };

test('замок опроса: второй экземпляр ждёт, после остановки первого — подхватывает', { skip }, async (t) => {
    const pool = new Pool({ connectionString: DB, max: 6 });
    t.after(() => pool.end());
    const ev = [];
    const l = quietLog();
    const mk = (id) => createPollLock({ pool, name: 'LOCKTEST', log: l, retryMs: 100, heartbeatMs: 200, onAcquire: () => ev.push(id + '+'), onLose: () => ev.push(id + '-') });
    const A = mk('A'), B = mk('B');
    A.start(); await until(() => A.isHolder(), 3000, 'A получил замок');
    B.start(); await sleep(600);
    assert.equal(B.isHolder(), false, 'B не получает замок, пока держит A');
    assert.deepEqual(ev, ['A+']);
    await A.stop();
    await until(() => B.isHolder(), 3000, 'B получил замок после остановки A');
    assert.deepEqual(ev, ['A+', 'B+']);
    await B.stop();
    assert.ok(l.lines.some(x => /уже ведёт другой экземпляр/.test(x)), 'ожидание записано в лог');
});

test('graceful shutdown удерживает advisory lock до завершения Telegram polling', { skip }, async (t) => {
    const pool = new Pool({ connectionString: DB, max: 6 });
    t.after(() => pool.end());
    const events = [];
    let finishA;
    const fakeBot = (id) => ({
        polling: false,
        getUpdates: async () => [],
        startPolling() { this.polling = true; events.push(id + ':start'); return Promise.resolve(); },
        isPolling() { return this.polling; },
        stopPolling() {
            events.push(id + ':stop-requested');
            this.polling = false;
            if (id === 'A') return new Promise(resolve => { finishA = () => { events.push('A:stopped'); resolve(); }; });
            events.push(id + ':stopped');
            return Promise.resolve();
        }
    });
    const A = startGuardedPolling(fakeBot('A'), { name: 'LOCKSTOPTEST', pool, log: quietLog(), retryMs: 100, heartbeatMs: 300 });
    await until(() => A.status().holder, 3000, 'A получил замок');
    const B = startGuardedPolling(fakeBot('B'), { name: 'LOCKSTOPTEST', pool, log: quietLog(), retryMs: 100, heartbeatMs: 300 });
    await sleep(250);
    assert.equal(B.status().holder, false, 'B ждёт, пока A держит замок');
    const stoppingA = A.stop();
    await until(() => typeof finishA === 'function', 2000, 'A начал останавливать polling');
    await sleep(250);
    assert.equal(B.status().holder, false, 'B не получает замок до фактической остановки polling A');
    finishA();
    await stoppingA;
    await until(() => B.status().holder, 3000, 'B получил замок после остановки A');
    assert.ok(events.indexOf('A:stopped') < events.indexOf('B:start'), 'сначала остановился polling A, затем стартовал B: ' + events.join(', '));
    await B.stop();
});
test('замок опроса: обрыв соединения с замком останавливает опрос, замок переходит другому', { skip }, async (t) => {
    const pool = new Pool({ connectionString: DB, max: 6 });
    t.after(() => pool.end());
    const ev = [];
    const l = quietLog();
    const mk = (id) => createPollLock({ pool, name: 'LOCKTEST2', log: l, retryMs: 100, heartbeatMs: 150, onAcquire: () => ev.push(id + '+'), onLose: () => ev.push(id + '-') });
    const A = mk('A'), B = mk('B');
    A.start(); await until(() => A.isHolder(), 3000, 'A получил замок');
    B.start(); await sleep(300);
    await pool.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()");
    await until(() => ev.includes('A-'), 4000, 'A узнал о потере замка');
    await until(() => B.isHolder(), 4000, 'B получил замок');
    assert.equal(A.isHolder(), false);
    assert.ok(ev.indexOf('A-') < ev.indexOf('B+'), 'сначала A перестал опрашивать, потом B начал: ' + ev.join(','));
    await A.stop(); await B.stop();
});

// Поддельный Telegram: сценарий ответов на getUpdates
function fakeTelegram(script) {
    const srv = http.createServer((req, res) => {
        if (!/getUpdates/.test(req.url)) { res.setHeader('content-type', 'application/json'); return res.end('{"ok":true,"result":{}}'); }
        const step = script.length ? script.shift() : 'ok';
        srv.hits++;
        if (step === 'reset') return req.socket.destroy();
        if (step === 'hang') return;  // никогда не отвечает
        res.setHeader('content-type', 'application/json');
        if (step === '409') { res.statusCode = 409; return res.end('{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request"}'); }
        setTimeout(() => res.end('{"ok":true,"result":[]}'), 100);
    });
    srv.hits = 0;
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('опрос Telegram: обрывы и 409 не останавливают опрос, в лог попадает одна запись и сообщение о восстановлении', { skip }, async (t) => {
    const pool = new Pool({ connectionString: DB, max: 4 });
    const srv = await fakeTelegram(['reset', 'reset', '409', '409', 'hang']);
    const bot = new TelegramBot('1:poll', { polling: false, baseApiUrl: `http://127.0.0.1:${srv.address().port}`, request: { timeout: 700 } });
    const l = quietLog();
    const g = startGuardedPolling(bot, { name: 'POLLTEST', pool, log: l, retryMs: 100, heartbeatMs: 500, logEveryMs: 60_000 });
    t.after(async () => { await g.stop(); srv.close(); srv.closeAllConnections && srv.closeAllConnections(); await pool.end(); });
    bot.on('polling_error', () => {});
    await until(() => g.status().okTotal >= 2 && g.status().errorsTotal >= 5, 10000, 'ошибки пройдены, опрос восстановлен');
    const st = g.status();
    assert.equal(st.holder, true);
    assert.equal(st.errorsInRow, 0, 'после восстановления ошибок подряд нет');
    assert.ok(st.lastOkAt);
    const errs = l.lines.filter(x => /ошибка опроса/.test(x));
    assert.equal(errs.length, 1, 'ошибки в логе не чаще раза в минуту: ' + JSON.stringify(l.lines));
    assert.ok(l.lines.some(x => /восстановлен после [1-9]/.test(x)), 'есть запись о восстановлении: ' + JSON.stringify(l.lines));
    assert.ok(l.lines.some(x => /замок получен/.test(x)));
});

test('опрос Telegram: 409 расшифровывается понятным текстом', { skip }, async (t) => {
    const pool = new Pool({ connectionString: DB, max: 4 });
    const srv = await fakeTelegram(['409', '409', '409']);
    const bot = new TelegramBot('1:poll', { polling: false, baseApiUrl: `http://127.0.0.1:${srv.address().port}`, request: { timeout: 700 } });
    const l = quietLog();
    const g = startGuardedPolling(bot, { name: 'POLLTEST409', pool, log: l, retryMs: 100, heartbeatMs: 500 });
    t.after(async () => { await g.stop(); srv.close(); srv.closeAllConnections && srv.closeAllConnections(); await pool.end(); });
    bot.on('polling_error', () => {});
    await until(() => l.lines.some(x => /ошибка опроса/.test(x)), 6000, 'запись об ошибке');
    assert.match(l.lines.find(x => /ошибка опроса/.test(x)), /409 Conflict.*другой экземпляр/);
});
