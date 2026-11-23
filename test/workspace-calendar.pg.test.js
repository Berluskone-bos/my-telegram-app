'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('./test-db').testDatabaseUrl();

test('рабочий календарь: задачи видны назначенному сотруднику, личные данные и права изолированы', {
    skip: DB ? false : 'нет TEST_DATABASE_URL'
}, async t => {
    const tag = Date.now().toString();
    const prefix = 'workspace.calendar.' + tag.slice(-7);
    const password = 'Workspace-Calendar-2026!';
    Object.assign(process.env, {
        DATABASE_URL: DB,
        WEBHOOK_SECRET: 'w'.repeat(32),
        ADMIN_API_KEY: 'workspace-calendar-test-key-012345'
    });

    const express = require('express');
    const { pool, initDB } = require('../bot/db');
    const { createAdminAuth } = require('../bot/admin-auth');
    const { registerWorkspaceCalendarRoutes } = require('../bot/workspace-calendar');
    const db = require('../bot/db-adapter');
    await initDB();

    const auth = createAdminAuth({ pool, getKey: () => process.env.ADMIN_API_KEY, failDelayMs: 0 });
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    auth.registerRoutes(app);
    registerWorkspaceCalendarRoutes(app, { pool, verifyAdmin: auth.verifyAdmin });
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    const H = { 'content-type': 'application/json', 'x-forwarded-proto': 'https' };
    const Hsame = { ...H, origin: base.replace(/^http:/, 'https:') };
    const cookieOf = response => {
        const value = response.headers.getSetCookie().find(item => item.startsWith('__Host-admin_session='));
        assert.ok(value, 'session cookie must be issued');
        return value.split(';')[0];
    };
    const request = (path, cookie, options = {}) => fetch(base + path, {
        ...options, headers: { ...H, ...(options.method && options.method !== 'GET' ? Hsame : {}), cookie, ...(options.headers || {}) }
    });

    let users = [];
    let orderId = null;
    let itemIds = [];
    t.after(async () => {
        server.close();
        if (itemIds.length) await pool.query('DELETE FROM workspace_items WHERE id = ANY($1::bigint[])', [itemIds]);
        if (orderId) await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
        if (users.length) {
            await pool.query('DELETE FROM admin_sessions WHERE staff_user_id = ANY($1::bigint[])', [users]);
            await pool.query('DELETE FROM admin_users WHERE id = ANY($1::bigint[])', [users]);
        }
        await pool.end();
    });

    const adminLogin = await fetch(base + '/api/admin/login', {
        method: 'POST', headers: { ...H, 'x-forwarded-for': '10.51.0.1' },
        body: JSON.stringify({ key: process.env.ADMIN_API_KEY })
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = cookieOf(adminLogin);

    async function createEmployee(role, index) {
        const login = prefix + '.' + role;
        const response = await request('/api/admin/staff', adminCookie, {
            method: 'POST', body: JSON.stringify({ login, displayName: 'Workspace ' + role, password, role })
        });
        assert.equal(response.status, 201);
        const created = await response.json();
        users.push(created.id);
        const signedIn = await fetch(base + '/api/admin/login', {
            method: 'POST', headers: { ...H, 'x-forwarded-for': '10.51.0.' + (index + 2) },
            body: JSON.stringify({ login, password })
        });
        assert.equal(signedIn.status, 200);
        return { id: created.id, cookie: cookieOf(signedIn) };
    }
    const manager = await createEmployee('manager', 0);
    const operator = await createEmployee('operator', 1);
    const warehouse = await createEmployee('warehouse', 2);

    const now = new Date();
    const dueAt = new Date(now.getTime() + 2 * 3600_000).toISOString();
    async function createItem(cookie, payload) {
        const response = await request('/api/admin/workspace/items', cookie, {
            method: 'POST', body: JSON.stringify(payload)
        });
        assert.equal(response.status, 201, JSON.stringify(await response.clone().json().catch(() => ({}))));
        const item = await response.json();
        itemIds.push(item.id);
        return item;
    }
    const operatorTask = await createItem(manager.cookie, {
        kind: 'task', title: 'Подготовить отгрузку', dueAt,
        assignedTo: operator.id, companyVisible: false, priority: 'high'
    });
    const warehouseTask = await createItem(adminCookie, {
        kind: 'task', title: 'Проверить остатки', dueAt,
        assignedTo: warehouse.id, companyVisible: false
    });
    const meeting = await createItem(manager.cookie, {
        kind: 'meeting', title: 'Общее совещание', startsAt: dueAt,
        companyVisible: true, amount: 9500
    });

    const createdOrder = await db.createOrder({
        order_number: 'WORKSPACE-' + tag,
        user_id: 991000000 + Number(tag.slice(-6)),
        user_name: 'Workspace test customer',
        phone: '+79990002233',
        address: 'Санкт-Петербург, тестовый адрес',
        zone: 'spb', city: 'Санкт-Петербург', street: 'Тестовая', house: '2',
        comment: '', items: [], subtotal: 1200, total: 1200,
        idempotency_key: 'workspace-' + tag, status: 'NEW'
    });
    orderId = createdOrder.id;

    const month = (await pool.query("SELECT TO_CHAR(NOW() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM') AS month")).rows[0].month;
    const path = '/api/admin/workspace/calendar?month=' + month;
    const operatorCalendar = await request(path, operator.cookie);
    assert.equal(operatorCalendar.status, 200);
    assert.equal(operatorCalendar.headers.get('cache-control'), 'no-store');
    const operatorData = await operatorCalendar.json();
    assert.ok(operatorData.items.some(item => item.id === operatorTask.id));
    const visibleMeeting = operatorData.items.find(item => item.id === meeting.id);
    assert.ok(visibleMeeting);
    assert.equal(visibleMeeting.amount, null, 'operator must not receive contract or logistics amounts');
    assert.equal(operatorData.items.some(item => item.id === warehouseTask.id), false,
        'employee must not see another employee private task');
    const orderDay = operatorData.days.find(day => day.orders > 0);
    assert.ok(orderDay);
    assert.equal(typeof orderDay.stockMovements, 'number', 'daily stock indicators must be present');
    assert.equal(orderDay.revenue, null, 'operator must not receive sales totals');

    const managerData = await (await request(path, manager.cookie)).json();
    assert.ok(managerData.items.some(item => item.id === operatorTask.id));
    assert.ok(managerData.items.some(item => item.id === warehouseTask.id));
    assert.equal(Number(managerData.items.find(item => item.id === meeting.id).amount), 9500,
        'manager with sales.view can see company event amount');

    const selfUpdate = await request('/api/admin/workspace/items/' + operatorTask.id, operator.cookie, {
        method: 'PATCH', body: JSON.stringify({ status: 'in_progress' })
    });
    assert.equal(selfUpdate.status, 200);
    const otherTaskUpdate = await request('/api/admin/workspace/items/' + warehouseTask.id, operator.cookie, {
        method: 'PATCH', body: JSON.stringify({ status: 'done' })
    });
    assert.equal(otherTaskUpdate.status, 404, 'employee cannot update another employee task');

    const forbiddenCreate = await request('/api/admin/workspace/items', operator.cookie, {
        method: 'POST', body: JSON.stringify({
            kind: 'task', title: 'Чужое поручение', dueAt,
            assignedTo: warehouse.id
        })
    });
    assert.equal(forbiddenCreate.status, 403, 'employee cannot assign tasks');
    const staffList = await request('/api/admin/workspace/staff', manager.cookie);
    assert.equal(staffList.status, 200, 'manager can select employees for task assignment');
});
