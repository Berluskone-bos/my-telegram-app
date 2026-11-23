'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin-dashboard.js'), 'utf8');
const calendarApi = fs.readFileSync(path.join(__dirname, '..', 'bot', 'workspace-calendar.js'), 'utf8');

test('рабочий календарь выделяет выходные полупрозрачным красным цветом', () => {
    assert.ok(dashboard.includes('.workcal-day.weekend{background:rgba(220,38,38,.075)'));
    assert.ok(dashboard.includes('const weekend=date.getDay()===0||date.getDay()===6'));
    assert.ok(dashboard.includes("weekend?'weekend '"));
});

test('индикаторы всех типов событий, включая KPI, имеют единый фиксированный размер', () => {
    assert.ok(dashboard.includes('width:6px!important;height:6px!important'));
    assert.ok(dashboard.includes('flex:0 0 6px'));
    assert.ok(dashboard.includes('.workcal-dot.kpi{background:#9333ea}'));
});

test('автообновление календаря не удаляет открытую форму и устаревшие ответы не перезаписывают новые', () => {
    assert.ok(dashboard.includes("if(workcalSelected&&!document.getElementById('workcalCreateForm'))renderWorkcalDay"));
    assert.ok(dashboard.includes("if(!document.getElementById('workcalCreateForm'))renderWorkcalDay(workcalSelected)"));
    assert.ok(dashboard.includes('const requestSequence=++workcalLoadSequence'));
    assert.ok(dashboard.includes('requestSequence!==workcalLoadSequence'));
    assert.ok(!dashboard.includes('if(workcalLoading)return'));
});

test('задача сохраняется по сроку, а событие отображается по времени начала', () => {
    assert.ok(dashboard.includes("startsAt:kind==='task'?null:workcalMskInputToIso(startsAt)"));
    assert.ok(dashboard.includes("const value = item.kind === 'task' ? (item.dueAt || item.startsAt) : (item.startsAt || item.dueAt)"));
    assert.ok(calendarApi.includes("CASE WHEN w.kind = 'task' THEN w.due_at ELSE COALESCE(w.starts_at, w.due_at) END"));
});

test('список сотрудников включает все типы событий, а не только задачи', () => {
    const start = dashboard.indexOf('function renderWorkcalTasks()');
    const end = dashboard.indexOf('async function selectWorkcalDay', start);
    const renderer = dashboard.slice(start, end);
    assert.ok(renderer.includes(".filter(item=>item.status!=='cancelled')"));
    assert.ok(!renderer.includes("item.kind==='task'&&item.status!=='cancelled'"));
    assert.ok(renderer.includes('WORKCAL_KINDS[item.kind]||item.kind'));
    assert.ok(renderer.includes('data-open-workcal-date'));
    assert.ok(renderer.includes('Задачи и события сотрудников'));
});
