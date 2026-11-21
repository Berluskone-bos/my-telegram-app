'use strict';
// Интеграционные проверки конкурентного списания. Только локальная тестовая PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('склад: конкурентные заказы, повторный Idempotency-Key и атомарный rollback', { skip }, async (t) => {
    Object.assign(process.env, {
        DATABASE_URL: DB, WEBHOOK_SECRET: 's'.repeat(32), BOT_TOKEN: '1:x',
        WEB_APP_URL: 'https://x.y', WEBHOOK_URL: 'https://x.y',
        ADMIN_CHAT_ID: '1', ADMIN_BOT_TOKEN: '1:y'
    });
    const { pool, initDB } = require('../bot/db');
    const A = require('../bot/db-adapter');
    const db = typeof A === 'function' ? new A(pool) : (A.default || A);
    await initDB();

    const suffix = String(process.pid) + '-' + Date.now();
    const products = [];
    const orderNumbers = [];
    const addProduct = async (name, stock) => {
        const r = await pool.query(
            'INSERT INTO products(name, price, active, stock) VALUES ($1, 100, true, $2) RETURNING id',
            [name + '-' + suffix, stock]
        );
        products.push(r.rows[0].id);
        return r.rows[0].id;
    };
    const stock = async (id) => Number((await pool.query('SELECT stock FROM products WHERE id = $1', [id])).rows[0].stock);
    const makeOrder = (number, key, userId, items) => {
        orderNumbers.push(number);
        const subtotal = items.reduce((sum, x) => sum + 100 * x.qty, 0);
        return {
            order_number: number, user_id: userId, user_name: 'Тест', phone: '1',
            address: 'Тестовый адрес', zone: 'spb', city: 'Тест', street: 'Тест',
            house: '1', items, subtotal, total: subtotal, idempotency_key: key
        };
    };
    t.after(async () => {
        if (orderNumbers.length) await pool.query('DELETE FROM orders WHERE order_number = ANY($1::text[])', [orderNumbers]);
        if (products.length) await pool.query('DELETE FROM products WHERE id = ANY($1::int[])', [products]);
        await pool.end();
    });

    // Режим склада включён в тестовой БД; не изменяем production и не сбрасываем глобальный флаг.
    await pool.query("INSERT INTO app_flags(flag) VALUES ('stock_tracking_enabled') ON CONFLICT (flag) DO NOTHING");

    const lastUnit = await addProduct('concurrent-last-unit', 1);
    const concurrent = await Promise.allSettled([
        db.createOrder(makeOrder('AP-CONC-A-' + suffix, 'conc-a-' + suffix, '777880001', [{ productId: lastUnit, qty: 1, name: 'last unit' }])),
        db.createOrder(makeOrder('AP-CONC-B-' + suffix, 'conc-b-' + suffix, '777880002', [{ productId: lastUnit, qty: 1, name: 'last unit' }]))
    ]);
    assert.equal(concurrent.filter(x => x.status === 'fulfilled').length, 1, 'ровно один покупатель получает последнюю единицу');
    const rejected = concurrent.find(x => x.status === 'rejected');
    assert.ok(rejected, 'второй заказ должен быть отклонён');
    assert.equal(rejected.reason.code, 'OUT_OF_STOCK');
    assert.equal(await stock(lastUnit), 0, 'остаток не уходит ниже нуля');
    const concurrentCount = Number((await pool.query(
        'SELECT count(*)::int AS n FROM orders WHERE order_number = ANY($1::text[])', [orderNumbers.slice(0, 2)]
    )).rows[0].n);
    assert.equal(concurrentCount, 1, 'в базе только один заказ на последнюю единицу');

    const duplicateProduct = await addProduct('idempotent-repeat', 5);
    const sameKey = makeOrder('AP-IDEM-' + suffix, 'idem-' + suffix, '777880003', [
        { productId: duplicateProduct, qty: 2, name: 'idempotent item' }
    ]);
    const repeated = await Promise.all([
        db.createOrder(sameKey),
        db.createOrder({ ...sameKey, items: sameKey.items.map(x => ({ ...x })) })
    ]);
    assert.equal(repeated.length, 2);
    assert.equal(repeated[0].id, repeated[1].id, 'оба запроса возвращают один заказ');
    assert.equal(repeated.filter(x => x.duplicate === true).length, 1, 'повтор распознан как duplicate');
    assert.equal(await stock(duplicateProduct), 3, 'одинаковый ключ списывает товар один раз');
    assert.equal(Number((await pool.query(
        'SELECT count(*)::int AS n FROM orders WHERE user_id = $1 AND idempotency_key = $2',
        ['777880003', 'idem-' + suffix]
    )).rows[0].n), 1, 'уникальный заказ по ключу');

    const first = await addProduct('rollback-first', 3);
    const empty = await addProduct('rollback-empty', 0);
    const rollbackOrder = makeOrder('AP-ROLLBACK-' + suffix, 'rollback-' + suffix, '777880004', [
        { productId: first, qty: 1, name: 'first item' },
        { productId: empty, qty: 1, name: 'empty item' }
    ]);
    await assert.rejects(
        () => db.createOrder(rollbackOrder),
        (error) => error.code === 'OUT_OF_STOCK'
    );
    assert.equal(await stock(first), 3, 'первое списание откатилось вместе со всей транзакцией');
    assert.equal(await stock(empty), 0, 'нулевой остаток не изменился');
    assert.equal(Number((await pool.query(
        'SELECT count(*)::int AS n FROM orders WHERE order_number = $1', [rollbackOrder.order_number]
    )).rows[0].n), 0, 'неуспешный заказ не сохранился');
});
