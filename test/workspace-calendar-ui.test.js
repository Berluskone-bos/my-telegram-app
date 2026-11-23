'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin-dashboard.js'), 'utf8');
const calendarApi = fs.readFileSync(path.join(__dirname, '..', 'bot', 'workspace-calendar.js'), 'utf8');

test('рабочий календарь выделяет выходные полупрозрачным красным цветом', () => {
    assert.match(dashboard, /\\.workcal-day\\.weekend\\{background:rgba\\(220,38,38,\\.075\\)/);
    assert.match(dashboard, /const weekend=date\\.getDay\\(\\)===0\\|\\|date\\.getDay\\(\\)===6/);
    assert.match(dashboard, /weekend\\?'weekend '/);
});

test('индикаторы всех типов событий, включая KPI, имеют единый фиксированный размер', () => {
    assert.match(dashboard, /\\.workcal-dot\\{[^}]*width:6px!important;height:6px!important;[^}]*flex:0 0 6px/);
    assert.match(dashboard, /\\.workcal-dot\\.kpi\\{background:#9333ea\\}/);
});

test('автообновление календаря не удаляет открытую форму и устаревшие ответы не перезаписывают новые', () => {
    assert.match(dashboard, /if\\(workcalSelected&&!document\\.getElementById\\('workcalCreateForm'\\)\\)renderWorkcalDay/);
    assert.match(dashboard, /if\\(!document\\.getElementById\\('workcalCreateForm'\\)\\)renderWorkcalDay\\(workcalSelected\\)/);
    assert.match(dashboard, /const requestSequence=\\+\\+workcalLoadSequence/);
    assert.match(dashboard, /requestSequence!==workcalLoadSequence/);
    assert.doesNotMatch(dashboard, /if\\(workcalLoading\\)return/);
});

test('задача сохраняется по сроку, а событие отображается по времени начала', () => {
    assert.match(dashboard, /startsAt:kind==='task'\\?null:workcalMskInputToIso\\(startsAt\\)/);
    assert.match(dashboard, /const value = item\\.kind === 'task' \\? \\(item\\.dueAt \\|\\| item\\.startsAt\\) : \\(item\\.startsAt \\|\\| item\\.dueAt\\)/);
    assert.match(calendarApi, /CASE WHEN w\\.kind = 'task' THEN w\\.due_at ELSE COALESCE\\(w\\.starts_at, w\\.due_at\\) END/);
});
