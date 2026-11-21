'use strict';

const WAREHOUSE_PRODUCT_FIELDS = Object.freeze([
    'id', 'brand', 'category', 'name', 'sku', 'volume',
    'stock', 'min_stock', 'active', 'coming_soon'
]);

function filterProductsForRole(products, role) {
    if (!Array.isArray(products)) return [];
    if (role === 'admin') return products;
    if (role !== 'warehouse') return [];
    return products.map(product => {
        const visible = {};
        for (const field of WAREHOUSE_PRODUCT_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(product, field)) visible[field] = product[field];
        }
        return visible;
    });
}

function validateStockUpdate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'Тело запроса должно быть объектом' };
    }
    const keys = Object.keys(raw);
    if (!keys.length || keys.some(key => !['stock', 'min_stock'].includes(key))) {
        return { ok: false, error: 'Разрешены только поля stock и min_stock' };
    }
    const data = {};
    for (const key of keys) {
        const value = raw[key];
        const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
        if (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000) {
            return { ok: false, error: `Поле ${key}: ожидается целое число от 0 до 1000000` };
        }
        data[key] = number;
    }
    return { ok: true, data };
}

module.exports = { WAREHOUSE_PRODUCT_FIELDS, filterProductsForRole, validateStockUpdate };
