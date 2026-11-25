'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const productsJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'products.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('загрузка каталога различает готовое состояние, пустой каталог и ошибку', () => {
    assert.ok(productsJs.includes("loadState: 'loading'"));
    assert.ok(productsJs.includes("this.loadState = 'ready'"));
    assert.ok(productsJs.includes("this.loadState = this.data.length > 0 ? 'ready' : 'empty'"));
    assert.ok(productsJs.includes("this.loadState = 'error'"));
});

test('при открытии приложения сразу показывается состояние загрузки', () => {
    assert.ok(appJs.includes('this.renderProducts();\n        // Загружаем данные\n        await Products.load();'));
    assert.ok(appJs.includes('Загружаем каталог'));
    assert.ok(appJs.includes('aria-live="polite"'));
});

test('ошибка каталога показывает доступный повтор загрузки', () => {
    assert.ok(appJs.includes('Не удалось загрузить каталог'));
    assert.ok(appJs.includes('App.retryCatalogLoad()'));
    assert.ok(appJs.includes('async retryCatalogLoad()'));
    assert.ok(appJs.includes('Повторить загрузку'));
});

test('пустой каталог и пустая выдача фильтров имеют разные сообщения', () => {
    assert.ok(appJs.includes('Каталог пока пуст'));
    assert.ok(appJs.includes('catalog-state-filtered'));
    assert.ok(appJs.includes('Товары не найдены'));
});

test('состояния каталога адаптивны, имеют клавиатурный фокус и учитывают reduced motion', () => {
    assert.ok(css.includes('.catalog-state {'));
    assert.ok(css.includes('min-height: 44px;'));
    assert.ok(css.includes('.catalog-state-action:focus-visible'));
    assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
});

test('ресурсы каталога обновляют версии кеша Telegram WebView', () => {
    assert.ok(indexHtml.includes('css/styles.css?v=20261125-filter-accessibility'));
    assert.ok(indexHtml.includes('js/products.js?v=20261125-catalog-states'));
    assert.ok(indexHtml.includes('js/app.js?v=20261125-filter-accessibility'));
});
