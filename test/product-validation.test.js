'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProductPayload } = require('../bot/product-validation');

test('accepts valid product create payload and converts numeric strings', () => {
    const result = validateProductPayload({ name: ' Масло ', price: '1290.50', stock: '0', min_stock: 0, active: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { name: 'Масло', price: 1290.5, stock: 0, min_stock: 0, active: true });
});

test('rejects missing name or price', () => {
    assert.equal(validateProductPayload({ price: 100 }).ok, false);
    assert.equal(validateProductPayload({ name: 'Масло' }).ok, false);
});

test('rejects negative, non-finite and out-of-range numbers', () => {
    for (const price of [-1, 'NaN', 'Infinity', '10000001']) {
        assert.equal(validateProductPayload({ name: 'Масло', price }).ok, false);
    }
    assert.equal(validateProductPayload({ name: 'Масло', price: 100, stock: -1 }).ok, false);
    assert.equal(validateProductPayload({ name: 'Масло', price: 100, stock: 1.5 }).ok, false);
});

test('rejects wrong field types and malformed specs', () => {
    assert.equal(validateProductPayload({ name: 'Масло', price: 100, active: 'false' }).ok, false);
    assert.equal(validateProductPayload({ name: 'Масло', price: 100, specs: [] }).ok, false);
    assert.equal(validateProductPayload(null).ok, false);
});

test('accepts partial updates and rejects empty updates', () => {
    assert.equal(validateProductPayload({ stock: 12 }, { partial: true }).ok, true);
    assert.equal(validateProductPayload({ unknown: 'ignored' }, { partial: true }).ok, false);
});
