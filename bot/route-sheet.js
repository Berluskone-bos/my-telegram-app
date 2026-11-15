'use strict';
// Маршрутный лист курьера в виде карточки (виджет): рейс, сколько сделано, список точек со временем и статусом.
// Карточку отправляет route-service при назначении маршрута; здесь — её обновление после каждой точки
// (доставил, не доставил, отмена, «в пути»). Обновление молчаливое: данные меняются, уведомление не приходит.
const store = require('./widget-store');
const widgets = require('./widgets');
const planner = require('./services/route-planner');
const { enqueue } = require('./outbox');

const sheetKey = (routeId) => `route-sheet:${routeId}`;

// Состояние для карточки по данным из базы. activeStopId — точка, к которой курьер только что выехал (если в базе ещё не отмечена).
async function loadSheet(db, routeId, { activeStopId = null, now = new Date() } = {}) {
    const r = await db.query(
        `SELECT rs.id, rs.order_number, rs.address, rs.status, rs.eta_at, dr.route_number
           FROM route_stops rs JOIN delivery_routes dr ON dr.id = rs.route_id
          WHERE rs.route_id = $1 ORDER BY rs.stop_number`, [routeId]);
    if (!r.rows.length) return null;
    const stops = r.rows.map(s => ({
        order_number: s.order_number, address: s.address,
        status: activeStopId && Number(s.id) === Number(activeStopId) && s.status === 'pending' ? 'in_progress' : s.status,
        clock: s.eta_at && ['pending', 'in_progress'].includes(s.status) ? planner.formatEta(s.eta_at, now).clock : ''
    }));
    return { routeNumber: r.rows[0].route_number, stops };
}

// Поставить в очередь изменение карточки маршрута, если она есть и работает. true — поставлено.
async function queueRouteSheetEdit(db, routeId, opts = {}) {
    if (!widgets.widgetsEnabled()) return false;
    const w = await store.get(db, 'route', routeId);
    if (!w || !w.active) return false;
    const sheet = await loadSheet(db, routeId, opts);
    if (!sheet) return false;
    const card = widgets.routeSheetWidget(sheet.routeNumber, sheet.stops);
    await enqueue(db, {
        bot: 'courier', method: 'editMessageWidgetData', payload: { chat_data: card.chat_data },
        editRef: `route:${routeId}`, dependsOn: sheetKey(routeId)
    });
    return true;
}

module.exports = { queueRouteSheetEdit, loadSheet, sheetKey };
