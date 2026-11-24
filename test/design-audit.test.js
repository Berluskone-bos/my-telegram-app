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
  const css = read('css/styles.css');
  assert.match(html, /<button[^>]+class="cat-badge active"[^>]+aria-pressed="true"/);
  assert.match(html, /<nav class="bottom-nav" aria-label="Основная навигация">/);
  assert.match(html, /<button[^>]+class="select-oil-banner"/);
  assert.match(html, /class="select-oil-banner"[\s\S]*?<span class="select-oil-copy">[\s\S]*?<\/button>/);
  assert.match(html, /id="zoneSelectToggle"[^>]+aria-expanded="false"/);
  assert.match(html, /class="custom-select-option active"[^>]+aria-pressed="true"/);
  assert.match(app, /setAttribute\('aria-pressed', String\(active\)\)/);
  assert.match(app, /zoneSelectToggle[^\n]+setAttribute\('aria-expanded', 'false'\)/);
  assert.match(app, /zoneMenu\.classList\.remove\('open'\);\s*document\.getElementById\('zoneSelectToggle'\)/);
  assert.match(html, /id="sortToggle" aria-controls="sortMenu" aria-expanded="false"/);
  assert.match(app, /setAttribute\('aria-expanded', String\(isOpen\)\)/);
  assert.match(app, /setAttribute\('aria-expanded', 'false'\)/);
  assert.match(app, /menu\.setAttribute\('aria-hidden', String\(!open\)\)/);
  assert.match(app, /menu\.inert = !open/);
  assert.match(html, /id="sideMenu" aria-hidden="true" inert/);
  assert.match(app, /this\.currentSubcategory = null;/);
  assert.match(app, /this\.renderSubcategories\(\);\s*this\.renderProducts\(\);/);
  assert.match(html, /<button[^>]+class="nav-item active"[^>]+aria-current="page"/);
  assert.match(html, /<button[^>]+class="sort-option active"[^>]+aria-pressed="true"/);
  assert.match(app, /setAttribute\('aria-current', 'page'\)/);
  assert.match(app, /setAttribute\('aria-pressed', String\(active\)\)/);
  assert.match(app, /class="filter-chip \$\{isActive \? 'active' : ''\}" data-value=/);
  assert.match(app, /chip\.setAttribute\('aria-pressed', String\(active\)\)/);

  assert.doesNotMatch(app, /container\.addEventListener\('click'/);
  assert.match(products, /<article class="product-card[^>]+data-product-id=/);
  assert.doesNotMatch(products, /class="product-card[^>]+onclick=/);
  assert.match(products, /class="product-title-button" onclick="App\.showProduct/);
  assert.match(products, /class="btn-buy" data-product-id=/);
  assert.match(products, /aria-pressed="\$\{isFavorite \? 'true' : 'false'\}"/);
  assert.match(css, /\.favorite-btn,[\s\S]*?\.btn-buy \{[\s\S]*?min-width: 44px/);

  assert.doesNotMatch(products, /class="btn-buy" onclick=/);
  assert.match(app, /\.btn-buy\[data-product-id=/);
  assert.match(html, /id="btn-nav-main" data-screen="main"/);
});
test('правила темы разделяют магазин и админ-панель', () => {
  const agents = read('AGENTS.md');
  const audit = read('docs/DESIGN_AUDIT.md');
  assert.match(agents, /магазин \(Mini App\) поддерживает только светлую тему; админ-панель поддерживает светлую и тёмную темы/);
  assert.match(audit, /Админ-панель должна поддерживать две темы/);
});

test('админ-панель сохраняет светлую и тёмную темы', () => {
  const html = read('admin.html');
  const light = html.match(/:root\s*\{([\s\S]*?)\n\s*\}/)?.[1] || '';
  const dark = html.match(/:root\[data-theme=["']dark["']\]\s*\{([\s\S]*?)\n\s*\}/)?.[1] || '';
  const lightTokens = [...light.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]);
  const darkTokens = new Set([...dark.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  assert.ok(lightTokens.length > 0);
  assert.ok(darkTokens.size > 0);
  for (const token of lightTokens) assert.ok(darkTokens.has(token), `Нет тёмного значения для ${token}`);
  assert.match(html, /store\.set\('admTheme', next\)/);
  assert.match(html, /b\.setAttribute\('aria-pressed', dark \? 'true' : 'false'\)/);
});
