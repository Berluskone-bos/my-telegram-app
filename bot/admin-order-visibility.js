'use strict';
const WAREHOUSE_LIST_FIELDS = Object.freeze(['id','order_number','total','status','delivery_type','created_at']);
const WAREHOUSE_DETAIL_FIELDS = Object.freeze(['id','order_number','status','delivery_type','items','total','created_at']);
function pickFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(value, key)).map(key => [key, value[key]]));
}
function filterOrderListItem(order, role) {
    return role === 'warehouse' ? pickFields(order, WAREHOUSE_LIST_FIELDS) : order;
}
function filterOrderDetails(order, role) {
    return role === 'warehouse' ? pickFields(order, WAREHOUSE_DETAIL_FIELDS) : order;
}
module.exports = { filterOrderListItem, filterOrderDetails };
