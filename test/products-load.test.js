'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'products.js'), 'utf8');

function loadProducts(fetchImpl) {
    const sandbox = {
        window: { location: { hostname: 'shop.example' } },
        fetch: fetchImpl,
        console: { warn() {}, error() {} }
    };
    return vm.runInNewContext(source + '\nProducts', sandbox);
}

const fallbackCatalog = {
    categories: [{ id: 'motor', name: 'Моторные масла', icon: 'droplets' }],
    products: [{ id: 1, name: 'Fallback oil', category_id: 'motor', active: true }]
};

test('uses catalog.json when API responds 304 (not ok for Fetch)', async () => {
    const calls = [];
    const products = loadProducts(async (url, options) => {
        calls.push({ url, options });
        if (url.includes('/api/catalog')) return { ok: false, status: 304 };
        return { ok: true, status: 200, json: async () => fallbackCatalog };
    });

    await products.load();
    assert.equal(products.data.length, 1);
    assert.equal(products.data[0].name, 'Fallback oil');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[1].options.cache, 'no-store');
});

test('uses catalog.json when API returns an empty active catalog', async () => {
    const products = loadProducts(async (url) => url.includes('/api/catalog')
        ? { ok: true, status: 200, json: async () => [] }
        : { ok: true, status: 200, json: async () => fallbackCatalog });

    await products.load();
    assert.equal(products.data.length, 1);
    assert.equal(products.data[0].name, 'Fallback oil');
});

test('uses non-empty API catalog and normalizes its fields', async () => {
    const products = loadProducts(async () => ({
        ok: true,
        status: 200,
        json: async () => [{ id: 7, name: 'API oil', category: 'motor', image: '/oil.webp' }]
    }));

    await products.load();
    assert.equal(products.data.length, 1);
    assert.equal(products.data[0].category_id, 'motor');
    assert.equal(products.data[0].main_image, '/oil.webp');
});
