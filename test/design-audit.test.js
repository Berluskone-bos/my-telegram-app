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
  assert.match(css, /\.select-oil-banner:focus-visible,[\s\S]*?\.nav-item:focus-visible/);

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


test('модальные окна админ-панели управляют доступностью и фокусом', () => {
  const html = read('admin.html');
  assert.match(html, /id="orderModal" aria-hidden="true"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="orderModalTitle" tabindex="-1"/);
  assert.match(html, /id="productModal" aria-hidden="true"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="productModalTitle" tabindex="-1"/);
  assert.match(html, /function openModal\(id\)[\s\S]*?modalReturnFocus\.set\(id, document\.activeElement\)/);
  assert.match(html, /function closeModal\(id\)[\s\S]*?overlay\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(html, /event\.key === 'Escape'[\s\S]*?closeModal\(overlay\.id\)/);
  assert.match(html, /event\.key !== 'Tab'[\s\S]*?focusable/);
  assert.match(html, /event\.target\.classList\.contains\('modal-overlay'\)/);
  assert.match(html, /openModal\('orderModal'\)/);
  assert.match(html, /openModal\('productModal'\)/);
  assert.match(html, /id="staffModal" aria-hidden="true"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="staffModalTitle"/);

  for (const id of ['productBrand', 'productCategory', 'productName', 'productSku', 'productVolume',
    'productPrice', 'productOldPrice', 'productStock', 'productMinStock', 'productDescription',
    'productImage', 'productApprovals']) {
    assert.match(html, new RegExp('for="' + id + '"'));
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /aria-describedby="productApprovalsHelp"/);
  assert.match(html, /@media \(max-width: 600px\)[\s\S]*?max-height: calc\(100dvh/);
  assert.match(html, /\.modal-body \{[^}]*overflow-y: auto/);
});


test('таблицы админ-панели имеют доступные имена и адаптивную прокрутку', () => {
  const html = read('admin.html');
  const tables = [...html.matchAll(/<table\b[^>]*>/g)].map(match => match[0]);
  assert.equal(tables.length, 8);
  for (const table of tables) assert.match(table, /aria-label="[^"]+"/);
  assert.equal((html.match(/class="section-body table-scroll"/g) || []).length, 8);
  const headers = [...html.matchAll(/<th\b[^>]*>/g)].map(match => match[0]);
  assert.ok(headers.length > 0);
  for (const header of headers) assert.match(header, /scope="col"/);
  assert.match(html, /\.table-scroll table \{ min-width: 640px; \}/);
  assert.match(html, /#ordersTableWrap table \{ min-width: 920px; \}/);
  assert.match(html, /function setTableState\(id, colspan, message, state = 'error'\)/);
  assert.match(html, /role="status" aria-live="polite"/);
  for (const id of ['unassignedTable', 'routesTable', 'couriersTable', 'analyticsCouriersTable',
    'shopOrdersTable', 'shopProductsTable', 'shopCustomersTable', 'auditBody']) {
    assert.match(html, new RegExp("setTableState\\('" + id + "'"));
  }
  assert.match(html, /async function fetchAdminJson\(url, options\)[\s\S]*?if \(!response\.ok\) throw new Error/);
});


test('мобильное меню админ-панели скрывает закрытые элементы от клавиатуры', () => {
  const html = read('admin.html');
  assert.match(html, /<aside class="side" id="side"[^>]+aria-hidden="false" tabindex="-1"/);
  assert.match(html, /\.find\(element => element\.getClientRects\(\)\.length > 0\)/);
  assert.match(html, /class="icon-btn burger"[^>]+aria-expanded="false" aria-controls="side"/);
  assert.match(html, /const drawerMedia = window\.matchMedia\('\(max-width: 900px\)'\)/);
  assert.match(html, /side\.inert = mobile && !open/);
  assert.match(html, /side\.setAttribute\('aria-hidden', String\(mobile && !open\)\)/);
  assert.match(html, /function openDrawer\(\)[\s\S]*?syncDrawerAccessibility\(\)[\s\S]*?\.focus\(\)/);
  assert.match(html, /function closeDrawer\(restoreFocus = true\)[\s\S]*?\.burger'\)\?\.focus\(\)/);
  assert.match(html, /event\.key === 'Escape'[\s\S]*?closeDrawer\(\)/);
  assert.match(html, /event\.key !== 'Tab'[\s\S]*?focusable/);
  assert.match(html, /onDrawerBreakpointChange/);
});

test('форма входа админ-панели имеет подписи, отправку по Enter и доступную ошибку', () => {
  const html = read('admin.html');
  assert.match(html, /<form id="adminLoginForm"[^>]+onsubmit="adminLogin\(event\)"/);
  assert.match(html, /<label class="auth-label" for="adminLoginName">/);
  assert.match(html, /<label class="auth-label" for="adminPass">/);
  assert.match(html, /id="adminPass"[^>]+required/);
  assert.match(html, /id="loginError" role="alert" aria-live="assertive" hidden/);
  assert.match(html, /button\.disabled = true;[\s\S]*?button\.textContent = 'Входим…'/);
  assert.match(html, /error\.textContent = j\.error \|\| 'Не удалось войти/);
  assert.doesNotMatch(html, /addEventListener\('keydown',[\s\S]{0,180}adminLogin\(\)/);
});


test('календарь и динамические элементы заказов имеют доступные имена', () => {
  const html = read('admin.html');
  assert.match(html, /id="cal" role="dialog" aria-labelledby="calTitle" aria-label="Календарь на месяц" aria-hidden="true"/);
  assert.match(html, /function openCal\(\)[\s\S]*?calEl\.setAttribute\('aria-hidden', 'false'\)/);
  assert.match(html, /function closeCal\(refocus\)[\s\S]*?calEl\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(html, /id="routeCourier"[^>]+aria-label="Курьер для нового маршрута"/);
  assert.match(html, /aria-label="Новый курьер для маршрута ' \+ esc\(r\.route_number\)/);
  assert.match(html, /aria-label="Причина передачи маршрута ' \+ esc\(r\.route_number\)/);
  assert.match(html, /aria-label="Место передачи заказов маршрута ' \+ esc\(r\.route_number\)/);
  assert.match(html, /aria-label="Статус заказа \$\{num\}"/);
  assert.match(html, /aria-label="Добавить заказ \$\{num\} в маршрут"/);
  assert.match(html, /aria-label="Отменить заказ \$\{num\}"/);
  assert.match(html, /aria-label="Изменить товар \$\{esc\(p\.name \|\| p\.id\)\}"/);
  assert.match(html, /aria-label="Удалить курьера ' \+ esc\(c\.name\)/);
});


test('админ-панель использует удобные сенсорные области на мобильных экранах', () => {
  const html = read('admin.html');
  assert.match(html, /\.btn \{\s*min-height: 40px/);
  assert.match(html, /\.status-select \{\s*min-height: 40px/);
  assert.match(html, /\.icon-btn \{ flex: none; width: 44px; height: 44px;/);
  assert.match(html, /\.me-out \{ flex: none; width: 44px; height: 44px;/);
  assert.match(html, /\.cal-nav \{ width: 44px; height: 44px;/);
  assert.match(html, /\.route-pick-target \{[^}]*min-width: 44px; min-height: 44px/);
  assert.ok(html.includes('<label class="route-pick-target" onclick="event.stopPropagation()">'));
  assert.ok(html.includes('.route-pick-target input { width: 18px; height: 18px; cursor: pointer; }'));
  assert.match(html, /\.bcard-pick \{[^}]*min-height: 44px/);
  assert.match(html, /\.form-input, \.form-select, \.form-textarea \{\s*width: 100%;\s*min-height: 44px/);
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*?\.btn, \.status-select, \.icon-btn, \.me-out, \.cal-nav, \.cal-today, \.theme-btn, \.clock-btn \{ min-height: 44px; \}/);
  assert.match(html, /\.btn-sm \{ min-height: 44px; padding: 8px 12px; \}/);
});


test('контраст текста на акцентных элементах соответствует WCAG AA', () => {
  const css = read('css/styles.css');
  const admin = read('admin.html');
  const luminance = hex => {
    const rgb = hex.match(/[a-f\d]{2}/gi).map(pair => parseInt(pair, 16) / 255);
    const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const ratio = (a, b) => {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  assert.ok(ratio('#101B4D', '#00AFC7') >= 4.5);
  assert.ok(ratio('#101B4D', '#1FC3DB') >= 4.5);
  assert.ok(ratio('#007A8C', '#FFFFFF') >= 4.5);
  assert.match(css, /--accent-text: #007A8C;/);
  assert.doesNotMatch(css, /background: var\(--accent\);[^}]*color: #fff;/);
  assert.match(css, /\.btn-order \{[^}]*color: #101B4D;/);
  assert.match(css, /\.btn-buy \{[^}]*color: #101B4D;/);
  assert.match(admin, /\.btn-primary \{ background: var\(--cyan\); color: #101B4D; \}/);
  assert.match(admin, /\.badge-blue \{[^}]*color: var\(--cyan-text\);/);
  assert.doesNotMatch(admin, /background: var\(--cyan\); color: var\(--white\);/);
});


test('иконки карточек товара имеют достаточный контраст на своих фонах', () => {
  const css = read('css/styles.css');
  const products = read('js/products.js');
  assert.match(css, /\.btn-buy i,[\s\S]*?color: var\(--navy\);[\s\S]*?stroke: var\(--navy\);/);
  assert.match(css, /\.btn-buy\.added i,[\s\S]*?color: #fff;[\s\S]*?stroke: #fff;/);
  assert.match(css, /\.favorite-btn i,[\s\S]*?color: var\(--text-secondary\);[\s\S]*?stroke: var\(--text-secondary\);/);
  assert.match(products, /aria-label="\$\{isFavorite \? 'Убрать из избранного: ' \+ esc\(product\.name\)/);
  assert.match(products, /aria-pressed="\$\{isFavorite \? 'true' : 'false'\}"/);
});

test('кнопки избранного и корзины сохраняют сенсорную область не менее 44×44 px', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.favorite-btn,[\s\S]*?\.btn-buy\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.favorite-btn,[\s\S]*?\.btn-buy\s*\{[^}]*min-width:\s*44px/);
  assert.match(css, /\.product-detail-fav\s*\{[^}]*width:\s*44px;[^}]*min-width:\s*44px;[^}]*height:\s*44px;[^}]*min-height:\s*44px;/);
  assert.doesNotMatch(css, /\.btn-buy\s*\{\s*width:\s*30px;\s*height:\s*30px;/);
});
