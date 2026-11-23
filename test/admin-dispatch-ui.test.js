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
