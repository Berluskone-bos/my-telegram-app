'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testDatabaseUrl } = require('./helpers/test-db');

test('защита тестовой базы: разрешены только локальные тестовые базы', () => {
    assert.equal(testDatabaseUrl(''), null);
    assert.equal(testDatabaseUrl('postgres://user:pass@localhost:5432/t'), 'postgres://user:pass@localhost:5432/t');
    assert.ok(testDatabaseUrl('postgres://postgres@127.0.0.1:5499/test'));
    assert.ok(testDatabaseUrl('postgres://u:p@postgres:5432/shop_test'));
});

test('защита тестовой базы: рабочие и нетестовые базы запрещены', () => {
    for (const bad of [
        'postgres://u:p@ep-cool-123.eu-central-1.aws.neon.tech/neondb',
        'postgres://u:p@ep-cool-123.neon.tech/t',
        'postgres://u:p@containers-us-west-1.rlwy.net:5432/t',
        'postgres://u:p@postgres.railway.internal:5432/t',
        'postgres://u:p@db.example.com:5432/t',
        'postgres://u:p@localhost:5432/railway',
        'postgres://u:p@localhost:5432/neondb',
        'postgres://u:p@localhost:5432/postgres',
        'postgres://u:p@localhost:5432/shop',
        'не адрес',
    ]) assert.throws(() => testDatabaseUrl(bad), undefined, bad);
});
