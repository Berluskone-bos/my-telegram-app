'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DATABASE_URL = require('./test-db').testDatabaseUrl();
const skip = DATABASE_URL ? false : 'нет TEST_DATABASE_URL';

test('архивные и деактивированные курьеры подают заявку и восстанавливаются только после подтверждения', { skip }, async t => {
    Object.assign(process.env, { DATABASE_URL });
    const { pool, initDB } = require('../bot/db');
    const Adapter = require('../bot/db-adapter');
    const db = typeof Adapter === 'function' ? new Adapter(pool) : (Adapter.default || Adapter);
    await initDB();

    const telegramId = 920000000000 + (Date.now() % 1000000000);
    const archivedCourier = await db.createCourier({
        name: 'Тест восстановления архивного курьера', phone: '+70000000001',
        telegram_id: telegramId, telegram_user: 'archived-reactivation-test',
        vehicle_type: 'авто', is_active: false
    });
    const inactiveCourier = await db.createCourier({
        name: 'Тест восстановления деактивированного курьера', phone: '+70000000002',
        telegram_id: telegramId + 1, telegram_user: 'inactive-reactivation-test',
        vehicle_type: 'авто', is_active: false
    });
    t.after(async () => {
        await pool.query('DELETE FROM couriers WHERE id = ANY($1::bigint[])', [[archivedCourier.id, inactiveCourier.id]]);
        await pool.end();
    });

    await db.archiveCourier(archivedCourier.id);
    const token = require('crypto').randomBytes(16).toString('hex');
    const request = await db.requestCourierReactivation(telegramId, token);
    assert.equal(request.status, 'pending');
    assert.ok(request.courier.archived_at);
    assert.equal(request.courier.activation_token, token);

    const repeated = await db.requestCourierReactivation(telegramId, require('crypto').randomBytes(16).toString('hex'));
    assert.equal(repeated.courier.activation_token, token, 'повторный /start не заменяет действующий токен');

    const restored = await db.approveCourierReactivation(archivedCourier.id);
    assert.equal(restored.is_active, true);
    assert.equal(restored.archived_at, null);
    assert.equal(restored.activation_token, null);
    assert.equal(await db.approveCourierReactivation(archivedCourier.id), null, 'повторное подтверждение отклонено');
    assert.equal(await db.activateCourier(archivedCourier.id, token), null, 'старый callback не может повторно активировать запись');

    const inactiveRequest = await db.requestCourierReactivation(telegramId + 1, require('crypto').randomBytes(16).toString('hex'));
    assert.equal(inactiveRequest.status, 'pending');
    assert.equal(inactiveRequest.courier.is_active, false);
    const inactiveRestored = await db.approveCourierReactivation(inactiveCourier.id);
    assert.equal(inactiveRestored.is_active, true);
    assert.equal(inactiveRestored.archived_at, null);
});
