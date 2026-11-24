'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

test('повторно отправляемый заказ не считается закреплённым по старой failed-остановке', () => {
    assert.match(adminHtml, /if \(!\['assigned', 'in_progress'\]\.includes\(route\.status\)\) continue;/);
    assert.match(adminHtml, /\['pending', 'accepted', 'in_progress'\]\.includes\(stop\.status\)/);
    assert.doesNotMatch(adminHtml, /s\.status !== 'transferred'/);
});

test('выбор заказов и курьера сохраняется при повторной загрузке таблицы', () => {
    assert.match(adminHtml, /const selectedRouteOrderIds = new Set\(\)/);
    assert.match(adminHtml, /selectedRouteOrderIds\.has\(String\(o\.id\)\)/);
    assert.match(adminHtml, /selectedRouteCourierId/);
    assert.match(adminHtml, /requestSequence !== shopOrdersLoadSequence/);
    assert.match(adminHtml, /const ids = \[\.\.\.selectedRouteOrderIds\]/);
});

test('ошибка загрузки списка курьеров показывается диспетчеру, а не маскируется пустым выбором', () => {
    assert.match(adminHtml, /Не удалось загрузить список курьеров/);
    assert.match(adminHtml, /Ошибка загрузки курьеров — обновите данные/);
    assert.match(adminHtml, /Нет активных курьеров/);
});

test('рендер таблицы объявляет номер заказа до использования в доступных подписях', () => {
    const start = adminHtml.indexOf(': orders.map(o => {');
    const end = adminHtml.indexOf('const pager =', start);
    assert.ok(start >= 0 && end > start, 'renderer заказов должен быть найден');
    const renderer = adminHtml.slice(start, end);
    assert.match(renderer, /const num = esc\(o\.order_number \|\| 'AP-' \+ o\.id\);/);
    assert.match(renderer, /aria-label="Добавить заказ \$\{num\} в маршрут"/);
    assert.match(renderer, /aria-label="Статус заказа \$\{num\}"/);
});

test('успешное изменение статуса показывает отдельное подтверждение для каждого этапа', () => {
    assert.match(adminHtml, /CONFIRMED: 'Заказ подтверждён'/);
    assert.match(adminHtml, /ASSEMBLING: 'Заказ передан в сборку'/);
    assert.match(adminHtml, /READY_FOR_SHIPMENT: 'Заказ готов к отправке'/);
    assert.match(adminHtml, /READY_FOR_PICKUP: 'Заказ готов к выдаче'/);
    assert.match(adminHtml, /PICKED_UP: 'Заказ выдан клиенту'/);
    assert.match(adminHtml, /CANCELLED: 'Заказ отменён'/);
    assert.match(adminHtml, /else toast\(\(statusMessages\[status\] \|\| 'Статус заказа обновлён'\) \+ ' · ' \+ orderLabel, false\)/);
    assert.match(adminHtml, /if \(to === 'DELIVERED' && !confirm\(/);
    assert.match(adminHtml, /if \(confirm\('Отменить заказ '/);
});
