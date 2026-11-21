'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isPrivateCourierMessage,
    isPrivateCourierCallback,
    isSameTelegramSender
} = require('../bot/courier-chat-guard');

test('курьерские сообщения принимаются только от владельца личного чата', () => {
    assert.equal(isPrivateCourierMessage({ chat: { id: 123, type: 'private' }, from: { id: 123 } }), true);
    assert.equal(isPrivateCourierMessage({ chat: { id: -100123, type: 'supergroup' }, from: { id: 123 } }), false);
    assert.equal(isPrivateCourierMessage({ chat: { id: 123, type: 'private' }, from: { id: 456 } }), false);
    assert.equal(isPrivateCourierMessage({ chat: { id: 123 }, from: { id: 123 } }), false);
    assert.equal(isPrivateCourierMessage(null), false);
});

test('нажатия курьерских кнопок принимаются только из личного чата владельца', () => {
    assert.equal(isPrivateCourierCallback({ from: { id: 123 }, message: { chat: { id: 123, type: 'private' } } }), true);
    assert.equal(isPrivateCourierCallback({ from: { id: 123 }, message: { chat: { id: -100123, type: 'supergroup' } } }), false);
    assert.equal(isPrivateCourierCallback({ from: { id: 456 }, message: { chat: { id: 123, type: 'private' } } }), false);
    assert.equal(isPrivateCourierCallback({ from: { id: 123 } }), false);
});

test('ответ на регистрацию, смену транспорта или привязку фото должен прийти от того же отправителя', () => {
    const original = { from: { id: 123 } };
    assert.equal(isSameTelegramSender({ from: { id: 123 } }, original), true);
    assert.equal(isSameTelegramSender({ from: { id: 456 } }, original), false);
    assert.equal(isSameTelegramSender({ from: { id: '123' } }, original), true);
    assert.equal(isSameTelegramSender({}, original), false);
});
