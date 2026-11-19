'use strict';

const ROLE_PERMISSIONS = Object.freeze({
    admin: Object.freeze(['*']),
    manager: Object.freeze(['dashboard.view','orders.view','orders.process','customers.view','sales.view']),
    operator: Object.freeze(['dashboard.view','orders.view','orders.process']),
    warehouse: Object.freeze(['dashboard.view','orders.view','orders.fulfill','products.view','inventory.view','inventory.manage'])
});
const ROLE_LABELS = Object.freeze({
    admin: 'Администратор', manager: 'Менеджер',
    operator: 'Оператор', warehouse: 'Кладовщик'
});
function isKnownRole(role) {
    return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);
}
function hasPermission(role, permission) {
    if (typeof permission !== 'string' || !permission.trim() || !isKnownRole(role)) return false;
    const permissions = ROLE_PERMISSIONS[role];
    return !!permissions && (permissions.includes('*') || permissions.includes(permission));
}
function requirePermission(permission) {
    if (typeof permission !== 'string' || !permission.trim()) throw new TypeError('requirePermission expects a non-empty permission');
    return function permissionGuard(req, res, next) {
        if (!hasPermission(req && req.admin && req.admin.role, permission)) {
            return res.status(403).json({ error: 'Недостаточно прав', code: 'FORBIDDEN' });
        }
        return next();
    };
}
function requireAnyPermission(...permissions) {
    if (!permissions.length || permissions.some(p => typeof p !== 'string' || !p.trim())) throw new TypeError('requireAnyPermission expects non-empty permissions');
    return function anyPermissionGuard(req, res, next) {
        const role = req && req.admin && req.admin.role;
        if (!permissions.some(p => hasPermission(role, p))) {
            return res.status(403).json({ error: 'Недостаточно прав', code: 'FORBIDDEN' });
        }
        return next();
    };
}
function requireOrderStatusPermission(req, res, next) {
    const permission = req && req.body && req.body.status === 'ASSEMBLING' ? 'orders.fulfill' : 'orders.process';
    return requirePermission(permission)(req, res, next);
}
module.exports = {
    ROLE_PERMISSIONS, ROLE_LABELS, isKnownRole, hasPermission,
    requirePermission, requireAnyPermission, requireOrderStatusPermission
};
