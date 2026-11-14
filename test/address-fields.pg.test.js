'use strict';
// Нужна база: TEST_DATABASE_URL (см. test/test-db.js). Без неё тест пропускается.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('адрес: корпус, строение, литера и этаж сохраняются в заказе; профиль без адреса', { skip }, async (t) => {
    Object.assign(process.env, { DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x', WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y', ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y' });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    await initDB();
    await initDB(); // повторный запуск миграций не должен падать
    const pid = (await pool.query("INSERT INTO products(name, price, active, stock) VALUES ('A-oil', 500, true, 100) RETURNING id")).rows[0].id;
    t.after(async () => {
        await pool.query("DELETE FROM orders WHERE order_number = 'AP-addr1'");
        await pool.query('DELETE FROM customer_profiles WHERE user_id = 777001');
        await pool.query('DELETE FROM products WHERE id = $1', [pid]);
        await pool.end();
    });

    // профиль хранит только имя и телефон; адрес, сохранённый раньше, стирается при записи
    await pool.query("INSERT INTO customer_profiles (user_id, name, phone, city, street, house) VALUES (777001, 'Старое', '+7', 'СПб', 'Невский', '10') ON CONFLICT (user_id) DO UPDATE SET city = 'СПб', street = 'Невский', house = '10'");
    const saved = await db.upsertCustomerProfile(777001, { name: 'Т', phone: '+79990000000' });
    assert.deepEqual(saved, { name: 'Т', phone: '+79990000000' });
    assert.deepEqual(await db.getCustomerProfile(777001), saved);
    const raw = (await pool.query('SELECT city, street, house, building, apartment FROM customer_profiles WHERE user_id = 777001')).rows[0];
    assert.deepEqual(Object.values(raw), ['', '', '', '', ''], 'адреса в профиле нет');

    const o = await db.createOrder({
        order_number: 'AP-addr1', user_id: 777001, user_name: 'Т', phone: '+79990000000',
        address: 'СПб, ул. Невский, д. 10, корп. 2, стр. 4, лит. А, под. 3, эт. 7, кв. 45',
        zone: 'spb', city: 'СПб', street: 'Невский', house: '10', building: '2', structure: '4', letter: 'А', entrance: '3', floor: '7', apartment: '45',
        items: [{ productId: pid, qty: 1, name: 'A-oil', volume: '4 л', price: 500 }], subtotal: 500, total: 500, idempotency_key: 'addr1'
    });
    const row = (await pool.query('SELECT building, structure, letter, entrance, floor, apartment, address FROM orders WHERE id = $1', [o.id])).rows[0];
    assert.deepEqual([row.building, row.structure, row.letter, row.entrance, row.floor, row.apartment], ['2', '4', 'А', '3', '7', '45']);
    assert.match(row.address, /корп\. 2, стр\. 4, лит\. А, под\. 3, эт\. 7, кв\. 45$/);
});
