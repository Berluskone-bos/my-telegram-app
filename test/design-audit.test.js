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
  assert.match(products, /class="product-title-button" aria-label="Подробнее о товаре/);
  assert.doesNotMatch(products, /class="product-title-button" onclick=/);
  assert.match(app, /productGrid\?\.addEventListener\('pointerup'/);
  assert.match(app, /getCardFromEvent/);
  assert.match(app, /openProductFromEvent\(event\)/);
  assert.match(app, /this\.showProduct\(productId\)/);
  assert.match(app, /_productPointerOpenedAt/);
  assert.match(app, /document\.addEventListener\('click',[\s\S]*?openProductFromEvent\(event\)/);
  assert.match(app, /\}, true\);/);
  assert.match(products, /class="btn-buy" data-product-id=/);
  assert.match(products, /aria-pressed="\$\{isFavorite \? 'true' : 'false'\}"/);
  assert.match(css, /\.favorite-btn,[\s\S]*?\.btn-buy \{[\s\S]*?min-width: 44px/);
  assert.match(css, /\.select-oil-banner:focus-visible,[\s\S]*?\.nav-item:focus-visible/);

  assert.doesNotMatch(products, /class="btn-buy" onclick=/);
  assert.match(app, /\.btn-buy\[data-product-id=/);
  assert.match(html, /id="btn-nav-main" data-screen="main"/);
});
test('карточка товара управляет фокусом при открытии и возврате', () => {
  const app = read('js/app.js');
  const products = read('js/products.js');
  assert.match(products, /<h1 class="product-detail-name" tabindex="-1">/);
  assert.match(app, /this\._productReturnProductId = productId;[\s\S]*?this\.showProduct\(productId\)/);
  assert.match(app, /container\.querySelector\('\.product-detail-name'\)\?\.focus\(\)/);
  assert.match(app, /const returnProductId = this\._productReturnProductId;[\s\S]*?\.product-title-button/);
  assert.match(app, /returnTarget \|\| document\.getElementById\('searchInput'\)/);
  assert.match(app, /this\._productReturnProductId = null;/);
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
  assert.match(html, /id="staffModal" class="staff-modal-overlay" aria-hidden="true"/);
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


test('динамические элементы заказов имеют доступные имена', () => {
  const html = read('admin.html');
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
  assert.match(html, /\.route-pick-target \{[^}]*min-width: 44px; min-height: 44px/);
  assert.ok(html.includes('<label class="route-pick-target" onclick="event.stopPropagation()">'));
  assert.ok(html.includes('.route-pick-target input { width: 18px; height: 18px; cursor: pointer; }'));
  assert.match(html, /\.bcard-pick \{[^}]*min-height: 44px/);
  assert.match(html, /\.form-input, \.form-select, \.form-textarea \{\s*width: 100%;\s*min-height: 44px/);
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*?\.btn, \.status-select, \.icon-btn, \.me-out, \.theme-btn \{ min-height: 44px; \}/);
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


test('главная не показывает неподтверждённые акции и содержит понятные возможности магазина', () => {
  const html = read('index.html');
  assert.match(html, /class="home-proof-strip" role="group" aria-label="Возможности AutoPromoil"/);
  assert.match(html, /Подбор по авто/);
  assert.match(html, /Проверка допусков/);
  assert.match(html, /Новости и полезные материалы AutoPromoil/);
  assert.doesNotMatch(html, /Скидка 15% на первый заказ|Бесплатно от 5 000 ₽/);
  assert.match(html, /class="dot active" aria-label="Показать слайд 1" aria-pressed="true"/);
  assert.match(html, /prefers-reduced-motion: reduce/);
});

test('каталог показывает до двух допусков из админки и не меняет кнопку покупки', () => {
  const products = read('js/products.js');
  const css = read('css/styles.css');
  assert.match(products, /const approvalSource = Array\.isArray\(product\.approvals\)/);
  assert.match(products, /approvals\.slice\(0, 2\)/);
  assert.match(products, /product-approval-more/);
  assert.match(products, /aria-label="Основные допуски:/);
  assert.match(css, /\.product-approval-chip,[\s\S]*?background: #E5F7FA;[\s\S]*?color: #00707F;/);
  assert.match(css, /\.btn-buy\s*\{[^}]*width: 44px;[^}]*height: 44px;[^}]*border-radius: 10px;/);
});


test('карточки каталога сохраняют читаемую типографику на узких экранах', () => {
  const css = read('css/styles.css');
  assert.ok(css.includes('.product-title {\n    font-size: 13px;'));
  assert.ok(css.includes('font-size: 10px;\n    font-weight: 700;\n    line-height: 1.2;\n    min-height: 20px;'));
  const smallPhone = css.slice(css.indexOf('@media (max-width: 360px) {'), css.indexOf('/* Стандартные смартфоны'));
  const standardPhone = css.slice(css.indexOf('@media (min-width: 361px) and (max-width: 420px) {'), css.indexOf('/* Большие смартфоны'));
  const tablet = css.slice(css.indexOf('@media (min-width: 600px) {'), css.indexOf('/* Большие планшеты'));
  assert.ok(smallPhone.includes('.product-title { font-size: 12px; min-height: 30px; }'));
  assert.ok(standardPhone.includes('.product-title { font-size: 13px; min-height: 33px; }'));
  assert.ok(tablet.includes('.product-title { font-size: 14px; min-height: 35px; }'));
});

test('панель фильтров работает как доступный модальный диалог', () => {
  const html = read('index.html');
  const app = read('js/app.js');
  const css = read('css/styles.css');
  assert.match(html, /id="filterToggle" aria-controls="filterPanel" aria-expanded="false"/);
  assert.match(html, /id="filterPanel" role="dialog" aria-modal="true" aria-labelledby="filterPanelTitle" aria-hidden="true" inert/);
  assert.match(html, /id="filterPanelTitle">Фильтры/);
  assert.match(html, /class="filter-close" aria-label="Закрыть фильтры"/);
  assert.match(app, /event\.key === 'Escape'[\s\S]*?this\.toggleFilter\(false\)/);
  assert.match(app, /event\.key !== 'Tab'[\s\S]*?focusable/);
  assert.match(app, /panel\.inert = false[\s\S]*?filter-close.*?focus\(\)/);
  assert.match(app, /panel\.inert = true[\s\S]*?trigger\?\.focus\(\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});


test('окно редактирования профиля доступно с клавиатуры и возвращает фокус', () => {
  const indexHtml = read('index.html');
  const appJs = read('js/app.js');
  const css = read('css/styles.css');

  assert.match(indexHtml, /id="modalProfile" role="dialog" aria-modal="true" aria-labelledby="modalProfileTitle" aria-describedby="modalProfileDescription" aria-hidden="true" inert tabindex="-1"/);
  assert.match(indexHtml, /<h3 class="modal-title" id="modalProfileTitle">Мои данные<\/h3>/);
  assert.match(indexHtml, /<label for="modalProfileName">/);
  assert.match(indexHtml, /<label for="modalProfilePhone">/);
  assert.match(indexHtml, /id="modalProfileDescription"/);
  assert.match(appJs, /this\.openModal\('modalProfile'\)/);
  assert.match(appJs, /_modalReturnFocus = document\.activeElement/);
  assert.match(appJs, /modal\.inert = false/);
  assert.match(appJs, /modal\.setAttribute\('aria-hidden', 'false'\)/);
  assert.match(appJs, /event\.key === 'Escape'[\s\S]*?closeModal\('modalProfile'\)/);
  assert.match(appJs, /event\.key !== 'Tab'[\s\S]*?focusable/);
  assert.match(appJs, /event\.target === profileModal[\s\S]*?closeModal\('modalProfile'\)/);
  assert.match(appJs, /returnFocus\.focus\(\)/);
  assert.match(css, /\.modal-btn:focus-visible\s*\{[^}]*outline: 3px solid var\(--accent-text\)/);
});



test('подробная карточка товара содержит только одну кнопку добавления в корзину', () => {
  const products = read('js/products.js');
  const css = read('css/styles.css');
  const detail = products.slice(products.indexOf('    renderDetail(product)'));
  assert.doesNotMatch(detail, /Добавить в корзину:<\/button>/);
  assert.match(detail, /product-detail-sticky-add/);
  assert.match(detail, /\$\{stickyButton\}/);
  assert.equal(detail.includes('class="btn-add-cart ${inCart ?'), false);
  assert.match(css, /\.product-detail-sticky-purchase\s*\{[^}]*display: flex/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.product-detail-sticky-purchase\s*\{[^}]*position: fixed/);
});
test('поля оформления заказа имеют программно связанные подписи', () => {
  const html = read('index.html');
  const fieldIds = [
    'orderName', 'orderPhone', 'orderCity', 'orderStreet', 'orderHouse',
    'orderBuilding', 'orderStructure', 'orderLetter', 'orderEntrance',
    'orderFloor', 'orderApartment', 'orderComment', 'orderPayment'
  ];

  for (const id of fieldIds) {
    assert.match(html, new RegExp('<label\\s+for="' + id + '">'));
  }

  assert.match(html, /id="deliveryTypeLabel">Способ получения:<\/label>/);
  assert.match(html, /class="delivery-toggle" role="group" aria-labelledby="deliveryTypeLabel"/);
  assert.match(html, /aria-labelledby="orderZoneLabel zoneSelectLabel"/);
  assert.match(html, /<label class="radio-label active" id="labelDelivery">[\s\S]*?<input type="radio" name="deliveryType"/);
  assert.match(html, /<label class="radio-label" id="labelPickup">[\s\S]*?<input type="radio" name="deliveryType"/);
});

test('переключатель способа получения и регион доступны с клавиатуры', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.radio-label input\[type="radio"\]\s*\{[^}]*position: absolute;[^}]*clip-path: inset\(50%\);/);
  assert.match(css, /\.radio-label:focus-within\s*\{[^}]*outline: 3px solid var\(--accent-text\)/);
  assert.match(css, /\.custom-select-btn:focus-visible\s*\{[^}]*outline: 3px solid var\(--accent-text\)/);
});


test('окно сотрудников удобно использовать на мобильных экранах', () => {
  const html = read('admin.html');
  assert.match(html, /id="staffModal" class="staff-modal-overlay"/);
  assert.match(html, /class="staff-modal-dialog" role="dialog" aria-modal="true"/);
  assert.match(html, /class="staff-form-control" name="displayName"/);
  assert.match(html, /class="staff-form-control" name="login"/);
  assert.match(html, /class="staff-form-control" name="password"/);
  assert.match(html, /#staffModal \.staff-modal-dialog \{[\s\S]*?max-height: calc\(100dvh - env\(safe-area-inset-top\)/);
  assert.match(html, /#staffModal \.staff-form-control,[\s\S]*?min-height: 44px/);
  assert.match(html, /#staffModal \.staff-modal-close,[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px/);
  assert.match(html, /#staffModal label:has\(\.staff-active\) \{[\s\S]*?min-height: 44px/);
  assert.match(html, /@media \(max-width: 600px\)[\s\S]*?#staffModal \.staff-create-form \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
});

test('склад показывает миниатюру фотографии товара слева от ID', () => {
  const html = read('admin.html');
  const stockTable = html.slice(html.indexOf('<table aria-label="Каталог товаров и остатки">'));
  const headerRow = stockTable.slice(0, stockTable.indexOf('</thead>'));
  assert.match(headerRow, /<th scope="col">ID<\/th>\s*<th scope="col" aria-label="Фотография"><\/th>/);
  assert.match(html, /<td>\$\{esc\(p\.id \|\| '-'\)\}<\/td>\s*<td class="product-thumb-cell">\$\{imageCell\}<\/td>/);
  assert.match(html, /const image = typeof p\.image === 'string' \? p\.image\.trim\(\) : ''/);
  assert.match(html, /class="product-thumb-cell">\$\{imageCell\}/);
  assert.match(html, /loading="lazy" decoding="async"/);
  assert.match(html, /this\.hidden=true;this\.nextElementSibling\.hidden=false/);
  assert.match(html, /product-thumb-placeholder/);
  assert.match(html, /shopProductsTable"><tr><td colspan="8"/);
  assert.match(html, /setTableState\('shopProductsTable', 8,/);
});

test('переключатель темы админ-панели открывает лампу с интерактивной верёвкой', () => {
  const html = read('admin.html');
  assert.match(html, /id="themeBtn"[^>]+aria-haspopup="dialog"[^>]+aria-controls="themePullOverlay"/);
  assert.match(html, /id="themePullOverlay"[^>]+aria-hidden="true" hidden/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="themePullTitle"/);
  assert.match(html, /id="themeLampPull"[^>]+aria-label="Потяните вниз за верёвку/);
  assert.match(html, /function toggleTheme\(\)[\s\S]*?overlay\.hidden = false/);
  assert.match(html, /function commitThemePull\(\)[\s\S]*?store\.set\('admTheme', next\)/);
  assert.match(html, /pull\.addEventListener\('pointerdown'/);
  assert.match(html, /pull\.addEventListener\('pointermove'/);
  assert.match(html, /distance >= 42/);
  assert.match(html, /event\.key === 'Escape'[\s\S]*?closeThemePull\(\)/);
  assert.match(html, /b\.setAttribute\('aria-label', 'Открыть переключатель темы'\)/);
  assert.match(html, /event\.key === 'Tab'[\s\S]*?focusable/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?theme-pull-dialog/);
  assert.match(html, /\.theme-pull-overlay\[hidden\] \{ display: none !important; \}/);
});


test('верёвка лампы растягивается без отрыва, окно закрывается через 1,5 секунды после переключения', () => {
  const html = read('admin.html');
  assert.match(html, /\.theme-lamp-pull\.is-pulling \.theme-lamp-string \{ height: calc\(83px \+ var\(--theme-pull-y, 0px\)\); \}/);
  assert.match(html, /\.theme-lamp-pull\.is-pulling \.theme-lamp-knob \{ top: calc\(78px \+ var\(--theme-pull-y, 0px\)\); \}/);
  assert.doesNotMatch(html, /\.theme-lamp-pull\.is-pulling \.theme-lamp-string, \.theme-lamp-pull\.is-pulling \.theme-lamp-knob \{ transform:/);
  assert.match(html, /themePullCloseTimer = window\.setTimeout\(\(\) => \{ themePullCloseTimer = null; closeThemePull\(\); \}, 1500\)/);
  assert.match(html, /function closeThemePull\(\)[\s\S]*?clearTimeout\(themePullCloseTimer\)/);
});


test('верхняя шапка админки использует лампу справа, без часов и отдельного календаря', () => {
  const html = read('admin.html');
  const topbar = html.slice(html.indexOf('<div class="topbar">'), html.indexOf('<!-- ==================== ВКЛАДКА: ДОСТАВКА'));
  assert.match(topbar, /id="themeBtn"/);
  assert.doesNotMatch(topbar, /id="clock"|id="clockBtn"|id="cal"/);
  assert.match(html, /\.theme-btn\s*\{[^}]*margin-left:\s*auto;/);
  assert.doesNotMatch(html, /\.clock-btn|\.clock-time|\.cal-nav|function tickClock|setInterval\(tickClock/);
  assert.match(html, /clip-path: polygon\(34% 0, 66% 0, 100% 100%, 0 100%\)/);
  assert.match(html, /\.theme-lamp-shade span \{ position: absolute; left: 0; right: 0; bottom: -1px;/);
  assert.match(html, /id="tab-delivery"/);
});


test('шапка магазина использует увеличенный логотип и мягкий объёмный фон', () => {
  const html = read('index.html');
  const css = read('css/styles.css');
  assert.match(html, /css\/styles\.css\?v=20261128-premium-header/);
  assert.match(css, /\.header-logo-img\s*\{[^}]*height:\s*54px/);
  assert.match(css, /@media\s*\(max-width:\s*360px\)[\s\S]*?\.header-logo-img\s*\{\s*height:\s*54px/);
  assert.match(css, /\.header::before[\s\S]*?radial-gradient\(ellipse at 12% 125%/);
  assert.match(css, /\.header::after[\s\S]*?rgba\(0,175,199,0\.11\)/);
  assert.match(css, /\.header\s*\{[\s\S]*?isolation:\s*isolate/);
  assert.match(css, /\.header\s*>\s*\*\s*\{\s*position:\s*relative;\s*z-index:\s*1/);
  assert.match(css, /\.carousel-slide\s*\{[^}]*min-height:\s*132px/);
  assert.match(css, /\.promo-carousel\s*\{[^}]*margin:\s*8px 12px 4px/);
});
