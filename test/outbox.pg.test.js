'use strict';
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js). Без неё тест пропускается.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

function env() {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
}

test('классификация ошибок Telegram и паузы между повторами (без базы)', () => {
    const { classifyError, retryDelaySec, MAX_ATTEMPTS } = require('../bot/outbox');
    assert.equal(classifyError(Object.assign(new Error('Forbidden: bot was blocked by the user'), { tgCode: 403 })).kind, 'permanent');
    assert.equal(classifyError(Object.assign(new Error('Bad Request: chat not found'), { tgCode: 400 })).kind, 'permanent');
    assert.equal(classifyError(Object.assign(new Error('Bad Request: message is not modified'), { tgCode: 400 })).kind, 'done');
    assert.deepEqual(classifyError(Object.assign(new Error('Too Many Requests'), { tgCode: 429, retryAfter: 7 })), { kind: 'retry', afterSec: 8 });
    assert.equal(classifyError(new Error('timeout')).kind, 'retry');
    assert.equal(classifyError(Object.assign(new Error('Bad Gateway'), { tgCode: 502 })).kind, 'retry');
    assert.deepEqual([1, 2, 3, 4].map(retryDelaySec), [30, 120, 600, 3600]);
    assert.ok(retryDelaySec(99) >= 3600 && MAX_ATTEMPTS === 8);
});

test('очередь: отправка, повтор после сбоя, дедупликация, зависимость, окончательный отказ', { skip }, async (t) => {
    env();
    const { pool, initDB } = require('../bot/db');
    const { createOutbox } = require('../bot/outbox');
    await initDB();
    await pool.query('DELETE FROM notification_outbox');
    t.after(async () => { await pool.query('DELETE FROM notification_outbox'); });

    let mode = 'ok'; const calls = [];
    const q = createOutbox({ pool, send: async (bot, method, payload) => {
        calls.push({ bot, method, payload });
        if (mode === 'fail') throw Object.assign(new Error('Bad Gateway'), { tgCode: 502 });
        if (mode === 'blocked') throw Object.assign(new Error('Forbidden: bot was blocked by the user'), { tgCode: 403 });
        if (mode === 'limit') throw Object.assign(new Error('Too Many Requests'), { tgCode: 429, retryAfter: 40 });
        return { message_id: 100 + calls.length };
    } });
    const row = async (id) => (await pool.query('SELECT * FROM notification_outbox WHERE id = $1', [id])).rows[0];
    const due = (id) => pool.query("UPDATE notification_outbox SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1", [id]);

    // успех
    const a = await q.enqueue({ bot: 'client', dedupKey: 'k-a', payload: { chat_id: '5', text: 'привет' } });
    assert.equal(await q.enqueue({ bot: 'client', dedupKey: 'k-a', payload: { chat_id: '5', text: 'повтор' } }), null, 'тот же ключ второй раз не ставится');
    assert.deepEqual(await q.processOnce(), { sent: 1, failed: 0, retried: 0, skipped: 0 });
    assert.equal((await row(a)).status, 'sent');
    assert.ok((await row(a)).tg_message_id);
    assert.equal(calls.length, 1);
    assert.deepEqual(await q.processOnce(), { sent: 0, failed: 0, retried: 0, skipped: 0 }, 'отправленное не уходит повторно');

    // временный сбой: остаётся в очереди с паузой, потом уходит
    mode = 'fail';
    const b = await q.enqueue({ bot: 'admin', payload: { chat_id: '1', text: 'админу' } });
    assert.equal((await q.processOnce()).retried, 1);
    let r = await row(b);
    assert.equal(r.status, 'pending'); assert.equal(r.attempts, 1); assert.match(r.last_error, /Bad Gateway/);
    assert.deepEqual(await q.processOnce(), { sent: 0, failed: 0, retried: 0, skipped: 0 }, 'пока пауза не прошла, не трогаем');
    mode = 'ok'; await due(b);
    assert.equal((await q.processOnce()).sent, 1);
    assert.equal((await row(b)).status, 'sent');

    // Telegram просит подождать (429): уважаем retry_after
    mode = 'limit';
    const c = await q.enqueue({ bot: 'client', payload: { chat_id: '6', text: 'x' } });
    await q.processOnce();
    r = await pool.query("SELECT EXTRACT(EPOCH FROM (next_attempt_at - NOW())) AS s FROM notification_outbox WHERE id = $1", [c]);
    assert.ok(Number(r.rows[0].s) > 30, 'пауза не меньше, чем просит Telegram');
    await pool.query('DELETE FROM notification_outbox WHERE id = $1', [c]);

    // бот заблокирован: сразу «не доставлено», без повторов
    mode = 'blocked';
    const d = await q.enqueue({ bot: 'client', payload: { chat_id: '7', text: 'x' } });
    assert.equal((await q.processOnce()).failed, 1);
    assert.equal((await row(d)).status, 'failed');

    // восемь неудач подряд: окончательный отказ
    mode = 'fail';
    const e = await q.enqueue({ bot: 'client', payload: { chat_id: '8', text: 'x' } });
    for (let i = 0; i < 8; i++) { await q.processOnce(); await due(e); }
    assert.equal((await row(e)).status, 'failed');
    assert.equal((await row(e)).attempts, 8);

    // зависимость: второе сообщение ждёт, пока первое не получит итог
    mode = 'ok';
    const first = await q.enqueue({ bot: 'courier', dedupKey: 'first', payload: { chat_id: '9', text: '1' } });
    await pool.query("UPDATE notification_outbox SET next_attempt_at = NOW() + INTERVAL '1 hour' WHERE id = $1", [first]);
    const second = await q.enqueue({ bot: 'courier', dependsOn: 'first', payload: { chat_id: '9', text: '2' } });
    assert.deepEqual(await q.processOnce(), { sent: 0, failed: 0, retried: 0, skipped: 0 }, 'второе ждёт первое');
    assert.equal(await q.supersede('first'), true, 'неотправленное можно отменить');
    assert.equal((await row(first)).status, 'skipped');
    assert.equal((await q.processOnce()).sent, 1);
    assert.equal((await row(second)).status, 'sent');
});

test('новый заказ: уведомления пишутся в той же транзакции, что и заказ', { skip }, async (t) => {
    env();
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    await initDB();
    await pool.query('DELETE FROM notification_outbox');
    const pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('Q-oil', 100, true, 2) RETURNING id")).rows[0].id;
    t.after(async () => {
        await pool.query('DELETE FROM notification_outbox');
        await pool.query("DELETE FROM orders WHERE order_number LIKE 'AP-qx%'");
        await pool.query('DELETE FROM products WHERE id = $1', [pid]);
    });
    const mk = (key, qty) => db.createOrder({ order_number: 'AP-' + key, user_id: 777003, name: 't', phone: '1', zone: 'spb', city: 'c', street: 's', house: '1',
        items: [{ productId: pid, qty, name: 'Q-oil' }], subtotal: 100 * qty, total: 100 * qty, idempotency_key: key,
        buildNotifications: (row) => [
            { bot: 'client', dedupKey: `order-client:${row.id}`, payload: { chat_id: '777003', text: 'принят' } },
            { bot: 'admin', dedupKey: `order-admin:${row.id}`, payload: { chat_id: '1', text: 'новый', reply_markup: { inline_keyboard: [[{ text: 'Отменить', callback_data: `cancel_${row.id}` }]] } } }
        ] });

    const ok = await mk('qx1', 1);
    const rows = (await pool.query('SELECT bot, payload FROM notification_outbox ORDER BY id')).rows;
    assert.deepEqual(rows.map(r => r.bot), ['client', 'admin']);
    assert.equal(rows[1].payload.reply_markup.inline_keyboard[0][0].callback_data, `cancel_${ok.id}`, 'кнопка несёт внутренний номер заказа');

    // заказ не прошёл (нет остатка) — откатились и заказ, и сообщения
    await assert.rejects(() => mk('qx2', 5), /OUT_OF_STOCK/);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notification_outbox')).rows[0].n, 2, 'новых сообщений нет');
});

after(async () => { if (DB) await require('../bot/db').pool.end(); });
