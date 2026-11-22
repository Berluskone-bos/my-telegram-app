'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getTodayRoutes } = require('../bot/courier-date');

test('маршруты курьера запрашиваются по московской календарной дате, а не UTC-дате процесса', async () => {
    const calls = [];
    const expectedRoutes = [{ id: 42, route_date: '2026-11-23' }];
    const db = {
        async getMoscowToday() {
            calls.push('moscow-date');
            // В этот момент в Москве уже следующий день, хотя UTC ещё предыдущий.
            return '2026-11-23';
        },
        async getRoutesByDateAndCourier(date, courierId) {
            calls.push({ date, courierId });
            return expectedRoutes;
        }
    };

    const routes = await getTodayRoutes(db, 17);
    assert.deepEqual(routes, expectedRoutes);
    assert.deepEqual(calls, ['moscow-date', { date: '2026-11-23', courierId: 17 }]);
});
