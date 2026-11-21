'use strict';
// Карточка маршрута курьера — чистые функции, база и Telegram не нужны.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRouteCard, buildReasonPicker, REASONS } = require('../bot/courier-card');

const stop = (n, extra = {}) => ({ id: 100 + n, stop_number: n, order_number: 'AP-' + n, address: `Адрес ${n}`, status: 'in_progress', stage: null, lat: 59.9 + n / 100, lon: 30.3 + n / 100, ...extra });
const route = (stops, status = 'in_progress') => ({ id: 7, route_number: 'RL-7', status, stops });
const data = (card) => card.keyboard.flat().map(b => b.callback_data).filter(Boolean);

test('карточка: номера точек не сдвигаются, когда соседи доставлены или не доставлены', () => {
    const c = buildRouteCard(route([stop(1, { status: 'failed', fail_reason: 'Клиента нет дома' }), stop(2, { status: 'delivered' }), stop(3), stop(4)]));
    assert.match(c.text, /1\. <b>AP-1<\/b>[^\n]*\n\s+НЕ ДОСТАВЛЕН \(Клиента нет дома\)/);
    assert.match(c.text, /2\. <b>AP-2<\/b>[^\n]*\n\s+доставлен/);
    assert.match(c.text, /Заказов: 4 · доставлено: 1 · не доставлено: 1 · осталось: 2/);
    assert.match(c.text, /Сейчас: заказ 3 из 4/);
    assert.equal(c.focusId, 103);
    assert.deepEqual(data(c).filter(d => d.startsWith('pickstop_')), ['pickstop_7_104'], 'выбрать можно только активные заказы');
});

test('карточка: шаги «В пути» → «У клиента» → «Доставлен» и выбор заказа', () => {
    assert.ok(data(buildRouteCard(route([stop(1), stop(2)]))).includes('deliver_7_101_enroute'));
    assert.ok(data(buildRouteCard(route([stop(1, { stage: 'enroute' }), stop(2)]))).includes('deliver_7_101_arrived'));
    assert.ok(data(buildRouteCard(route([stop(1, { stage: 'arrived' }), stop(2)]))).includes('deliver_7_101_done'));
    // выбранный курьером заказ становится текущим
    const c = buildRouteCard(route([stop(1), stop(2), stop(3)]), 102);
    assert.equal(c.focusId, 102);
    assert.ok(data(c).includes('failed_7_102'));
    // курьер уже у клиента — он остаётся текущим, пока курьер не выбрал другой
    assert.equal(buildRouteCard(route([stop(1), stop(2, { stage: 'arrived' })])).focusId, 102);
});

test('карточка: маршрут не начат — только ссылки, без кнопок доставки; завершён — итог', () => {
    const notStarted = buildRouteCard(route([stop(1, { status: 'accepted' }), stop(2, { status: 'accepted' })], 'assigned'));
    assert.deepEqual(data(notStarted), []);
    assert.match(notStarted.text, /ещё не начат/);
    const done = buildRouteCard(route([stop(1, { status: 'delivered' }), stop(2, { status: 'failed', fail_reason: 'Неверный адрес' })], 'completed'));
    assert.match(done.text, /Маршрут завершён\.<\/b> Доставлено: 1, не доставлено: 1/);
    assert.equal(done.focusId, null);
    assert.deepEqual(data(done), []);
});

test('причины недоставки: короткие коды (лимит Telegram 64 байта), есть «Другое» и «Назад»', () => {
    const p = buildReasonPicker(route([stop(1)]), 101);
    const codes = data({ keyboard: p.keyboard });
    for (const key of Object.keys(REASONS)) assert.ok(codes.includes(`failreason_7_101_${key}`));
    assert.ok(codes.includes('failreason_7_101_other'));
    assert.ok(codes.includes('pickstop_7_101'), '«Назад» не отмечает заказ');
    for (const d of codes) assert.ok(Buffer.byteLength(d) <= 64, d);
    assert.match(p.text, /почему не доставлен/);
});
