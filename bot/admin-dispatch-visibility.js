'use strict';

// Минимизация данных для оператора: экран заказов использует только имя курьера,
// ID курьера и связь order_id -> courier_id. Полные данные маршрута нужны только администратору.
function pick(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(value, key)).map(key => [key, value[key]]));
}

function filterCouriersForRole(couriers, role) {
    if (!Array.isArray(couriers)) return [];
    if (role === 'admin') return couriers;
    if (role === 'operator') return couriers.map(c => pick(c, ['id', 'name', 'is_active']));
    return [];
}

function filterRoutesForRole(routes, role) {
    if (!Array.isArray(routes)) return [];
    if (role === 'admin') return routes;
    if (role === 'operator') return routes.map(route => ({
        id: route.id,
        courier_id: route.courier_id,
        stops: Array.isArray(route.stops) ? route.stops.map(stop => pick(stop, ['order_id'])) : []
    }));
    return [];
}

function filterRouteForRole(route, role) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) return null;
    if (role === 'admin') return route;
    if (role === 'operator') return pick(route, ['id', 'route_number', 'courier_id', 'status']);
    return {};
}

module.exports = { filterCouriersForRole, filterRoutesForRole, filterRouteForRole };
