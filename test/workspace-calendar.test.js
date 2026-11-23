'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    validDate, validMonth, validTimestamp, positiveId, normalizeItem
} = require('../bot/workspace-calendar');
const { ROLE_PERMISSIONS, hasPermission } = require('../bot/admin-permissions');

test('рабочий календарь принимает только существующие даты и месяцы', () => {
    assert.equal(validDate('2026-11-23'), true);
    assert.equal(validDate('2026-02-30'), false);
    assert.equal(validDate('23.11.2026'), false);
    assert.equal(validMonth('2026-11'), true);
    assert.equal(validMonth('2026-13'), false);
    assert.equal(validMonth('2019-12'), false);
});

test('идентификаторы сотрудников и дата события проверяются строго', () => {
    assert.equal(positiveId('12'), 12);
    assert.equal(positiveId('0'), null);
    assert.equal(positiveId('1.5'), null);
    assert.equal(validTimestamp('2026-11-23T09:00:00.000Z'), true);
    assert.equal(validTimestamp('не дата'), false);
});

test('задача требует название, исполнителя и срок', () => {
    const valid = normalizeItem({
        kind: 'task', title: 'Подготовить документы',
        dueAt: '2026-11-24T15:00:00.000Z', assignedTo: '7'
    });
    assert.equal(valid.error, undefined);
    assert.equal(valid.value.assignedTo, 7);
    assert.equal(valid.value.status, 'planned');
    assert.equal(normalizeItem({ kind: 'task', title: 'Задача', dueAt: '2026-11-24T15:00:00.000Z' }).error, 'Для задачи выберите сотрудника.');
    assert.equal(normalizeItem({ kind: 'task', title: 'Задача' }).error, 'Для задачи укажите срок выполнения.');
});

test('календарные записи не принимают неизвестные типы, статусы и приоритеты', () => {
    assert.ok(normalizeItem({ kind: 'unknown', title: 'Тест', startsAt: '2026-11-24T10:00:00Z' }).error);
    assert.ok(normalizeItem({ kind: 'meeting', title: 'Встреча', startsAt: '2026-11-24T10:00:00Z', status: 'deleted' }).error);
    assert.ok(normalizeItem({ kind: 'meeting', title: 'Встреча', startsAt: '2026-11-24T10:00:00Z', priority: 'critical' }).error);
});

test('личные задачи доступны всем рабочим ролям, управление календарём — администратору и менеджеру', () => {
    for (const role of ['admin', 'manager', 'operator', 'warehouse']) {
        assert.equal(hasPermission(role, 'workspace.view'), true);
        assert.equal(hasPermission(role, 'workspace.update_self'), true);
    }
    assert.equal(hasPermission('admin', 'workspace.manage'), true);
    assert.equal(hasPermission('manager', 'workspace.manage'), true);
    assert.equal(hasPermission('operator', 'workspace.manage'), false);
    assert.equal(hasPermission('warehouse', 'workspace.manage'), false);
});
