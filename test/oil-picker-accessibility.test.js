'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const oilJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'oil.js'), 'utf8');
const oilCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'oil.css'), 'utf8');

test('окно подбора масла размечено как доступный модальный диалог', () => {
    assert.ok(oilJs.includes('role="dialog" aria-modal="true" aria-labelledby="oilDialogTitle" tabindex="-1"'));
    assert.ok(oilJs.includes('id="oilDialogTitle"'));
    assert.ok(oilJs.includes("this.root.setAttribute('aria-hidden', 'true')"));
    assert.ok(oilJs.includes('this.root.inert = true'));
});

test('окно подбора закрывается по Escape и удерживает клавиатурный фокус внутри', () => {
    assert.ok(oilJs.includes("document.addEventListener('keydown', e => {"));
    assert.ok(oilJs.includes("if (e.key === 'Escape')"));
    assert.ok(oilJs.includes("if (e.key !== 'Tab') return"));
    assert.ok(oilJs.includes('document.activeElement === first'));
    assert.ok(oilJs.includes('document.activeElement === last'));
});

test('после закрытия окна фокус возвращается к элементу, который его открыл', () => {
    assert.ok(oilJs.includes('if (this.root.classList.contains(\'open\')) return;'));
    assert.ok(oilJs.includes('this.returnFocus = document.activeElement'));
    assert.ok(oilJs.includes('this.returnFocus.focus({ preventScroll: true })'));
});

test('переключатели способа подбора сообщают выбранное состояние', () => {
    assert.ok(oilJs.includes("b.setAttribute('aria-pressed', String(active))"));
});

test('элементы подбора масла имеют удобные сенсорные размеры и контраст', () => {
    assert.ok(oilCss.includes('.oil-close { display: grid; place-items: center; flex: 0 0 44px; width: 44px; min-width: 44px; height: 44px;'));
    assert.ok(oilCss.includes('.oil-tab { flex: 1; min-width: 0; min-height: 44px;'));
    assert.ok(oilCss.includes('.oil-add { min-height: 44px; padding: 8px 14px; border: 0; border-radius: 10px; background: #00AFC7; color: #101B4D;'));
    assert.ok(oilCss.includes('.oil-sheet button:focus-visible'));
});
