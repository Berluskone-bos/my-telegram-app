'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCourierActivationId } = require('../bot/courier-activation');

test('принимает только точный callback активации с положительным безопасным ID', () => {
    assert.equal(parseCourierActivationId('activate_courier_123'), 123);
    assert.equal(parseCourierActivationId('activate_courier_1'), 1);
    assert.equal(parseCourierActivationId('activate_courier_9007199254740991'), 9007199254740991);
});

test('отклоняет callback с хвостом, пропущенным ID и некорректным форматом', () => {
    for (const value of [
        'activate_courier_123abc', 'activate_courier_123_456', 'activate_courier_',
        'activate_courier_0', 'activate_courier_-1', 'activate_courier_9007199254740992',
        'activate_courier_123.0', 'xactivate_courier_123', null, undefined, 123
    ]) assert.equal(parseCourierActivationId(value), null, String(value));
});
