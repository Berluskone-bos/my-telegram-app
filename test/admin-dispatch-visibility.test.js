'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterCouriersForRole, filterRoutesForRole, filterRouteForRole } = require('../bot/admin-dispatch-visibility');

const courier = {
    id: 7, name: 'Курьер А', is_active: true, phone: '+79990000000',
    telegram_id: 123456789, telegram_user: 'courier_a', license_plate: 'А123АА',
    vehicle_type: 'авто', rating: 4.9, rating_count: 15
};
const route = {
    id: 41, route_number: 'RL-41', courier_id: 7, status: 'assigned',
    route_date: '2026-11-21', total_orders: 1, total_distance_km: 12.4,
    stops: [{
        id: 88, order_id: '9001', order_number: 'AP-9001', address: 'СПб, Невский, 1',
        phone: '+79991112233', client_name: 'Клиент', client_chat_id: 998877,
        lat: 59.93, lon: 30.31, amount_to_pay: 2500, comment: 'Позвонить заранее'
    }]
};

test('оператор получает только поля курьера, используемые в экране назначения', () => {
    assert.deepEqual(filterCouriersForRole([courier], 'operator'), [
        { id: 7, name: 'Курьер А', is_active: true }
    ]);
});

test('оператор получает только связь заказ → курьер, без ПДн остановок маршрута', () => {
    assert.deepEqual(filterRoutesForRole([route], 'operator'), [
        { id: 41, courier_id: 7, stops: [{ order_id: '9001' }] }
    ]);
});

test('оператор получает краткую метаинформацию созданного маршрута без списка остановок', () => {
    assert.deepEqual(filterRouteForRole(route, 'operator'), {
        id: 41, route_number: 'RL-41', courier_id: 7, status: 'assigned'
    });
});

test('администратор сохраняет полный доступ к данным курьеров и маршрутов', () => {
    assert.equal(filterCouriersForRole([courier], 'admin')[0], courier);
    assert.equal(filterRoutesForRole([route], 'admin')[0], route);
    assert.equal(filterRouteForRole(route, 'admin'), route);
});

test('неизвестная роль закрыта по умолчанию', () => {
    assert.deepEqual(filterCouriersForRole([courier], 'unknown'), []);
    assert.deepEqual(filterRoutesForRole([route], 'unknown'), []);
    assert.deepEqual(filterRouteForRole(route, 'unknown'), {});
});
