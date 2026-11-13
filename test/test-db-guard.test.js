'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testDatabaseUrl } = require('./test-db');

test('защита тестовой базы: разрешены только локальные тестовые базы', () => {
    assert.equal(testDatabaseUrl(''), null);
    assert.equal(testDatabaseUrl('postgres://user:pass@localhost:5432/t'), 'postgres://user:pass@localhost:5432/t');
    assert.ok(testDatabaseUrl('postgres://postgres@127.0.0.1:5499/test'));
    assert.ok(testDatabaseUrl('postgres://user:pass@postgres:5432/shop_test'));
});

test('защита тестовой базы: рабочие и нетестовые базы запрещены', () => {
    for (const bad of [
        'postgres://user:pass@ep-cool-123.eu-central-1.aws.neon.tech/neondb',
        'postgres://user:pass@ep-cool-123.neon.tech/t',
        'postgres://user:pass@containers-us-west-1.rlwy.net:5432/t',
        'postgres://user:pass@postgres.railway.internal:5432/t',
        'postgres://user:pass@db.example.com:5432/t',
        'postgres://user:pass@localhost:5432/railway',
        'postgres://user:pass@localhost:5432/neondb',
        'postgres://user:pass@localhost:5432/postgres',
        'postgres://user:pass@localhost:5432/shop',
        'не адрес',
    ]) assert.throws(() => testDatabaseUrl(bad), undefined, bad);
});
