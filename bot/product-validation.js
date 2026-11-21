'use strict';

const STRING_LIMITS = {
    brand: 120, category: 120, name: 200, full_name: 300, series: 120,
    sku: 100, viscosity: 40, oil_type: 80, volume: 40, api_std: 120,
    acea: 120, ilsac: 120, image: 1000, description: 5000
};
const NUMERIC_LIMITS = {
    price: { min: 0, max: 10_000_000 },
    old_price: { min: 0, max: 10_000_000 },
    stock: { min: 0, max: 1_000_000, integer: true },
    min_stock: { min: 0, max: 1_000_000, integer: true }
};
const BOOLEAN_FIELDS = ['active', 'is_new', 'is_popular', 'coming_soon'];
const ALLOWED_FIELDS = new Set([
    ...Object.keys(STRING_LIMITS), ...Object.keys(NUMERIC_LIMITS), ...BOOLEAN_FIELDS, 'specs'
]);

function validateExpectedStock(value) {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000) {
        return { ok: false, error: 'Поле expected_stock: ожидается целое число от 0 до 1000000' };
    }
    return { ok: true, value: number };
}

function validateProductPayload(raw, { partial = false } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'Тело запроса должно быть объектом' };
    }

    const data = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!ALLOWED_FIELDS.has(key)) continue;
        if (value === undefined) continue;

        if (Object.prototype.hasOwnProperty.call(STRING_LIMITS, key)) {
            if (value === null && key !== 'name') { data[key] = null; continue; }
            if (typeof value !== 'string' || value.length > STRING_LIMITS[key]) {
                return { ok: false, error: `Поле ${key}: ожидается строка до ${STRING_LIMITS[key]} символов` };
            }
            const clean = value.trim();
            if (key === 'name' && !clean) return { ok: false, error: 'Название товара обязательно' };
            data[key] = clean;
            continue;
        }

        if (Object.prototype.hasOwnProperty.call(NUMERIC_LIMITS, key)) {
            if (value === null && key === 'old_price') { data[key] = null; continue; }
            if (typeof value !== 'number' && typeof value !== 'string') {
                return { ok: false, error: `Поле ${key}: ожидается число` };
            }
            if (typeof value === 'string' && !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.trim())) {
                return { ok: false, error: `Поле ${key}: некорректное число` };
            }
            const n = Number(value);
            const rule = NUMERIC_LIMITS[key];
            if (!Number.isFinite(n) || n < rule.min || n > rule.max || (rule.integer && !Number.isInteger(n))) {
                return { ok: false, error: `Поле ${key}: значение вне допустимого диапазона` };
            }
            data[key] = n;
            continue;
        }

        if (BOOLEAN_FIELDS.includes(key)) {
            if (typeof value !== 'boolean') return { ok: false, error: `Поле ${key}: ожидается true или false` };
            data[key] = value;
            continue;
        }

        if (key === 'specs') {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return { ok: false, error: 'Поле specs должно быть объектом' };
            }
            data.specs = value;
        }
    }

    if (!partial) {
        if (typeof data.name !== 'string' || !data.name) return { ok: false, error: 'Название товара обязательно' };
        if (!Object.prototype.hasOwnProperty.call(data, 'price')) return { ok: false, error: 'Цена товара обязательна' };
    } else if (Object.keys(data).length === 0) {
        return { ok: false, error: 'Нет допустимых полей для обновления' };
    }

    return { ok: true, data };
}

module.exports = { validateProductPayload, validateExpectedStock };
