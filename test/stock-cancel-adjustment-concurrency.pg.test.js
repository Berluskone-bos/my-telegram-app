'use strict';
// PostgreSQL integration tests: TEST_DATABASE_URL must point to an isolated test database.
const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('склад: параллельная отмена и ручная корректировка сериализуются без двойного возврата', { skip }, async (t) => {
    Object.assign(process.env, {
        DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x',
        WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y',
        ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y'
    });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    await initDB();

    const trackingBefore = (await pool.query(
        "SELECT EXISTS(SELECT 1 FROM app_flags WHERE flag = 'stock_tracking_enabled') AS enabled"
    )).rows[0].enabled;
    let productId = null;
    const orderNumbers = [];
    t.after(async () => {
        if (orderNumbers.length) await pool.query('DELETE FROM orders WHERE order_number = ANY($1::text[])', [orderNumbers]);
        if (productId !== null) await pool.query('DELETE FROM products WHERE id = $1', [productId]);
        if (trackingBefore) {
            await pool.query("INSERT INTO app_flags(flag) VALUES ('stock_tracking_enabled') ON CONFLICT DO NOTHING");
        } else {
            await pool.query("DELETE FROM app_flags WHERE flag = 'stock_tracking_enabled'");
        }
        await pool.end();
    });

    await pool.query("INSERT INTO app_flags(flag) VALUES ('stock_tracking_enabled') ON CONFLICT DO NOTHING");
    productId = (await pool.query(
        "INSERT INTO products(name, price, active, stock) VALUES ('T-stock-race', 100, true, 10) RETURNING id"
    )).rows[0].id;

    const makeOrder = async (suffix, qty = 2) => {
        const number = 'AP-STOCK-RACE-' + suffix;
        orderNumbers.push(number);
        return db.createOrder({
            order_number: number, user_id: '900000001', user_name: 'stock test', phone: '1',
            zone: 'spb', city: 'test', street: 'test', house: '1',
            items: [{ productId, qty, name: 'T-stock-race' }],
            subtotal: 100 * qty, total: 100 * qty,
            idempotency_key: 'stock-race-' + suffix
        });
    };
    const stock = async () => Number((await pool.query(
        'SELECT stock FROM products WHERE id = $1', [productId]
    )).rows[0].stock);

    // Две разные точки отмены одновременно: только одна должна изменить статус и вернуть товар.
    const first = await makeOrder('cancel', 3);
    assert.equal(await stock(), 7);
    const outcomes = await Promise.all([
        db.cancelOrderByNumber(first.order_number),
        db.updateOrderStatus(first.id, 'CANCELLED')
    ]);
    assert.ok((outcomes[0] === true && outcomes[1] === 'ALREADY') || (outcomes[0] === false && outcomes[1] === true),
        `неожиданные результаты параллельной отмены: ${JSON.stringify(outcomes)}`);
    assert.equal((await pool.query('SELECT status, stock_deducted FROM orders WHERE id = $1', [first.id])).rows[0].status, 'CANCELLED');
    assert.equal((await pool.query('SELECT stock_deducted FROM orders WHERE id = $1', [first.id])).rows[0].stock_deducted, false);
    assert.equal(await stock(), 10, 'конкурирующие отмены вернули три единицы ровно один раз');

    // Абсолютная ручная установка остатка и возврат при отмене должны иметь один из двух
    // допустимых последовательных результатов, а не потерять инкремент/перезаписать строку частично.
    const second = await makeOrder('adjust', 2);
    assert.equal(await stock(), 8);
    const [manual, cancel] = await Promise.all([
        db.updateProduct(productId, { stock: 20 }),
        db.updateOrderStatus(second.id, 'CANCELLED')
    ]);
    assert.ok(manual && manual.id === productId);
    assert.equal(cancel, true);
    const finalStock = await stock();
    assert.ok([20, 22].includes(finalStock),
        `ожидалось 20 (ручная установка последней) или 22 (сначала установка, затем возврат), получено ${finalStock}`);
    assert.equal((await pool.query('SELECT status, stock_deducted FROM orders WHERE id = $1', [second.id])).rows[0].stock_deducted, false);

    // Две ручные установки абсолютного значения также сериализуются PostgreSQL.
    const [a, b] = await Promise.all([
        db.updateProduct(productId, { stock: 30 }),
        db.updateProduct(productId, { stock: 40 })
    ]);
    assert.ok(a && b);
    assert.ok([30, 40].includes(await stock()), 'последняя сериализованная установка определяет итог');

    // Optimistic concurrency: accept the update only if stock still matches the value read.
    const expected = await stock();
    const accepted = await db.updateProduct(productId, { stock: 50 }, { expectedStock: expected });
    assert.equal(Number(accepted.stock), 50);
    await assert.rejects(
        db.updateProduct(productId, { stock: 60 }, { expectedStock: expected }),
        error => error.code === 'STOCK_CONFLICT'
    );
    assert.equal(await stock(), 50, 'устаревшая ручная установка не перезаписала новый остаток');
});
