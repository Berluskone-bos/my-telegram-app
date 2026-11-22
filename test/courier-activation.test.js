'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCourierActivationId } = require('../bot/courier-activation');

test('принимает точный callback активации с положительным ID из диапазона SERIAL', () => {
    assert.equal(parseCourierActivationId('activate_courier_123'), 123);
    assert.equal(parseCourierActivationId('activate_courier_1'), 1);
    assert.equal(parseCourierActivationId('activate_courier_2147483647'), 2147483647);
});

test('отклоняет callback с хвостом, пропущенным ID и ID вне диапазона SERIAL', () => {
    for (const value of [
        'activate_courier_123abc', 'activate_courier_123_456', 'activate_courier_',
        'activate_courier_0', 'activate_courier_-1', 'activate_courier_2147483648',
        'activate_courier_99999999999', 'activate_courier_123.0',
        'xactivate_courier_123', null, undefined, 123
    ]) assert.equal(parseCourierActivationId(value), null, String(value));
});
