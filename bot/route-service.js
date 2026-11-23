'use strict';
const crypto = require('crypto');
// Маршрут из нескольких заказов: сборка, рассылка курьеру, время приезда клиентам.
// Зависимости передаются снаружи (база, геокодер, очередь сообщений, планировщик) — так модуль проверяется тестами.
const defaultPlanner = require('./services/route-planner');
const MapLinks = require('./services/map-links');
const { escapeHtml } = require('./services/notifier');
const widgets = require('./widgets');
const { trackerEvent } = require('./tracker');
const { queueRouteSheetEdit, sheetKey } = require('./route-sheet');
const poolOf = () => require('./db').pool;
const { getMoscowRouteDate } = require('./route-date');

const ACTIVE = ['pending', 'accepted', 'in_progress'];

function createRouteService({ db, geocoder = null, queue, planner = defaultPlanner, env = process.env, now = () => new Date(), refreshRouteSheet = queueRouteSheetEdit }) {
    const serviceMin = () => Math.max(0, Number(env.SERVICE_MINUTES) || 5);
    const thresholdMin = () => Math.max(1, Number(env.ETA_UPDATE_MINUTES) || 15);

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
            if (o.delivery_type === 'pickup') throw fail('CONFLICT', `Заказ ${o.order_number} — самовывоз, курьер не нужен`);
            if (['CANCELLED', 'DELIVERED', 'COMPLETED'].includes(o.status)) throw fail('CONFLICT', `Заказ ${o.order_number} уже отменён или доставлен`);
            if (o.status !== 'READY_FOR_SHIPMENT') throw fail('CONFLICT', `Заказ ${o.order_number} ещё не готов к отправке (статус: ${o.status})`);
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

        // Точка старта неизвестна при назначении маршрута. Не подставляем склад или центр города:
        // порядок выбирается только по адресам доставок, навигатор начнёт от GPS курьера.
        const plan = await planner.planRoute({ start: null, stops, departAt: now(), serviceMin: serviceMin() });
        const placed = plan.ordered.map(p => ({ ...p, order: stops.find(s => s.id === p.id).order }));
        const sequence = placed.concat(plan.unplaced.map(s => ({ ...s, etaAt: null })));

        const routeNumber = 'RL-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
        const approx = plan.source === 'estimate' ? ' (оценка по прямой: сервис дорог недоступен)' : '';
        const n = sequence.length;
        const list = sequence.map((s, i) => stopText(s, i, n)).join('\n');

        // Маршрут и все связанные уведомления записываются одной транзакцией.
        // Ошибка enqueue откатывает маршрут, чтобы API не оставил назначение без уведомлений.
        const route = await db.createRoute({
            route_number: routeNumber,
            route_date: await getMoscowRouteDate(db),
            courier_id: courier.id, status: 'assigned', total_orders: sequence.length, enforceReadyOrders: true,
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
            }),
            afterCreate: async ({ route: createdRoute, client }) => {
                if (courier.telegram_id) {
                    const sheet =
                        `<b>Маршрут ${escapeHtml(createdRoute.route_number)}</b>: ${n} ${n === 1 ? 'точка' : 'точек'}\n` +
                        (plan.ordered.length ? `Между адресами около ${plan.totalMin} мин (с остановками по ${serviceMin()} мин)${approx}; время до первой точки зависит от текущего местоположения курьера.\n` +
                            `Время ориентировочное: считается по дорогам и часам пик, живые пробки не учитываются.\n` : '') +
                        `\n${list}\n\nНиже — карточка каждой точки с кнопками. Порядок: сверху вниз. Навигация начинает путь от текущего местоположения курьера.`;
                    const ll = placed.map(p => ({ lat: p.lat, lon: p.lon }));
                    const nav = placed.length ? MapLinks.allRoute(ll) : null;
                    const sheetButtons = nav ? [[{ text: 'Маршрут: Яндекс', url: nav.yandex }, { text: '2GIS', url: nav.gis2 }]] : null;
                    if (queue.notifyWidget && widgets.widgetsEnabled()) {
                        const card = widgets.routeSheetWidget(createdRoute.route_number, sequence.map(s => ({
                            order_number: s.order.order_number, address: s.order.address || '', status: 'pending',
                            clock: s.etaAt ? planner.formatEta(s.etaAt, now()).clock : ''
                        })));
                        await queue.notifyWidget('courier', courier.telegram_id, card, {
                            kind: 'route', ref: createdRoute.id, state: {}, fallbackText: sheet, buttons: sheetButtons,
                            dedupKey: sheetKey(createdRoute.id), db: client, throwOnError: true
                        });
                    } else {
                        await queue.notify('courier', courier.telegram_id, sheet, {
                            dedupKey: `route-sheet:${createdRoute.id}`, buttons: sheetButtons, db: client, throwOnError: true
                        });
                    }
                    for (let i = 0; i < createdRoute.stops.length; i++) {
                        const st = createdRoute.stops[i];
                        const item = sequence[i], o = item.order;
                        const text =
                            `<b>Точка ${i + 1} из ${n}</b>\n\nЗаказ: ${escapeHtml(o.order_number)}\nАдрес: ${escapeHtml(o.address)}\n` +
                            (item.etaAt ? `Ориентировочно: к ${planner.formatEta(item.etaAt, now()).clock}\n` : '') +
                            `Сумма: ${parseFloat(o.total || 0).toLocaleString()} руб.${o.payment === 'cash' ? ' (оплата на месте)' : ''}\n` +
                            (o.phone ? `Телефон: ${escapeHtml(o.phone)}\n` : '') +
                            (o.comment ? `Комментарий: ${escapeHtml(o.comment)}\n` : '') +
                            `\nНажмите "Принять заказ", когда заберёте его со склада.`;
                        const buttons = [];
                        if (item.lat && item.lon) buttons.push([{ text: 'Яндекс Карты', url: MapLinks.yandex(o.address, item.lat, item.lon) }, { text: '2GIS', url: MapLinks.gis2(item.lat, item.lon) }]);
                        buttons.push([{ text: 'Принять заказ', callback_data: `deliver_${createdRoute.id}_${st.id}_accept` }]);
                        await queue.notify('courier', courier.telegram_id, text, {
                            buttons, dedupKey: `assign:${st.id}`, onSent: { stopId: st.id }, db: client, throwOnError: true
                        });
                    }
                }
                if (notifyAdmin) {
                    await notifyAdmin(
                        `<b>Маршрут ${escapeHtml(createdRoute.route_number)} назначен</b>\nКурьер: ${escapeHtml(courier.name)}\n` +
                        `Точек: ${n}${plan.ordered.length ? `, между адресами около ${plan.totalMin} мин` : ''}${approx}\n\n${list}`,
                        { db: client, dedupKey: `admin-route-assigned:${createdRoute.id}` }
                    );
                }
            }
        });

        return { route, plan: { totalMin: plan.totalMin, source: plan.source, factor: plan.factor, start: 'current-location' }, sequence: sequence.map(s => s.order.order_number) };
    }

    // Передать только незавершённые точки активного маршрута другому курьеру.
    async function transferRemainingRoute({ sourceRouteId, sourceCourierId, targetCourier, reason, notifyAdmin = null, actorLogin = null }) {
        const fail = (code, message) => Object.assign(new Error(message), { code });
        if (!targetCourier || !targetCourier.id) throw fail('NOT_FOUND', 'Новый курьер не найден');
        if (!['breakdown', 'fuel', 'accident', 'other'].includes(reason)) throw fail('BAD_REQUEST', 'Не указана причина передачи');
        const source = await db.getRouteByIdForCourier(sourceRouteId, sourceCourierId);
        if (!source) throw fail('NOT_FOUND', 'Исходный маршрут не найден или уже не принадлежит курьеру');
        if (!['assigned', 'in_progress'].includes(source.status)) throw fail('CONFLICT', 'Передать можно только назначенный или начатый маршрут');
        const active = (source.stops || []).filter(s => ['pending', 'accepted', 'in_progress'].includes(s.status));
        if (!active.length) throw fail('CONFLICT', 'В маршруте нет оставшихся заказов');
        const planStops = active.map(s => ({ id: Number(s.id), lat: s.lat == null ? null : Number(s.lat), lon: s.lon == null ? null : Number(s.lon), order: s }));
        const plan = await planner.planRoute({ start: null, stops: planStops, departAt: now(), serviceMin: serviceMin() });
        const byId = new Map(planStops.map(s => [s.id, s]));
        const sequence = plan.ordered.map(p => byId.get(Number(p.id))).filter(Boolean)
            .concat(plan.unplaced.map(s => byId.get(Number(s.id))).filter(Boolean));
        const routeNumber = 'TR-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
        const routeDate = await getMoscowRouteDate(db);
        const approx = plan.source === 'estimate' ? ' (ориентировочная оценка)' : '';
        const route = await db.transferRemainingRoute({
            sourceRouteId, expectedSourceCourierId: sourceCourierId, targetCourierId: targetCourier.id,
            routeNumber, routeDate, reason, orderedStopIds: sequence.map(s => s.id), actorLogin,
            afterTransfer: async ({ client, route: createdRoute, stops, sourceCourier }) => {
                const stopTextList = sequence.map((item, i) => `${i + 1}. ${escapeHtml(item.order_number || '')} — ${escapeHtml(item.address || '')}`).join('\n');
                const sheet = `<b>Переданный маршрут ${escapeHtml(createdRoute.route_number)}</b>: ${stops.length} точек\n` +
                    `Получите отправления у предыдущего курьера. Порядок точек указан ниже.\n\n${stopTextList}`;
                const ll = sequence.map(s => ({ lat: s.lat, lon: s.lon }));
                const nav = sequence.some(s => s.lat && s.lon) ? MapLinks.allRoute(ll) : null;
                const sheetButtons = nav ? [[{ text: 'Маршрут: Яндекс', url: nav.yandex }, { text: '2GIS', url: nav.gis2 }]] : null;
                if (queue.notifyWidget && widgets.widgetsEnabled()) {
                    const card = widgets.routeSheetWidget(createdRoute.route_number, stops.map((s, i) => ({ order_number: s.order_number, address: s.address || '', status: 'pending', clock: '' })));
                    await queue.notifyWidget('courier', targetCourier.telegram_id, card, { kind: 'route', ref: createdRoute.id, state: {}, fallbackText: sheet, buttons: sheetButtons, dedupKey: sheetKey(createdRoute.id), db: client, throwOnError: true });
                } else {
                    await queue.notify('courier', targetCourier.telegram_id, sheet, { dedupKey: `route-sheet:${createdRoute.id}`, buttons: sheetButtons, db: client, throwOnError: true });
                }
                for (let i = 0; i < stops.length; i++) {
                    const st = stops[i], old = sequence[i];
                    const text = `<b>Передача заказа ${i + 1} из ${stops.length}</b>\n\nЗаказ: ${escapeHtml(st.order_number || '')}\nАдрес: ${escapeHtml(st.address || '')}\n` +
                        `Сумма: ${Number(st.amount_to_pay || 0).toLocaleString()} руб.${st.payment_status === 'pending' ? ' (оплата на месте)' : ''}\n` +
                        (st.phone ? `Телефон: ${escapeHtml(st.phone)}\n` : '') + (st.comment ? `Комментарий: ${escapeHtml(st.comment)}\n` : '') +
                        `\nСначала получите этот заказ у предыдущего курьера, затем нажмите «Принять заказ».`;
                    const buttons = [];
                    if (st.lat && st.lon) buttons.push([{ text: 'Яндекс Карты', url: MapLinks.yandex(st.address, st.lat, st.lon) }, { text: '2GIS', url: MapLinks.gis2(st.lat, st.lon) }]);
                    buttons.push([{ text: 'Принять заказ', callback_data: `deliver_${createdRoute.id}_${st.id}_accept` }]);
                    await queue.notify('courier', targetCourier.telegram_id, text, { buttons, dedupKey: `assign:${st.id}`, onSent: { stopId: st.id }, db: client, throwOnError: true });
                }
                if (sourceCourier?.telegram_id) await queue.notify('courier', sourceCourier.telegram_id,
                    `<b>Маршрут передан другому курьеру</b>\nМаршрут: ${escapeHtml(source.route_number)}\nОставшиеся заказы переданы. Новые действия по этим заказам в старом маршрутном листе недоступны.`,
                    { dedupKey: `route-transfer-old:${sourceRouteId}`, db: client, throwOnError: true });
                if (notifyAdmin) await notifyAdmin(`<b>Передача маршрута завершена</b>\nСтарый маршрут: ${escapeHtml(source.route_number)}\nНовый маршрут: ${escapeHtml(createdRoute.route_number)}\nНовый курьер: ${escapeHtml(targetCourier.name)}\nПередано заказов: ${stops.length}\nПричина: ${escapeHtml(reason)}${approx}`, { db: client, dedupKey: `route-transfer:${sourceRouteId}` });
            }
        });
        if (route.status !== 'transferred') {
            const messages = { invalid: 'Некорректные данные передачи', not_found: 'Маршрут не найден', not_assigned: 'Маршрут уже принадлежит другому курьеру', route_not_transferable: 'Маршрут уже закрыт или передан', source_courier_inactive: 'Первый курьер не активен', target_courier_inactive: 'Второй курьер не активен', target_courier_busy: 'У второго курьера уже есть активный маршрут. Выберите другого курьера', nothing_to_transfer: 'Нет оставшихся заказов', invalid_order_reference: 'В маршруте найдена некорректная ссылка на заказ', invalid_stop_order: 'Изменился состав остановок маршрута. Обновите страницу', order_state_changed: 'Статус одного из заказов изменился. Обновите маршрут', already_transferred: 'Маршрут уже передан' };
            throw fail(route.status === 'not_found' ? 'NOT_FOUND' : 'CONFLICT', messages[route.status] || 'Не удалось передать маршрут');
        }
        return { route: route.route, sourceRouteId: route.sourceRouteId, transferredCount: route.transferredCount, sequence: sequence.map(s => s.order.order_number) };
    }
    // Пересчитать внутренние ориентиры для маршрутного листа курьера.
    // Расчётное время не отправляем клиентам: оно не учитывает фактические пробки и задержки.
    async function refreshEtas({ routeId, expectedCourierId, firstStopId = null, from = null }) {
        // ETA-пересчёт вызывается из действий курьера: чтение маршрута ограничено его активным владением.
        const route = await db.getRouteByIdForCourier(routeId, expectedCourierId);
        if (!route) return null;
        const t = now();
        let pending = (route.stops || []).filter(s => ACTIVE.includes(s.status)).sort((a, b) => a.stop_number - b.stop_number);
        if (firstStopId) {
            const f = pending.find(s => Number(s.id) === Number(firstStopId));
            if (f) pending = [f, ...pending.filter(s => s !== f)];
        }
        if (!pending.length) {
            await refreshRouteSheet(poolOf(), routeId, { expectedCourierId, activeStopId: firstStopId, now: t }).catch(() => console.error('[ROUTE] Не удалось обновить карточку маршрута'));
            return null;
        }
        const done = (route.stops || []).filter(s => ['delivered', 'failed'].includes(s.status) && planner.hasCoords(s))
            .sort((a, b) => b.stop_number - a.stop_number)[0];
        const start = from || (done ? { lat: Number(done.lat), lon: Number(done.lon) } : null);
        const plan = await planner.planRoute({ start, stops: pending, departAt: t, serviceMin: serviceMin(), keepOrder: true });
        for (const p of plan.ordered) {
            const stop = pending.find(s => Number(s.id) === Number(p.id));
            // ETA остаётся только внутренним ориентиром курьера; клиентам не сообщается.
            await db.setStopEta(routeId, stop.id, p.etaAt, false, expectedCourierId);
            // Удаляем ETA, оставшееся в карточке клиента от предыдущей версии маршрута.
            await trackerEvent(poolOf(), stop.order_number, { eta: '' }).catch(() => {});
        }
        // Сначала сохраняем пересчитанные ETA, затем строим и ставим в очередь карточку:
        // иначе курьер может получить старые времена из снимка маршрута.
        await refreshRouteSheet(poolOf(), routeId, { expectedCourierId, activeStopId: firstStopId, now: t }).catch(() => console.error('[ROUTE] Не удалось обновить карточку маршрута'));
        return { plan, sent: [] };
    }

    return { buildRoute, transferRemainingRoute, refreshEtas };
}

module.exports = { createRouteService };
