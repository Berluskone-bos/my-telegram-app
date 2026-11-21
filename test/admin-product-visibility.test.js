'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterProductsForRole, validateStockUpdate } = require('../bot/admin-product-visibility');
const { hasPermission } = require('../bot/admin-permissions');

const product = {
    id: 12, brand: 'Gulf Western', category: 'motor', name: 'SYN-X',
    sku: 'GW-5W30', volume: '4 л', price: 4290, old_price: 4590,
    stock: 8, min_stock: 3, description: 'Описание', image: 'image.png',
    active: true, coming_soon: false, specs: { api: 'SP' }
};

test('admin retains the full product record', () => {
    assert.deepEqual(filterProductsForRole([product], 'admin'), [product]);
});

test('warehouse receives only fields needed for stock control', () => {
    const [visible] = filterProductsForRole([product], 'warehouse');
    assert.deepEqual(Object.keys(visible).sort(), [
        'active', 'brand', 'category', 'coming_soon', 'id', 'min_stock', 'name', 'sku', 'stock', 'volume'
    ]);
    for (const field of ['price', 'old_price', 'description', 'image', 'specs']) {
        assert.equal(Object.hasOwn(visible, field), false);
    }
});

test('unknown roles receive no product data', () => {
    assert.deepEqual(filterProductsForRole([product], 'unknown'), []);
});

test('warehouse can manage stock but cannot create or edit catalog', () => {
    assert.equal(hasPermission('warehouse', 'inventory.manage'), true);
    assert.equal(hasPermission('warehouse', 'settings.manage'), false);
    assert.equal(hasPermission('admin', 'settings.manage'), true);
});

test('stock update accepts only non-negative integer stock fields', () => {
    assert.deepEqual(validateStockUpdate({ stock: 0, min_stock: 3 }), {
        ok: true, data: { stock: 0, min_stock: 3 }
    });
    assert.deepEqual(validateStockUpdate({ stock: '12', expected_stock: 10 }), {
        ok: true, data: { stock: 12 }, expectedStock: 10
    });
    assert.deepEqual(validateStockUpdate({ min_stock: 4 }), {
        ok: true, data: { min_stock: 4 }, expectedStock: undefined
    });
});

for (const payload of [
    { price: 1 }, { stock: -1, expected_stock: 0 }, { stock: 1.5, expected_stock: 0 },
    { stock: '1.2', expected_stock: 0 }, { stock: 1 }, { stock: 1, expected_stock: -1 },
    { stock: 1, name: 'подмена' }, {}, null, []
]) {
    test('rejects unsafe stock payload ' + JSON.stringify(payload), () => {
        assert.equal(validateStockUpdate(payload).ok, false);
    });
}
