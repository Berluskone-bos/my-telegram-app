'use strict';
// Запуск: npm test   (Node 20+, без внешних пакетов)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyInitData } = require('../bot/telegram-auth');

// Токен выдуманный. Эталонные значения посчитаны НЕЗАВИСИМО, на Python (hmac/hashlib).
const TOKEN = '123456:TEST_TOKEN_FOR_UNIT_TESTS';
const NOW = 1700000100;
const USER = '{"id":42,"first_name":"Test"}';
const GOOD_HASH   = '4806c662c596103471ebf93ef51838ab5fc2e056a934c76f999b7c0d89409f02';
const NOSIG_HASH  = '5847d539d448fd835fc5187848623513918f8d76d061a4f4397715c4f7677113'; // без поля signature в строке — неверно
const SWAPPED     = 'fefb8dd999d637f0177c79a467e6003aa43ea71df27737ebf18481c246a3a82f'; // ключ и сообщение поменяны местами — неверно
const RAW_TOKEN   = '904916063f3bdad8a6ee24824b7e43afff7d7c7fd933c79422e50fabe897abc0'; // токен как ключ напрямую — неверно

const build = (hash, over = {}) => {
    const p = new URLSearchParams({ auth_date: '1700000000', query_id: 'AAHtest', signature: 'c2lnbmF0dXJl', user: USER, ...over });
    p.set('hash', hash);
    return p.toString();
};
const check = (initData, token = TOKEN, extra = {}) => verifyInitData(initData, token, { nowSec: NOW, ttlSec: 3600, ...extra });

test('верная подпись принимается и возвращает пользователя', () => {
    const r = check(build(GOOD_HASH));
    assert.ok(r);
    assert.equal(r.user.id, 42);
    assert.equal(r.authDate, 1700000000);
});

test('формула закреплена: свой расчёт совпадает с независимым эталоном', () => {
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const dcs = ['auth_date=1700000000', 'query_id=AAHtest', 'signature=c2lnbmF0dXJl', `user=${USER}`].join('\n');
    assert.equal(crypto.createHmac('sha256', secret).update(dcs).digest('hex'), GOOD_HASH);
});

test('неверные формулы отклоняются', () => {
    assert.equal(check(build(SWAPPED)), null, 'ключ и сообщение перепутаны');
    assert.equal(check(build(RAW_TOKEN)), null, 'токен вместо secret_key');
    assert.equal(check(build(NOSIG_HASH)), null, 'поле signature выброшено из строки');
});

test('чужой токен, подмена данных, отсутствующий или кривой hash', () => {
    assert.equal(check(build(GOOD_HASH), '654321:OTHER_TOKEN'), null);
    assert.equal(check(build(GOOD_HASH, { user: '{"id":43,"first_name":"Test"}' })), null);
    assert.equal(check(build(GOOD_HASH, { query_id: 'AAHother' })), null);
    assert.equal(check('auth_date=1700000000&user=x'), null);
    assert.equal(check(build('zz'.repeat(32))), null);
    assert.equal(check(''), null);
    assert.equal(check(null), null);
    assert.equal(check(build(GOOD_HASH), ''), null);
});

test('срок действия: просроченные и «из будущего» отклоняются', () => {
    assert.ok(check(build(GOOD_HASH), TOKEN, { nowSec: 1700000000 + 3600 }));
    assert.equal(check(build(GOOD_HASH), TOKEN, { nowSec: 1700000000 + 3601 }), null);
    assert.equal(check(build(GOOD_HASH), TOKEN, { nowSec: 1700000000 - 61 }), null);
});
