'use strict';
// Чистая логика графика заказов (без базы): разбор периода, выбор шага, группировка по неделям и месяцам.
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupSeries, autoGroup, parseRange, dayNum, dayStr } = require('../bot/order-stats');

const rows = (from, n, f = () => 1) => Array.from({ length: n }, (_, i) => ({ day: dayStr(dayNum(from) + i), orders: f(i), revenue: 100 * f(i), cancelled: 0 }));

test('даты: несуществующие и кривые отклоняются, а не переносятся', () => {
    assert.equal(dayNum('2026-02-31'), null);
    assert.equal(dayNum('2026-13-01'), null);
    assert.equal(dayNum('16.11.2026'), null);
    assert.equal(dayNum(undefined), null);
    assert.equal(dayStr(dayNum('2026-03-01') - 1), '2026-02-28');
    assert.equal(dayStr(dayNum('2028-03-01') - 1), '2028-02-29');
});

test('период: порядок дат, длина, предел', () => {
    assert.equal(parseRange({ from: '2026-11-01', to: '2026-11-30' }).days, 30);
    assert.ok(parseRange({ from: '2026-11-30', to: '2026-11-01' }).error);
    assert.ok(parseRange({ from: '2026-11-01' }).error);
    assert.ok(parseRange({ from: '2000-01-01', to: '2026-11-01' }).error, 'больше 10 лет — отказ');
    assert.equal(parseRange({ from: '2026-11-16', to: '2026-11-16' }).days, 1);
});

test('шаг графика: до 62 дней по дням, до года по неделям, дальше по месяцам', () => {
    assert.deepEqual([autoGroup(30), autoGroup(62), autoGroup(63), autoGroup(370), autoGroup(371)], ['day', 'day', 'week', 'week', 'month']);
});

test('группировка по неделям: недели с понедельника, края периода обрезаны, сумма сохраняется', () => {
    const r = rows('2026-11-01', 10);            // вс 1 ноября …10 ноября; 2 ноября — понедельник
    const w = groupSeries(r, 'week');
    assert.deepEqual(w.map(p => [p.from, p.to, p.orders]), [['2026-11-01', '2026-11-01', 1], ['2026-11-02', '2026-11-08', 7], ['2026-11-09', '2026-11-10', 2]]);
    assert.equal(w.reduce((s, p) => s + p.revenue, 0), 1000);
});

test('группировка по месяцам и по дням', () => {
    const r = rows('2026-10-30', 5, i => i + 1);   // 30, 31 октября и 1–3 ноября
    const m = groupSeries(r, 'month');
    assert.deepEqual(m.map(p => [p.from, p.to, p.orders]), [['2026-10-30', '2026-10-31', 3], ['2026-11-01', '2026-11-03', 12]]);
    assert.equal(groupSeries(r, 'day').length, 5);
});
