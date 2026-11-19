'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ROLE_PERMISSIONS, ROLE_LABELS, isKnownRole, hasPermission, requirePermission, requireAnyPermission, requireOrderStatusPermission } = require('../bot/admin-permissions');

test('определены только четыре согласованные роли', () => {
    assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), ['admin', 'manager', 'operator', 'warehouse']);
    assert.deepEqual(Object.keys(ROLE_LABELS).sort(), ['admin', 'manager', 'operator', 'warehouse']);
    assert.equal(isKnownRole('courier'), false);
    assert.equal(isKnownRole('admin'), true);
});

test('администратор имеет полный доступ', () => {
    for (const permission of ['dashboard.view', 'orders.process', 'customers.view', 'sales.view', 'inventory.manage', 'staff.manage']) {
        assert.equal(hasPermission('admin', permission), true, permission);
    }
});

test('менеджер имеет доступ к клиентам, заказам и продажам, но не к управлению складом и сотрудниками', () => {
    for (const permission of ['dashboard.view', 'orders.view', 'orders.process', 'customers.view', 'sales.view']) {
        assert.equal(hasPermission('manager', permission), true, permission);
    }
    for (const permission of ['inventory.manage', 'staff.manage']) {
        assert.equal(hasPermission('manager', permission), false, permission);
    }
});

test('оператор обрабатывает заказы, но не получает доступ к клиентской базе, продажам и складу', () => {
    for (const permission of ['dashboard.view', 'orders.view', 'orders.process']) {
        assert.equal(hasPermission('operator', permission), true, permission);
    }
    for (const permission of ['customers.view', 'sales.view', 'inventory.manage', 'staff.manage']) {
        assert.equal(hasPermission('operator', permission), false, permission);
    }
});

test('кладовщик видит товары и склад, работает с комплектацией, но не управляет клиентами и продажами', () => {
    for (const permission of ['dashboard.view', 'orders.view', 'orders.fulfill', 'products.view', 'inventory.view', 'inventory.manage']) {
        assert.equal(hasPermission('warehouse', permission), true, permission);
    }
    for (const permission of ['orders.process', 'customers.view', 'sales.view', 'staff.manage']) {
        assert.equal(hasPermission('warehouse', permission), false, permission);
    }
});

test('неизвестная роль и некорректное разрешение закрыты по умолчанию', () => {
    assert.equal(hasPermission('courier', 'orders.view'), false);
    assert.equal(hasPermission('unknown', 'dashboard.view'), false);
    assert.equal(hasPermission('toString', 'orders.view'), false);
    assert.equal(hasPermission('admin', ''), false);
    assert.equal(hasPermission('admin', null), false);
});

test('permission middleware пропускает разрешённую роль', () => {
    let called = false;
    const middleware = requirePermission('orders.view');
    middleware({ admin: { role: 'operator' } }, {}, () => { called = true; });
    assert.equal(called, true);
});

test('permission middleware возвращает 403 для запрещённой роли', () => {
    let called = false;
    let status;
    let payload;
    const res = {
        status(code) { status = code; return this; },
        json(body) { payload = body; return this; }
    };
    requirePermission('staff.manage')({ admin: { role: 'manager' } }, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(status, 403);
    assert.deepEqual(payload, { error: 'Недостаточно прав', code: 'FORBIDDEN' });
});

test('middleware не допускает доступ при отсутствии роли', () => {
    let status;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    requirePermission('orders.view')({}, res, () => {});
    assert.equal(status, 403);
});

test('middleware требует явно заданное разрешение', () => {
    assert.throws(() => requirePermission(''), TypeError);
});


test('requireAnyPermission пропускает роль с одним из разрешений', () => {
    let called = false;
    requireAnyPermission('customers.view', 'orders.view')(
        { admin: { role: 'operator' } }, {}, () => { called = true; }
    );
    assert.equal(called, true);
});

test('кладовщик может начать комплектацию, но не выполнять другие переходы статуса', () => {
    let called = false;
    let status;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    requireOrderStatusPermission(
        { admin: { role: 'warehouse' }, body: { status: 'ASSEMBLING' } },
        res, () => { called = true; }
    );
    assert.equal(called, true);
    called = false;
    requireOrderStatusPermission(
        { admin: { role: 'warehouse' }, body: { status: 'CANCELLED' } },
        res, () => { called = true; }
    );
    assert.equal(called, false);
    assert.equal(status, 403);
});
