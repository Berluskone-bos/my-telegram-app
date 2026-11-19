'use strict';

// Единственный источник правил доступа сотрудников.
// ВАЖНО: middleware нужно ставить ПОСЛЕ verifyAdmin на каждом защищённом API-маршруте.
// Скрытие элементов интерфейса не является контролем доступа.

const ROLE_PERMISSIONS = Object.freeze({
    admin: Object.freeze(['*']),
    manager: Object.freeze([
        'dashboard.view',
        'orders.view',
        'orders.process',
        'customers.view',
        'sales.view'
    ]),
    operator: Object.freeze([
        'dashboard.view',
        'orders.view',
        'orders.process'
    ]),
    warehouse: Object.freeze([
        'dashboard.view',
        'orders.view',
        'orders.fulfill',
        'products.view',
        'inventory.view',
        'inventory.manage'
    ])
});

const ROLE_LABELS = Object.freeze({
    admin: 'Администратор',
    manager: 'Менеджер',
    operator: 'Оператор',
    warehouse: 'Кладовщик'
});

function isKnownRole(role) {
    return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);
}

function hasPermission(role, permission) {
    if (typeof permission !== 'string' || !permission.trim()) return false;
    const permissions = ROLE_PERMISSIONS[role];
    if (!permissions) return false;
    return permissions.includes('*') || permissions.includes(permission);
}

function requirePermission(permission) {
    if (typeof permission !== 'string' || !permission.trim()) {
        throw new TypeError('requirePermission expects a non-empty permission');
    }
    return function permissionGuard(req, res, next) {
        const role = req && req.admin && req.admin.role;
        if (!hasPermission(role, permission)) {
            return res.status(403).json({ error: 'Недостаточно прав', code: 'FORBIDDEN' });
        }
        return next();
    };
}

module.exports = { ROLE_PERMISSIONS, ROLE_LABELS, isKnownRole, hasPermission, requirePermission };
