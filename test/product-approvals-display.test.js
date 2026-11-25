'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const productsSource = fs.readFileSync(path.join(root, 'js/products.js'), 'utf8');
const adapterSource = fs.readFileSync(path.join(root, 'bot/db-adapter.js'), 'utf8');

function loadProducts() {
    const sandbox = {
        window: { location: { hostname: 'shop.example' } },
        Cart: { items: [] },
        Favorites: { has: () => false },
        console: { warn() {}, error() {} }
    };
    return vm.runInNewContext(productsSource + '\nProducts', sandbox);
}

test('public catalog query includes all approvals stored by the admin panel', () => {
    const start = adapterSource.indexOf('async getPublicCatalog()');
    const end = adapterSource.indexOf('async getAllProducts()', start);
    assert.notEqual(start, -1, 'getPublicCatalog must exist');
    const query = adapterSource.slice(start, end);

    assert.match(query, /LEFT JOIN product_approvals pa ON pa\.product_id = p\.id/);
    assert.match(query, /array_agg\(pa\.approval ORDER BY pa\.approval\)/);
    assert.match(query, /AS approvals/);
    assert.match(query, /GROUP BY p\.id/);
});

test('product details display every admin-entered approval, not only API grade', () => {
    const products = loadProducts();
    const approvals = [
        'API SQ',
        'CHRYSLER MS 6395',
        'FORD WSS-M2C962-A1',
        'ILSAC GF-7A',
        'SQ-RC',
        'Рекомендуется для гибридных автомобилей'
    ];
    const product = products.normalize({
        id: 1001,
        name: 'Syn-Star LV 0W-20',
        brand: 'Gulf Western Oil',
        viscosity: '0W-20',
        volume: '1 л',
        api: 'SQ',
        approvals,
        price: 1000,
        specs: {}
    });
    const html = products.renderDetail(product);

    for (const approval of approvals) {
        assert.ok(html.includes(approval), 'missing approval: ' + approval);
    }
    assert.match(html, /Допуски и одобрения/);
    assert.equal((html.match(/Допуски и одобрения/g) || []).length, 1);
});

test('product details show the original Gulf Western Oil logo without the Australian-made mark', () => {
    const products = loadProducts();
    const html = products.renderDetail(products.normalize({
        id: 1002, name: 'Test oil', viscosity: '5W-30', price: 1000, specs: {}
    }));

    assert.match(html, /GulfWesternOil_Logo%20%281%29\.png/);
    assert.doesNotMatch(html, /made-australia|product-detail-australia-logo|Произведено в Австралии/);
    assert.match(html, /alt="Gulf Western Oil"/);
    assert.match(html, /aria-label="Логотип Gulf Western Oil"/);

    assert.ok(fs.existsSync(path.join(root, 'img', 'GulfWesternOil_Logo (1).png')));
});

test('Telegram WebView receives cache-busted product detail assets', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(html, /css\/styles\.css\?v=20261125-brandfix/);
    assert.match(html, /js\/products\.js\?v=20261125-brandfix/);
});
