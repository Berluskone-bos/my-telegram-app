'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getMoscowRouteDate } = require('../bot/route-date');

test('дата нового маршрута берётся из календаря Москвы, а не UTC-даты процесса', async () => {
    const calls = [];
    const db = {
        async getMoscowToday() {
            calls.push('moscow-date');
            // В Москве уже следующий день, хотя UTC ещё показывает предыдущую дату.
            return '2026-11-23';
        }
    };

    assert.equal(await getMoscowRouteDate(db), '2026-11-23');
    assert.deepEqual(calls, ['moscow-date']);
});

test('создание маршрута без источника московской даты завершается явной ошибкой', async () => {
    await assert.rejects(getMoscowRouteDate({}), /db\.getMoscowToday is required/);
});
