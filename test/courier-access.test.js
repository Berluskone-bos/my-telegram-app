const test = require('node:test');
const assert = require('node:assert/strict');
const { getCourierAccessMessage } = require('../bot/courier-access');

test('explains that an archived courier account is disabled, not unregistered', () => {
    const message = getCourierAccessMessage({ id: 7, is_active: false, archived_at: '2026-11-22T10:00:00Z' });
    assert.match(message, /аккаунт курьера отключён/i);
    assert.match(message, /обратитесь к администратору/i);
    assert.doesNotMatch(message, /зарегистрированы|\/start/i);
});

test('asks a new courier to submit a registration request', () => {
    assert.match(getCourierAccessMessage(null), /отправьте \/start/i);
});

test('explains that a pending courier needs administrator approval', () => {
    assert.match(getCourierAccessMessage({ id: 8, is_active: false, archived_at: null }), /не активирован/i);
});

test('allows an active courier', () => {
    assert.equal(getCourierAccessMessage({ id: 9, is_active: true, archived_at: null }), null);
});
