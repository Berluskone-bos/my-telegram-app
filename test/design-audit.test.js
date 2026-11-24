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
