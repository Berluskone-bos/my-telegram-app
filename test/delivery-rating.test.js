'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDeliveryRatingCallback } = require('../bot/delivery-rating');

test('разбирает только новый формат оценки конкретной доставки', () => {
    assert.deepEqual(parseDeliveryRatingCallback('rate_12_345_5'), {
        courierId: 12, stopId: 345, rating: 5
    });
    assert.deepEqual(parseDeliveryRatingCallback('rate_12_345_1'), {
        courierId: 12, stopId: 345, rating: 1
    });
});

test('отклоняет старые callback без ID остановки и некорректные значения', () => {
    for (const value of [
        'rate_12_o_5',
        'rate_12_345_0',
        'rate_12_345_6',
        'rate_12_345_5_extra',
        'xrate_12_345_5',
        'rate_0_345_5',
        'rate_12_0_5',
        'rate_999999999999999999999_345_5',
        null,
        {}
    ]) assert.equal(parseDeliveryRatingCallback(value), null, String(value));
});
