'use strict';
// Планировщик маршрута курьера из нескольких заказов.
//
// Что делает:
//   1. берёт время в пути между складом и точками (реальные дороги из OpenStreetMap через OSRM, бесплатно;
//      если сервис недоступен — оценка по прямой линии с поправкой на дорогу);
//   2. умножает его на коэффициент времени суток (час пик в Санкт-Петербурге) — это ОЦЕНКА, не живые пробки;
//   3. подбирает порядок точек с наименьшим суммарным временем в пути (точно перебором до 8 точек,
//      дальше — ближайший сосед + улучшение 2-opt);
//   4. считает время прибытия на каждую точку (время в пути + остановка на каждой выдаче).
//
// Живые пробки сюда не входят: это решение владельца (14–15.11.2026, платный сервис не подключаем).

const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
const MAX_EXACT = 8;                 // до скольки точек перебираем все порядки
const ROAD_FACTOR = 1.35;            // дорога длиннее прямой линии
const FREE_FLOW_KMH = 32;            // средняя скорость по городу без пробок (для оценки, если OSRM недоступен)
const TZ_OFFSET_H = 3;               // Москва / Санкт-Петербург (UTC+3, без перехода на летнее время)

const haversineKm = (a, b) => {
    const R = 6371, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
};

// Во сколько раз дорога дольше, чем без пробок, в это время (оценка для Санкт-Петербурга)
function trafficFactor(date) {
    const local = new Date(date.getTime() + TZ_OFFSET_H * 3600e3);
    const h = local.getUTCHours() + local.getUTCMinutes() / 60;
    const day = local.getUTCDay();
    const weekend = day === 0 || day === 6;
    const table = weekend
        ? [[0, 9, 1.0], [9, 12, 1.15], [12, 20, 1.3], [20, 24, 1.1]]
        : [[0, 6, 1.0], [6, 7, 1.2], [7, 10, 1.6], [10, 16, 1.25], [16, 20, 1.7], [20, 22, 1.2], [22, 24, 1.0]];
    for (const [from, to, f] of table) if (h >= from && h < to) return f;
    return 1.0;
}

// Матрица времени в пути (секунды) между точками. points[0] — склад. Возвращает { durations, source }.
async function fetchDurations(points, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
    if (typeof fetchImpl === 'function' && points.length >= 2) {
        try {
            const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            let resp;
            try { resp = await fetchImpl(`${OSRM_URL}/table/v1/driving/${coords}?annotations=duration`, { signal: ctrl.signal }); }
            finally { clearTimeout(timer); }
            if (resp.ok) {
                const data = await resp.json();
                const m = data && data.durations;
                const n = points.length;
                const valid = data && data.code === 'Ok' && Array.isArray(m) && m.length === n
                    && m.every(row => Array.isArray(row) && row.length === n
                        && row.every(v => typeof v === 'number' && isFinite(v) && v >= 0));
                if (valid) return { durations: m, source: 'osrm' };
            }
        } catch (e) { /* сеть/таймаут/плохой ответ — идём в оценку */ }
    }
    const n = points.length;
    const durations = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
        i === j ? 0 : (haversineKm(points[i], points[j]) * ROAD_FACTOR / FREE_FLOW_KMH) * 3600));
    return { durations, source: 'estimate' };
}

// Порядок остановок с наименьшим суммарным временем. dur — матрица, индекс 0 — старт; остановки 1..n.
// Путь открытый: возвращаться на склад не нужно. Возвращает массив индексов остановок (1..n).
function bestOrder(dur) {
    const n = dur.length - 1;
    if (n <= 1) return n === 1 ? [1] : [];
    if (n <= MAX_EXACT) {
        let best = Infinity, bestPath = null;
        const used = new Array(n + 1).fill(false), path = [];
        (function dfs(cur, cost) {
            if (cost >= best) return;
            if (path.length === n) { best = cost; bestPath = path.slice(); return; }
            for (let j = 1; j <= n; j++) {
                if (used[j]) continue;
                used[j] = true; path.push(j);
                dfs(j, cost + dur[cur][j]);
                path.pop(); used[j] = false;
            }
        })(0, 0);
        return bestPath;
    }
    // много точек: ближайший сосед, затем 2-opt
    const left = new Set(Array.from({ length: n }, (_, i) => i + 1));
    const path = []; let cur = 0;
    while (left.size) {
        let nb = null;
        for (const j of left) if (nb === null || dur[cur][j] < dur[cur][nb]) nb = j;
        path.push(nb); left.delete(nb); cur = nb;
    }
    const cost = (p) => { let c = dur[0][p[0]]; for (let i = 0; i < p.length - 1; i++) c += dur[p[i]][p[i + 1]]; return c; };
    let improved = true;
    while (improved) {
        improved = false;
        for (let i = 0; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
            const cand = path.slice(0, i).concat(path.slice(i, k + 1).reverse(), path.slice(k + 1));
            if (cost(cand) < cost(path) - 1e-9) { path.splice(0, n, ...cand); improved = true; }
        }
    }
    return path;
}

const hasCoords = (s) => s && s.lat !== null && s.lat !== undefined && s.lon !== null && s.lon !== undefined
    && s.lat !== '' && s.lon !== '' && isFinite(Number(s.lat)) && isFinite(Number(s.lon));

// Строит план. stops — [{ id, lat, lon, ... }]. keepOrder: true — не менять порядок, только пересчитать время.
// Возвращает { ordered: [{ ...stop, etaAt: Date, legMin }], unplaced: [...], totalMin, source, factor }
async function planRoute({ start, stops, departAt = new Date(), serviceMin = 5, keepOrder = false, fetchImpl }) {
    const withC = stops.filter(hasCoords).map(s => ({ ...s, lat: Number(s.lat), lon: Number(s.lon) }));
    const unplaced = stops.filter(s => !hasCoords(s));
    if (!withC.length) return { ordered: [], unplaced, totalMin: 0, source: 'none', factor: 1 };
    const pts = [{ lat: Number(start.lat), lon: Number(start.lon) }, ...withC];
    const { durations, source } = await fetchDurations(pts, { fetchImpl });
    const factor = trafficFactor(departAt);
    const dur = durations.map(r => r.map(v => v * factor));
    const order = keepOrder ? withC.map((_, i) => i + 1) : bestOrder(dur);
    const ordered = [];
    let t = departAt.getTime(), cur = 0, totalSec = 0;
    order.forEach((idx, k) => {
        const leg = dur[cur][idx];
        t += leg * 1000; totalSec += leg;
        ordered.push({ ...withC[idx - 1], etaAt: new Date(t), legMin: Math.round(leg / 60) });
        t += serviceMin * 60e3; totalSec += serviceMin * 60;
        cur = idx;
    });
    if (ordered.length) totalSec -= serviceMin * 60;     // на последней точке время «до приезда» не считаем
    return { ordered, unplaced, totalMin: Math.round(totalSec / 60), source, factor };
}

// «через ~25 мин (около 14:35)» — минуты округляем до 5, время по Санкт-Петербургу
function formatEta(etaAt, now = new Date()) {
    const mins = Math.max(0, Math.round((new Date(etaAt).getTime() - now.getTime()) / 60e3));
    const r = mins < 5 ? 5 : Math.round(mins / 5) * 5;
    const local = new Date(new Date(etaAt).getTime() + TZ_OFFSET_H * 3600e3);
    const hh = String(local.getUTCHours()).padStart(2, '0'), mm = String(local.getUTCMinutes()).padStart(2, '0');
    const dur = r >= 60 ? `${Math.floor(r / 60)} ч${r % 60 ? ' ' + (r % 60) + ' мин' : ''}` : `${r} мин`;
    return { text: `через ~${dur} (около ${hh}:${mm})`, minutes: r, clock: `${hh}:${mm}` };
}

module.exports = { planRoute, fetchDurations, bestOrder, trafficFactor, formatEta, haversineKm, hasCoords, MAX_EXACT };
