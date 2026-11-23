'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DATABASE_URL = require('./test-db').testDatabaseUrl();
const skip = DATABASE_URL ? false : 'нет TEST_DATABASE_URL';

test('архивный курьер подаёт заявку, администратор восстанавливает его один раз', { skip }, async t => {
    Object.assign(process.env, { DATABASE_URL });
    const { pool, initDB } = require('../bot/db');
    const Adapter = require('../bot/db-adapter');
    const db = typeof Adapter === 'function' ? new Adapter(pool) : (Adapter.default || Adapter);
    await initDB();
    const telegramId = 920000000000 + (Date.now() % 1000000000);
    const token = 'abcdef0123456789abcdef0123456789';
    const courier = await db.createCourier({
        name: 'Тест восстановления курьера', phone: '+70000000001',
        telegram_id: telegramId, telegram_user: 'reactivation-test',
        vehicle_type: 'авто', is_active: false
    });
    t.after(async () => {
        await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
        await pool.end();
    });

    await db.archiveCourier(courier.id);
    const request = await db.requestCourierReactivation(telegramId, token);
    assert.equal(request.status, 'pending');
    assert.ok(request.courier.archived_at);
    assert.equal(request.courier.activation_token, token);

    const repeated = await db.requestCourierReactivation(telegramId, '11111111111111111111111111111111');
    assert.equal(repeated.courier.activation_token, token, 'повторный /start не заменяет действующий токен');

    const restored = await db.approveCourierReactivation(courier.id);
    assert.equal(restored.is_active, true);
    assert.equal(restored.archived_at, null);
    assert.equal(restored.activation_token, null);
    assert.equal(await db.approveCourierReactivation(courier.id), null, 'повторное подтверждение отклонено');
    assert.equal(await db.activateCourier(courier.id, token), null, 'старый callback не может повторно активировать запись');
});

test('повторный запрос деактивированного, но не архивного курьера также ожидает подтверждения', { skip }, async t => {
    Object.assign(process.env, { DATABASE_URL });
    const { pool, initDB } = require('../bot/db');
    const Adapter = require('../bot/db-adapter');
    const db = typeof Adapter === 'function' ? new Adapter(pool) : (Adapter.default || Adapter);
    await initDB();
    const telegramId = 930000000000 + (Date.now() % 1000000000);
    const courier = await db.createCourier({
        name: 'Тест деактивированного курьера', phone: '+70000000002',
        telegram_id: telegramId, telegram_user: 'inactive-reactivation-test',
        vehicle_type: 'авто', is_active: false
    });
    t.after(async () => {
        await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
        await pool.end();
    });
    const request = await db.requestCourierReactivation(telegramId, '0123456789abcdef0123456789abcdef');
    assert.equal(request.status, 'pending');
    assert.equal(request.courier.is_active, false);
    const restored = await db.approveCourierReactivation(courier.id);
    assert.equal(restored.is_active, true);
    assert.equal(restored.archived_at, null);
});
