'use strict';

const OPERATOR_LIST_FIELDS = Object.freeze([
    'id', 'order_number', 'phone', 'total', 'status', 'delivery_type', 'created_at'
]);
const OPERATOR_DETAIL_FIELDS = Object.freeze([
    'id', 'order_number', 'phone', 'address', 'items', 'total', 'payment', 'comment',
    'status', 'delivery_type', 'created_at'
]);
const WAREHOUSE_LIST_FIELDS = Object.freeze(['id','order_number','total','status','delivery_type','created_at']);
const WAREHOUSE_DETAIL_FIELDS = Object.freeze(['id','order_number','status','delivery_type','items','total','created_at']);
const FULL_ACCESS_ROLES = new Set(['admin', 'manager']);

function pickFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(value, key)).map(key => [key, value[key]]));
}

function filterOrderListItem(order, role) {
    if (FULL_ACCESS_ROLES.has(role)) return order;
    if (role === 'operator') return pickFields(order, OPERATOR_LIST_FIELDS);
    if (role === 'warehouse') return pickFields(order, WAREHOUSE_LIST_FIELDS);
    return {};
}

function filterOrderDetails(order, role) {
    if (FULL_ACCESS_ROLES.has(role)) return order;
    if (role === 'operator') return pickFields(order, OPERATOR_DETAIL_FIELDS);
    if (role === 'warehouse') return pickFields(order, WAREHOUSE_DETAIL_FIELDS);
    return {};
}

module.exports = { filterOrderListItem, filterOrderDetails };
