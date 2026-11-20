'use strict';
// Планировщик маршрута: порядок точек, время в пути, время прибытия. Без базы данных и без сети.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../bot/services/route-planner');

const cost = (dur, order) => { let c = dur[0][order[0]]; for (let i = 0; i < order.length - 1; i++) c += dur[order[i]][order[i + 1]]; return c; };
const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
function randMatrix(n, seed) {
    let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === j ? 0 : 60 + Math.floor(rnd() * 1800)));
}
const osrmReply = (durations) => async () => ({ ok: true, json: async () => ({ code: 'Ok', durations }) });

test('порядок точек: до 8 точек — точный минимум (проверка полным перебором)', () => {
    for (const seed of [1, 7, 42, 99]) {
        const dur = randMatrix(6, seed);
        const best = Math.min(...perms([1, 2, 3, 4, 5, 6]).map(p => cost(dur, p)));
        assert.equal(cost(dur, P.bestOrder(dur)), best, `seed ${seed}`);
    }
});

test('порядок точек: больше 8 точек — все точки по разу и не хуже, чем «ближайший сосед»', () => {
    const dur = randMatrix(11, 5);
    const order = P.bestOrder(dur);
    assert.deepEqual([...order].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const left = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); let cur = 0, greedy = 0;
    while (left.size) { let nb = null; for (const j of left) if (nb === null || dur[cur][j] < dur[cur][nb]) nb = j; greedy += dur[cur][nb]; left.delete(nb); cur = nb; }
    assert.ok(cost(dur, order) <= greedy + 1e-9);
});

test('коэффициент времени суток: час пик и ночь (время Санкт-Петербурга)', () => {
    assert.equal(P.trafficFactor(new Date('2026-11-16T05:00:00Z')), 1.6);   // понедельник 08:00 МСК
    assert.equal(P.trafficFactor(new Date('2026-11-16T15:00:00Z')), 1.7);   // понедельник 18:00 МСК
    assert.equal(P.trafficFactor(new Date('2026-11-15T00:00:00Z')), 1.0);   // воскресенье 03:00 МСК
    assert.equal(P.trafficFactor(new Date('2026-11-16T00:00:00Z')), 1.0);   // понедельник 03:00 МСК
});

test('время в пути: берётся из ответа OSRM; при сбое — оценка по прямой', async () => {
    const pts = [{ lat: 59.93, lon: 30.33 }, { lat: 59.95, lon: 30.40 }];
    const ok = await P.fetchDurations(pts, { fetchImpl: osrmReply([[0, 600], [650, 0]]) });
    assert.equal(ok.source, 'osrm'); assert.equal(ok.durations[0][1], 600);
    for (const bad of [
        async () => { throw new Error('сеть'); },
        async () => ({ ok: false, json: async () => ({}) }),
        async () => ({ ok: true, json: async () => ({ code: 'Ok', durations: [[0, null], [null, 0]] }) }),   // нет маршрута между точками
        async () => ({ ok: true, json: async () => ({ code: 'NoRoute' }) })
    ]) {
        const r = await P.fetchDurations(pts, { fetchImpl: bad });
        assert.equal(r.source, 'estimate');
        assert.ok(r.durations[0][1] > 60 && r.durations[0][1] < 3600, 'оценка правдоподобна');
    }
});

test('план: порядок, время прибытия с остановками, точки без адреса отдельно', async () => {
    // склад(0) → A(1), B(2), C(3). Выгодный порядок: C, A, B (300 + 400 + 500 с).
    const dur = [[0, 900, 1500, 300], [900, 0, 500, 400], [1500, 500, 0, 700], [300, 400, 700, 0]];
    const stops = [{ id: 'A', lat: 59.90, lon: 30.30 }, { id: 'B', lat: 59.91, lon: 30.31 }, { id: 'C', lat: 59.92, lon: 30.32 }, { id: 'X', lat: null, lon: null }];
    const departAt = new Date('2026-11-15T09:00:00Z');       // воскресенье 12:00 МСК → коэффициент 1.3
    const plan = await P.planRoute({ start: { lat: 59.93, lon: 30.33 }, stops, departAt, serviceMin: 5, fetchImpl: osrmReply(dur) });
    assert.deepEqual(plan.ordered.map(s => s.id), ['C', 'A', 'B']);
    assert.deepEqual(plan.unplaced.map(s => s.id), ['X']);
    assert.equal(plan.source, 'osrm'); assert.equal(plan.factor, 1.3);
    const at = (s) => (s.etaAt.getTime() - departAt.getTime()) / 1000;
    assert.equal(at(plan.ordered[0]), 300 * 1.3);
    assert.equal(at(plan.ordered[1]), 300 * 1.3 + 300 + 400 * 1.3);              // + 5 мин остановка на C
    assert.equal(at(plan.ordered[2]), 300 * 1.3 + 300 + 400 * 1.3 + 300 + 500 * 1.3);
    assert.equal(plan.totalMin, Math.round((300 * 1.3 + 400 * 1.3 + 500 * 1.3 + 600) / 60));
});

test('план: keepOrder не меняет порядок, а только пересчитывает время', async () => {
    const dur = [[0, 900, 1500], [900, 0, 500], [1500, 500, 0]];
    const stops = [{ id: 'A', lat: 59.9, lon: 30.3 }, { id: 'B', lat: 59.91, lon: 30.31 }];
    const plan = await P.planRoute({ start: { lat: 59.93, lon: 30.33 }, stops, departAt: new Date('2026-11-15T00:00:00Z'), keepOrder: true, fetchImpl: osrmReply(dur) });
    assert.deepEqual(plan.ordered.map(s => s.id), ['A', 'B']);
});

test('текст времени: минуты округляются до 5, время по Санкт-Петербургу', () => {
    const now = new Date('2026-11-15T09:00:00Z');
    assert.deepEqual(P.formatEta(new Date('2026-11-15T09:23:00Z'), now), { text: 'через ~25 мин (около 12:23)', minutes: 25, clock: '12:23' });
    assert.equal(P.formatEta(new Date('2026-11-15T09:01:00Z'), now).minutes, 5);
    assert.match(P.formatEta(new Date('2026-11-15T10:20:00Z'), now).text, /^через ~1 ч 20 мин \(около 13:20\)$/);
});

test('план без заданного старта: склад не подставляется, выбирается кратчайший открытый путь', async () => {
    const dur = [[0, 600, 1800], [600, 0, 600], [1800, 600, 0]];
    const stops = [{ id: 'A', lat: 59.9, lon: 30.3 }, { id: 'B', lat: 59.91, lon: 30.31 }, { id: 'C', lat: 59.92, lon: 30.32 }];
    let requestedPoints = 0;
    const plan = await P.planRoute({ start: null, stops, departAt: new Date('2026-11-15T00:00:00Z'),
        fetchImpl: async (url) => {
            requestedPoints = url.split('/driving/')[1].split('?')[0].split(';').length;
            return { ok: true, json: async () => ({ code: 'Ok', durations: dur }) };
        } });
    assert.equal(requestedPoints, 3, 'в матрицу не добавлена фиктивная точка склада');
    assert.deepEqual(plan.ordered.map(s => s.id), ['A', 'B', 'C']);
    assert.equal(plan.ordered[0].etaAt, null, 'ETA первой точки не рассчитывается от вымышленного старта');
    assert.ok(plan.ordered[1].etaAt instanceof Date);
    assert.equal(plan.totalMin, 20, 'считается только путь между адресами и время остановки');
});
