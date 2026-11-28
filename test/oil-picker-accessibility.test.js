'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const oilJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'oil.js'), 'utf8');
const oilCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'oil.css'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');

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
    assert.match(oilCss, /\.oil-tab\s*\{[^}]*flex:\s*1(?:\s+1\s+0)?;[^}]*min-width:\s*0;[^}]*min-height:\s*44px;/s);
    assert.ok(oilCss.includes('.oil-add { min-height: 44px; padding: 8px 14px; border: 0; border-radius: 10px; background: #00AFC7; color: #101B4D;'));
    assert.ok(oilCss.includes('.oil-sheet button:focus-visible'));
});


test('окно подбора масла не расширяет мобильный экран по горизонтали', () => {
    assert.match(oilCss, /\.oil-overlay\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100vw;[^}]*overflow-x:\s*hidden;/s);
    assert.match(oilCss, /\.oil-sheet\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*hidden;/s);
    assert.match(oilCss, /\.oil-tabs\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
    assert.match(oilCss, /\.oil-tab\s*\{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0;/s);
});

test('шапка восстановлена к размеру логотипа до увеличения', () => {
    assert.match(stylesCss, /\.header-logo-img\s*\{[^}]*height:\s*40px;[^}]*max-width:\s*min\(220px, 58vw\);/s);
    assert.doesNotMatch(stylesCss, /\.header-logo-img\s*\{[^}]*height:\s*54px;/s);
    assert.doesNotMatch(stylesCss, /\.header::before\s*\{/);
});

test('лента категорий прокручивается внутри ширины приложения', () => {
    assert.match(stylesCss, /\.app-screen\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;/s);
    assert.match(stylesCss, /\.categories-scroll\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-x:\s*auto;[^}]*overscroll-behavior-x:\s*contain;/s);
});
