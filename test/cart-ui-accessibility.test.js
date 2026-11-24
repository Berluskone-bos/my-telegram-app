'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cartJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'cart.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');

test('кнопки изменения количества имеют контекстные подписи и не отправляют форму', () => {
    assert.ok(cartJs.includes('role="group" aria-label="Товар в корзине: ${esc(prod.name)}"'));
    assert.ok(cartJs.includes('type="button" aria-label="Уменьшить количество или удалить товар: ${esc(prod.name)}"'));
    assert.ok(cartJs.includes('type="button" aria-label="Увеличить количество товара: ${esc(prod.name)}"'));
    assert.ok(cartJs.includes('<output class="qty" aria-label="Количество товара: ${esc(prod.name)}" aria-live="polite" aria-atomic="true">'));
});

test('кнопки количества имеют сенсорную область не менее 44×44 px и видимый фокус', () => {
    assert.match(css, /.cart-item-actions button\s*\{[^}]*width:\s*44px;[^}]*min-width:\s*44px;[^}]*height:\s*44px;[^}]*min-height:\s*44px;/);
    assert.match(css, /\.cart-item-actions button:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--accent-text\)/);
    assert.doesNotMatch(css, /\.cart-item-actions button\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;/);
});
