'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const oilJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'oil.js'), 'utf8');
const oilCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'oil.css'), 'utf8');

test('окно подбора масла размечено как доступный модальный диалог', () => {
    assert.match(oilJs, /role="dialog" aria-modal="true" aria-labelledby="oilDialogTitle" tabindex="-1"/);
    assert.match(oilJs, /id="oilDialogTitle"/);
    assert.match(oilJs, /this\.root\.setAttribute\('aria-hidden', 'true'\)/);
    assert.match(oilJs, /this\.root\.inert = true/);
});

test('окно подбора закрывается по Escape и удерживает клавиатурный фокус внутри', () => {
    assert.match(oilJs, /if \(e\.key === 'Escape'\)[\s\S]*?this\.close\(\)/);
    assert.match(oilJs, /if \(e\.key !== 'Tab'\) return/);
    assert.match(oilJs, /if \(e\.shiftKey && \(document\.activeElement === first/);
    assert.match(oilJs, /document\.activeElement === last/);
});

test('после закрытия окна фокус возвращается к элементу, который его открыл', () => {
    assert.match(oilJs, /this\.returnFocus = document\.activeElement/);
    assert.match(oilJs, /this\.returnFocus\.focus\(\{ preventScroll: true \}\)/);
});

test('переключатели способа подбора сообщают выбранное состояние', () => {
    assert.match(oilJs, /b\.setAttribute\('aria-pressed', String\(active\)\)/);
});

test('элементы подбора масла имеют удобные сенсорные размеры и контраст', () => {
    assert.match(oilCss, /\.oil-close \{[^}]*width: 44px;[^}]*height: 44px;/);
    assert.match(oilCss, /\.oil-tab \{[^}]*min-height: 44px;/);
    assert.match(oilCss, /\.oil-add \{[^}]*min-height: 44px;[^}]*background: #00AFC7; color: #101B4D;/);
    assert.match(oilCss, /\.oil-sheet button:focus-visible/);
});
