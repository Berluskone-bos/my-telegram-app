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
    assert.match(html, /css\/styles\.css\?v=20261125-filter-accessibility/);
    assert.match(html, /js\/products\.js\?v=20261125-catalog-states/);
});


test('product detail separates approvals, purchase, characteristics and description without losing values', () => {
    const products = loadProducts();
    const approvals = ['API SQ', 'CHRYSLER MS 6395', 'FORD WSS-M2C962-A1', 'ILSAC GF-7A'];
    const product = products.normalize({
        id: 1003,
        name: 'Syn-Star LV 0W-20',
        brand: 'Gulf Western Oil',
        viscosity: '0W-20',
        volume: '1 л',
        approvals,
        price: 1890,
        old_price: 2190,
        in_stock: true,
        stock_left: 8,
        sku: 'GW-001',
        specs: { 'Тип масла': 'Синтетическое', 'Температура застывания': '-45 °C' },
        description: 'Моторное масло для современных двигателей.'
    });
    const html = products.renderDetail(product);

    assert.match(html, /product-detail-purchase/);
    assert.match(html, /Цена и наличие/);
    assert.match(html, /product-detail-approvals/);
    assert.match(html, /product-detail-specs/);
    assert.match(html, /product-detail-description/);
    assert.match(html, /Добавить в корзину: Syn-Star LV 0W-20/);
    // toLocaleString('ru-RU') inserts a non-breaking space in thousands.
    assert.match(html, /1\s890/);
    assert.match(html, /2\s190/);
    assert.match(html, /осталось 8 шт\./);
    for (const approval of approvals) assert.ok(html.includes('>' + approval + '</span>'), 'missing approval chip: ' + approval);
    assert.equal((html.match(/Допуски и одобрения/g) || []).length, 1);
    assert.match(html, /Температура застывания/);
    assert.match(html, /Моторное масло для современных двигателей\./);
});

test('product detail keeps the purchase action and sections accessible on narrow screens', () => {
    const css = fs.readFileSync(path.join(root, 'css/styles.css'), 'utf8');
    const products = loadProducts();
    const html = products.renderDetail(products.normalize({
        id: 1004, name: 'Test oil', price: 1000, in_stock: false, specs: {}
    }));
    assert.match(html, /type="button" class="btn-add-cart" disabled>Нет в наличии/);
    assert.match(css, /\.product-detail-approvals,[\s\S]*?\.product-detail-specs\s*\{[^}]*border-radius: 16px;/);
    assert.match(css, /@media \(max-width: 600px\)\s*\{[^}]*\.product-detail-image \{ height: 210px; \}/);
    assert.match(css, /\.btn-add-cart:focus-visible/);
    assert.match(css, /@media \(min-width: 600px\)\s*\{\s*\.product-detail-brand-marks \{ transform: translateX\(-14px\); \}\s*\}/);
});


test('any non-action area of a catalog product card opens the product detail', () => {
    const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
    const products = fs.readFileSync(path.join(root, 'js/products.js'), 'utf8');
    const captureStart = app.indexOf("const productGrid = document.getElementById('productGrid');");
    assert.notEqual(captureStart, -1, 'product grid pointer handler must be registered');
    const captureEnd = app.indexOf('        // Делегирование: категории, товары, фильтры, нижняя навигация', captureStart);
    const handler = app.slice(captureStart, captureEnd);

    assert.ok(handler.includes("productGrid?.addEventListener('pointerup'"), 'pointerup must be handled on the product grid');
    assert.ok(handler.includes('openProductFromEvent(event)'), 'pointer events must open the selected product');
    assert.ok(handler.includes('this.showProduct(productId)'), 'the product detail must be opened by validated product id');
    assert.ok(handler.includes('}, true);'), 'the pointer handler must run in capture phase');
    assert.ok(handler.includes('.favorite-btn, .btn-buy'), 'favorite and cart actions must remain independent');
    assert.ok(handler.includes("document.addEventListener('click'"), 'click fallback must remain available');
    assert.ok(handler.includes('_productPointerOpenedAt'), 'pointerup and click must not open the same product twice');
    assert.match(products, /<article class="product-card[^>]*data-product-id="\$\{product\.id\}"/);
    assert.ok(products.includes('class="product-title-button" aria-label="Подробнее о товаре'));
    assert.ok(!products.includes('class="product-title-button" onclick='));
    assert.ok(products.includes('event.stopPropagation(); App.toggleFavorite('));
    assert.ok(products.includes('class="btn-buy" data-product-id='));
});

test('all enabled interface buttons receive a consistent hover treatment', () => {
    const css = fs.readFileSync(path.join(root, 'css/styles.css'), 'utf8');
    assert.ok(css.includes('button:not(:disabled):hover'));
    assert.ok(css.includes('transition-duration: 160ms;'));
    assert.ok(css.includes('filter: brightness(1.035);'));
    assert.ok(css.includes('transform: translateY(-1px);'));
    assert.ok(css.includes('.btn-add-cart:focus-visible'));
});
