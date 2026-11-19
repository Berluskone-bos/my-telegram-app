'use strict';
// Маршрут из нескольких заказов: сборка, рассылка курьеру, время приезда клиентам.
// Зависимости передаются снаружи (база, геокодер, очередь сообщений, планировщик) — так модуль проверяется тестами.
const defaultPlanner = require('./services/route-planner');
const MapLinks = require('./services/map-links');
const { escapeHtml } = require('./services/notifier');
const widgets = require('./widgets');
const { trackerEvent } = require('./tracker');
const { queueRouteSheetEdit, sheetKey } = require('./route-sheet');
const poolOf = () => require('./db').pool;

const DEFAULT_START = { lat: 59.9343, lon: 30.3351, source: 'default' };   // центр Санкт-Петербурга, пока склад не задан
const ACTIVE = ['pending', 'in_progress'];

function createRouteService({ db, geocoder = null, queue, planner = defaultPlanner, env = process.env, now = () => new Date() }) {
    const serviceMin = () => Math.max(0, Number(env.SERVICE_MINUTES) || 5);
    const thresholdMin = () => Math.max(1, Number(env.ETA_UPDATE_MINUTES) || 15);
    let warehouseCache = null;

    // Точка старта (склад): WAREHOUSE_LAT + WAREHOUSE_LON, либо WAREHOUSE_ADDRESS (определяется один раз по геокодеру)
    async function getWarehouse() {
        if (warehouseCache) return warehouseCache;
        const lat = Number(env.WAREHOUSE_LAT), lon = Number(env.WAREHOUSE_LON);
        if (env.WAREHOUSE_LAT && env.WAREHOUSE_LON && isFinite(lat) && isFinite(lon)) {
            return (warehouseCache = { lat, lon, source: 'coords' });
        }
        if (env.WAREHOUSE_ADDRESS && geocoder) {
            try {
                const g = await geocoder.geocode(env.WAREHOUSE_ADDRESS);
                if (g && g.lat && g.lon) return (warehouseCache = { lat: Number(g.lat), lon: Number(g.lon), source: 'address' });
            } catch (e) { console.error('[ROUTE] Не удалось определить координаты склада'); }
        }
        return DEFAULT_START;   // не кэшируем: после появления настройки подхватится сама
    }

    async function activeStopFor(orderNumber) {
        return db.activeRouteNumberForOrder(orderNumber);
    }

    const stopText = (s, i, n, courierView = true) => {
        const eta = s.etaAt ? ` — к ${planner.formatEta(s.etaAt, now()).clock}` : '';
        const o = s.order || s;
        return `${i + 1}. ${escapeHtml(o.order_number || '')} — ${escapeHtml(o.address || '')}${courierView ? eta : ''}`;
    };

    // Собрать маршрут из заказов и отправить курьеру. Бросает { code: 'BAD_REQUEST'|'CONFLICT'|'NOT_FOUND', message }.
    async function buildRoute({ orderIds, courier, notifyAdmin = null }) {
        const fail = (code, message) => Object.assign(new Error(message), { code });
        const ids = [...new Set((orderIds || []).map(Number))];
        if (ids.length < 1 || ids.some(id => !Number.isInteger(id) || id <= 0)) throw fail('BAD_REQUEST', 'Выберите хотя бы один заказ');
        if (ids.length > 30) throw fail('BAD_REQUEST', 'В одном маршруте не больше 30 заказов');
        if (!courier) throw fail('NOT_FOUND', 'Курьер не найден');

        const orders = [];
        for (const id of ids) {
            const o = await db.getOrderByNumber(id);
            if (!o) throw fail('NOT_FOUND', `Заказ ${id} не найден`);
            if (o.status !== 'READY_FOR_SHIPMENT') throw fail('CONFLICT', `Заказ ${o.order_number} ещё не готов к отправке (статус: ${o.status})`);
            if (o.delivery_type === 'pickup') throw fail('CONFLICT', `Заказ ${o.order_number} — самовывоз, курьер не нужен`);
            const busy = await activeStopFor(o.order_number);
            if (busy) throw fail('CONFLICT', `Заказ ${o.order_number} уже назначен курьеру (маршрут ${busy})`);
            orders.push(o);
        }

        // координаты адресов
        const stops = [];
        for (const o of orders) {
            let lat = null, lon = null;
            if (geocoder && o.address) {
                try { const g = await geocoder.geocode(o.address); if (g) { lat = g.lat; lon = g.lon; } }
                catch (e) { console.error('[ROUTE] Не удалось определить координаты точки доставки'); }
            }
            stops.push({ order: o, id: o.id, lat, lon });
        }

        const start = await getWarehouse();
        const plan = await planner.planRoute({ start, stops, departAt: now(), serviceMin: serviceMin() });
        const placed = plan.ordered.map(p => ({ ...p, order: stops.find(s => s.id === p.id).order }));
        const sequence = placed.concat(plan.unplaced.map(s => ({ ...s, etaAt: null })));

        const route = await db.createRoute({
            route_number: 'RL-' + String(Date.now()).slice(-4),
            route_date: now().toISOString().split('T')[0],
            courier_id: courier.id, status: 'assigned', total_orders: sequence.length,
            stops: sequence.map((s, i) => {
                const o = s.order;
                return {
                    order_id: String(o.id), order_number: o.order_number, stop_number: i + 1,
                    address: o.address || '', city: o.city || '', street: o.street || '', house: o.house || '',
                    lat: s.lat, lon: s.lon, eta_at: s.etaAt || null,
                    phone: o.phone || '', client_name: o.user_name || '', client_chat_id: o.user_id || null,
                    amount_to_pay: o.payment === 'cash' ? o.total : 0, payment_status: o.payment === 'cash' ? 'pending' : 'paid',
                    status: 'pending', comment: o.comment || ''
                };
            })
        });

        const approx = plan.source === 'estimate' ? ' (оценка по прямой: сервис дорог недоступен)' : '';
        const startNote = start.source === 'default' ? '\n⚠ Склад не задан в настройках: старт принят за центр города.' : '';
        const n = route.stops.length;
        const list = sequence.map((s, i) => stopText(s, i, n)).join('\n');

        if (courier.telegram_id) {
            const sheet =
                `<b>Маршрут ${escapeHtml(route.route_number)}</b>: ${n} ${n === 1 ? 'точка' : 'точек'}\n` +
                (plan.ordered.length ? `В пути около ${plan.totalMin} мин (с остановками по ${serviceMin()} мин)${approx}.\n` +
                    `Время ориентировочное: считается по дорогам и часам пик, живые пробки не учитываются.\n` : '') +
                `\n${list}\n\nНиже — карточка каждой точки с кнопками. Порядок: сверху вниз.${startNote}`;
            const ll = [start, ...placed].map(p => ({ lat: p.lat, lon: p.lon }));
            const nav = placed.length ? MapLinks.allRoute(ll) : null;
            const sheetButtons = nav ? [[{ text: 'Маршрут: Яндекс', url: nav.yandex }, { text: '2GIS', url: nav.gis2 }]] : null;
            if (queue.notifyWidget && widgets.widgetsEnabled()) {
                // карточка «Маршрутный лист»; если Telegram её не примет или виджеты выключены — прежний текстовый лист
                const card = widgets.routeSheetWidget(route.route_number, sequence.map(s => ({
                    order_number: s.order.order_number, address: s.order.address || '', status: 'pending',
                    clock: s.etaAt ? planner.formatEta(s.etaAt, now()).clock : ''
                })));
                await queue.notifyWidget('courier', courier.telegram_id, card, {
                    kind: 'route', ref: route.id, state: {}, fallbackText: sheet, buttons: sheetButtons, dedupKey: sheetKey(route.id)
                });
            } else {
                queue.notify('courier', courier.telegram_id, sheet, { dedupKey: `route-sheet:${route.id}`, buttons: sheetButtons });
            }
            route.stops.forEach((st, i) => {
                const s = sequence[i], o = s.order;
                const text =
                    `<b>Точка ${i + 1} из ${n}</b>\n\nЗаказ: ${escapeHtml(o.order_number)}\nАдрес: ${escapeHtml(o.address)}\n` +
                    (s.etaAt ? `Ориентировочно: к ${planner.formatEta(s.etaAt, now()).clock}\n` : '') +
                    `Сумма: ${parseFloat(o.total || 0).toLocaleString()} руб.${o.payment === 'cash' ? ' (оплата на месте)' : ''}\n` +
                    (o.phone ? `Телефон: ${escapeHtml(o.phone)}\n` : '') +
                    (o.comment ? `Комментарий: ${escapeHtml(o.comment)}\n` : '') +
                    `\nНажмите "Принять заказ", когда заберёте его со склада.`;
                const buttons = [];
                if (s.lat && s.lon) buttons.push([{ text: 'Яндекс Карты', url: MapLinks.yandex(o.address, s.lat, s.lon) }, { text: '2GIS', url: MapLinks.gis2(s.lat, s.lon) }]);
                buttons.push([{ text: 'Принять заказ', callback_data: `deliver_${route.id}_${st.id}_accept` }]);
                queue.notify('courier', courier.telegram_id, text, { buttons, dedupKey: `assign:${st.id}`, onSent: { stopId: st.id } });
            });
        }

        if (notifyAdmin) {
            notifyAdmin(
                `<b>Маршрут ${escapeHtml(route.route_number)} назначен</b>\nКурьер: ${escapeHtml(courier.name)}\n` +
                `Точек: ${n}${plan.ordered.length ? `, в пути около ${plan.totalMin} мин` : ''}${approx}\n\n${list}${startNote}`);
        }
        return { route, plan: { totalMin: plan.totalMin, source: plan.source, factor: plan.factor, start: start.source }, sequence: sequence.map(s => s.order.order_number) };
    }

    const etaClientText = (stop, eta, kind, position, total) => {
        const head = `<b>Заказ ${escapeHtml(stop.order_number)}</b>\n\n`;
        const when = planner.formatEta(eta, now()).text;
        if (kind === 'own') return head + `Статус: <b>Курьер в пути</b>\nКурьер везёт ваш заказ и будет у вас ${when}.`;
        if (kind === 'first') return head + `Статус: <b>Курьер выехал</b>\nВаш заказ — ${position}-й из ${total} по маршруту курьера. Ориентировочно курьер будет у вас ${when}.\nВремя приблизительное; если оно заметно изменится, мы напишем.`;
        return head + `Время приезда курьера уточнено: курьер будет у вас ${when}.`;
    };

    // Пересчитать время приезда по остановкам маршрута и сообщить клиентам.
    //   firstStopId — курьер выехал к этой точке («В пути»): её клиенту — «везёт ваш заказ» с временем;
    //                 остальным, кому ещё не писали, — «курьер выехал, вы N-й, будет через…»
    //   from — где курьер сейчас ({lat, lon}); без него — склад
    //   notifyNew — false: только обновить тем, кому время уже называли (после доставки/недоставки)
    async function refreshEtas({ routeId, firstStopId = null, from = null, notifyNew = true }) {
        const route = await db.getRouteById(routeId);
        if (!route) return null;
        await queueRouteSheetEdit(poolOf(), routeId, { activeStopId: firstStopId, now: now() }).catch(e => console.error('[ROUTE] Не удалось обновить карточку маршрута'));
        const t = now();
        let pending = (route.stops || []).filter(s => ACTIVE.includes(s.status)).sort((a, b) => a.stop_number - b.stop_number);
        if (firstStopId) {
            const f = pending.find(s => Number(s.id) === Number(firstStopId));
            if (f) pending = [f, ...pending.filter(s => s !== f)];
        }
        if (!pending.length) return null;
        // курьер сейчас у последней завершённой точки (доставил или не смог доставить), а если таких нет — на складе
        const done = (route.stops || []).filter(s => ['delivered', 'failed'].includes(s.status) && planner.hasCoords(s))
            .sort((a, b) => b.stop_number - a.stop_number)[0];
        const start = from || (done ? { lat: Number(done.lat), lon: Number(done.lon) } : await getWarehouse());
        const plan = await planner.planRoute({ start, stops: pending, departAt: t, serviceMin: serviceMin(), keepOrder: true });
        const sent = [];
        for (const p of plan.ordered) {
            const stop = pending.find(s => Number(s.id) === Number(p.id));
            const told = stop.eta_told_at ? new Date(stop.eta_told_at) : null;
            let kind = null;
            if (firstStopId && Number(stop.id) === Number(firstStopId)) kind = 'own';
            else if (!told && notifyNew) kind = 'first';
            else if (told && Math.abs(p.etaAt - told) / 60e3 > thresholdMin()) kind = 'update';
            await db.setStopEta(stop.id, p.etaAt, !!kind && !!stop.client_chat_id);
            if (kind && stop.client_chat_id) {
                const pos = pending.findIndex(s => Number(s.id) === Number(stop.id)) + 1;
                const clock = planner.formatEta(p.etaAt, t).clock;
                queue.notify('client', stop.client_chat_id, etaClientText(stop, p.etaAt, kind, pos, pending.length),
                    { dedupKey: `eta:${stop.id}:${kind}:${clock}` });
                sent.push({ stopId: stop.id, kind });
                // то же время — в карточку заказа клиента (без уведомления; текст выше его и так даёт)
                await trackerEvent(poolOf(), stop.order_number, { eta: planner.formatEta(p.etaAt, t).text, ...(kind === 'own' ? { stage: 'enroute' } : {}) }).catch(() => {});
            }
        }
        // точки без координат остаются без времени; сообщение «курьер в пути» их клиентам отправляет обработчик кнопки
        return { plan, sent };
    }

    return { buildRoute, refreshEtas, getWarehouse };
}

module.exports = { createRouteService };
