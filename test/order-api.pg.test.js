'use strict';
// Нужна база: TEST_DATABASE_URL. Запускает настоящий сервер bot.js (Telegram подменён заглушкой) и оформляет заказ через API.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

function signedInitData(botToken, user) {
    const f = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH', user: JSON.stringify(user) };
    const check = Object.keys(f).sort().map(k => `${k}=${f[k]}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    f.hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams(f).toString();
}

test('заказ через API: сообщения клиенту и админу попадают в очередь, кнопка отмены несёт внутренний номер', { skip }, async (t) => {
    process.env.DATABASE_URL = DB;
    const { pool, initDB } = require('../bot/db');
    await initDB();
    await pool.query('DELETE FROM notification_outbox');
    const pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('API-oil', 700, true, 100) RETURNING id")).rows[0].id;
    const port = 3900 + Math.floor(Math.random() * 90);
    const token = '1:apitest';
    const child = spawn(process.execPath, ['-r', path.join(__dirname, 'fake-telegram-preload.js'), path.join(__dirname, '..', 'bot', 'bot.js')], {
        env: { ...process.env, PORT: String(port), DATABASE_URL: DB, BOT_TOKEN: token, WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y',
               WEBHOOK_SECRET: 's'.repeat(32), ADMIN_CHAT_ID: '4242', OUTBOX_DISABLED: '1', NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
    t.after(async () => {
        child.kill();
        await pool.query('DELETE FROM notification_outbox');
        await pool.query("DELETE FROM orders WHERE user_id = 777005");
        await pool.query('DELETE FROM products WHERE id = $1', [pid]);
        await pool.end();
    });
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).status < 500) break; } catch { /* ещё не запустился */ }
        await new Promise(r => setTimeout(r, 250));
        if (i === 79) assert.fail('сервер не запустился:\n' + log.slice(-1500));
    }

    const res = await fetch(`http://127.0.0.1:${port}/api/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': signedInitData(token, { id: 777005, first_name: 'Тест' }) },
        body: JSON.stringify({ items: [{ productId: pid, qty: 2 }], phone: '+79991112233', address: 'Санкт-Петербург, ул. Тестовая, д. 5, корп. 2, эт. 3', city: 'Санкт-Петербург', street: 'Тестовая',
            house: '5', building: '2', floor: '3', zone: 'spb', deliveryType: 'delivery', payment: 'cash' })
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body) + '\n' + log.slice(-800));
    assert.match(body.orderId, /^AP-\d{12,14}$/);

    const order = (await pool.query('SELECT id, building, floor FROM orders WHERE order_number = $1', [body.orderId])).rows[0];
    assert.equal(order.building, '2'); assert.equal(order.floor, '3');
    const rows = (await pool.query('SELECT bot, status, payload FROM notification_outbox ORDER BY id')).rows;
    assert.deepEqual(rows.map(r => r.bot), ['client', 'admin']);
    assert.ok(rows.every(r => r.status === 'pending'));
    assert.equal(rows[0].payload.chat_id, '777005');
    assert.match(rows[0].payload.text, new RegExp(body.orderId));
    assert.equal(rows[1].payload.chat_id, '4242');
    assert.match(rows[1].payload.text, /корп\. 2/); assert.match(rows[1].payload.text, /этаж 3/);
    assert.equal(rows[1].payload.reply_markup.inline_keyboard[0][0].callback_data, `cancel_${order.id}`);
});
