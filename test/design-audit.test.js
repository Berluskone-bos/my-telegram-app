'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('магазин не блокирует масштабирование страницы', () => {
  const html = read('index.html');
  const viewport = html.match(/<meta[^>]+name=["']viewport["'][^>]*>/i)?.[0] || '';
  assert.ok(viewport);
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(viewport, /maximum-scale\s*=\s*1(?:\.0)?(?:[,;\s]|$)/i);
  assert.doesNotMatch(viewport.match(/content=["']([^"']*)["']/i)?.[1] || "", /,\s*$/);
});
test('основные кнопки шапки магазина имеют семантику кнопок и доступные размеры', () => {
  const html = read('index.html'), css = read('css/styles.css');
  assert.match(html, /<button[^>]+class=["']burger-btn["']/);
  assert.match(html, /<button[^>]+class=["']header-icon["']/);
  assert.match(css, /\.burger-btn[\s\S]*?min-width:\s*44px/);
  assert.match(css, /\.header-icon[\s\S]*?min-height:\s*44px/);
});
test('магазин поддерживает prefers-reduced-motion', () => {
  const css = read('css/styles.css');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /animation-duration:\s*\.01ms\s*!important/);
});
test('светлые токены админ-панели не содержат циклических ссылок', () => {
  const html = read('admin.html');
  assert.match(html, /--tint:\s*rgba\(16,27,77,0\.04\)/);
  assert.match(html, /--tint-2:\s*rgba\(16,27,77,0\.08\)/);
  assert.doesNotMatch(html, /--tint:\s*var\(--tint\)/);
  assert.doesNotMatch(html, /--tint-2:\s*var\(--tint-2\)/);
});

test('управление магазином использует семантические кнопки и состояние выбора', () => {
  const html = read('index.html');
  const app = read('js/app.js');
  const products = read('js/products.js');
  assert.match(html, /<button[^>]+class="cat-badge active"[^>]+aria-pressed="true"/);
  assert.match(html, /<nav class="bottom-nav" aria-label="Основная навигация">/);
  assert.match(html, /id="sortToggle" aria-controls="sortMenu" aria-expanded="false"/);
  assert.match(app, /setAttribute\('aria-expanded', String\(isOpen\)\)/);
  assert.match(app, /menu\.setAttribute\('aria-hidden', String\(!open\)\)/);
  assert.match(app, /this\.currentSubcategory = null;/);
  assert.match(html, /<button[^>]+class="nav-item active"[^>]+aria-current="page"/);
  assert.match(html, /<button[^>]+class="sort-option active"[^>]+aria-pressed="true"/);
  assert.match(app, /setAttribute\('aria-current', 'page'\)/);
  assert.match(app, /setAttribute\('aria-pressed', String\(active\)\)/);
  assert.doesNotMatch(app, /container\.addEventListener\('click'/);
  assert.match(products, /<article class="product-card[^>]+data-product-id=/);
  assert.doesNotMatch(products, /class="product-card[^>]+onclick=/);
  assert.match(products, /class="btn-buy" data-product-id=/);
  assert.doesNotMatch(products, /class="btn-buy" onclick=/);
  assert.match(html, /id="btn-nav-main" data-screen="main"/);
});
test('правила темы разделяют магазин и админ-панель', () => {
  const agents = read('AGENTS.md');
  const audit = read('docs/DESIGN_AUDIT.md');
  assert.match(agents, /магазин \(Mini App\) поддерживает только светлую тему; админ-панель поддерживает светлую и тёмную темы/);
  assert.match(audit, /Админ-панель должна поддерживать две темы/);
});
