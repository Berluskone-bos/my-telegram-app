'use strict';
// Карточки-виджеты: лимиты Telegram, выключатель, безопасность данных. База не нужна.
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../bot/widgets');

test('карточки укладываются в лимиты Telegram (HTML ≤ 4096 Б в сжатом виде, данные ≤ 1024 Б)', () => {
    const long = 'Санкт-Петербург, Невский проспект, дом 100, корпус 2, строение 4, квартира 555';
    const stops = Array.from({ length: 12 }, (_, i) => ({ order_number: 'AP-12345678901' + (i % 10), address: long, clock: '14:3' + (i % 10), status: i < 4 ? 'delivered' : 'pending' }));
    for (const card of [
        w.trackerWidget('AP-123456789012', { stage: 'delivered', courier: 'Иван Иванович Петров-Сидоров', eta: 'через ~25 мин (около 14:35)', rating: 5 }),
        w.routeSheetWidget('RL-1234', stops),                       // даже 12 длинных адресов: адреса сокращаются, но влезают
        w.summaryWidget({ date: '15.11.2026', orders: 999, revenue: 9999999, new: 1, assembling: 2, shipping: 3, delivered: 4, cancelled: 5, updated: 'обновлено 14:35' })
    ]) {
        const r = w.checkWidget(card);
        assert.ok(r.zipped <= 4096 && r.data <= 1024, JSON.stringify(r));
    }
});

test('в HTML карточек нет запрещённых возможностей (color-mix, vh, input, сеть, внешние шрифты)', () => {
    for (const html of [w.TRACKER_HTML, w.ROUTE_HTML, w.SUMMARY_HTML]) {
        assert.doesNotMatch(html, /color-mix|\d\s*vh|\d\s*vw|<input|<textarea|fetch\(|XMLHttpRequest|@import|url\(|<img|<link|<svg/i);
        assert.match(html, /--tg-theme-/);
    }
});

test('данные в карточку: чужой HTML экранируется в запасном тексте, данные — строка JSON', () => {
    const t = w.trackerFallbackText('AP-1<b>', { stage: 'shipping', courier: '<script>x</script>' });
    assert.doesNotMatch(t, /<script>/); assert.match(t, /&lt;script&gt;/);
    assert.equal(typeof w.trackerWidget('AP-1', {}).chat_data, 'string');
    // адрес с тегами не ломает проверку размера: в данных это просто текст, а в карточке он выводится через экранирование
    assert.match(w.ROUTE_HTML, /function E\(/);
});

test('состояния трекера: шаги, отмена, оценка, не доставлен', () => {
    assert.deepEqual(w.trackerState('AP-1', { stage: 'accepted' }), { n: 'AP-1', s: 0, st: 'Принят' });
    const d = w.trackerState('AP-1', { stage: 'delivered', rating: 4 });
    assert.equal(d.s, 4); assert.equal(d.f, 1); assert.equal(d.r, 4);
    assert.equal(w.trackerState('AP-1', { stage: 'cancelled' }).x, 1);
    assert.equal(w.trackerState('AP-1', { stage: 'failed' }).z, 1);
    assert.equal(w.trackerState('AP-1', { stage: 'delivered', canRate: false }).f, undefined);
});

test('слишком большие данные не отправляются: сначала сокращаются, потом ошибка', () => {
    const big = { a: 'я'.repeat(600), b: 'я'.repeat(600) };
    assert.throws(() => w.fitData(big), /не удалось уместить/);
    const ok = w.fitData({ keep: 1, e: 'я'.repeat(600), c: 'x' }, [(o) => delete o.e]);
    assert.ok(Buffer.byteLength(ok) <= 1024);
});

test('выключатель WIDGETS_ENABLED=0', () => {
    const prev = process.env.WIDGETS_ENABLED;
    try {
        delete process.env.WIDGETS_ENABLED; assert.equal(w.widgetsEnabled(), true, 'по умолчанию включены');
        process.env.WIDGETS_ENABLED = '0'; assert.equal(w.widgetsEnabled(), false);
        process.env.WIDGETS_ENABLED = '1'; assert.equal(w.widgetsEnabled(), true);
    } finally { if (prev === undefined) delete process.env.WIDGETS_ENABLED; else process.env.WIDGETS_ENABLED = prev; }
});
