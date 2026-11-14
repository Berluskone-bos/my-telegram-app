'use strict';
// Что происходит при отмене заказа (из админ-бота, админки, бота клиента).
// Вызывается внутри той же транзакции, что и смена статуса (см. db-adapter.updateOrderStatus):
// либо заказ отменён И сообщения поставлены в очередь, либо не произошло ничего.
//   1. остановка маршрута уже помечена 'cancelled' — пересчитываем счётчики маршрута и закрываем его, если дел не осталось
//   2. курьеру: сообщение «заказ отменён, не везите» и кнопки на прежнем сообщении гаснут
//   3. клиенту: «Статус: Отменён» (один раз, даже если отмену нажали дважды)
const { enqueue, supersede } = require('./outbox');
const { escapeHtml } = require('./services/notifier');

const CANCELLED_BUTTON = [[{ text: 'Заказ отменён', callback_data: 'noop_cancelled' }]];

async function queueCancelNotices(client, order) {
    // 1. маршруты, где есть отменённая остановка этого заказа
    const stops = (await client.query(
        `SELECT rs.id, rs.route_id, rs.order_number, rs.address, c.telegram_id AS courier_tg
           FROM route_stops rs
           JOIN delivery_routes dr ON dr.id = rs.route_id
           LEFT JOIN couriers c ON c.id = dr.courier_id
          WHERE rs.order_number = $1 AND rs.status = 'cancelled'`, [order.order_number])).rows;

    for (const routeId of [...new Set(stops.map(s => s.route_id))]) {
        await client.query(
            `UPDATE delivery_routes dr SET
                completed = x.done, failed = x.bad,
                status = CASE WHEN x.open = 0 THEN 'completed' ELSE dr.status END,
                completed_at = CASE WHEN x.open = 0 AND dr.completed_at IS NULL THEN NOW() ELSE dr.completed_at END
              FROM (SELECT COUNT(*) FILTER (WHERE status = 'delivered')::int AS done,
                           COUNT(*) FILTER (WHERE status IN ('failed', 'cancelled'))::int AS bad,
                           COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress'))::int AS open
                      FROM route_stops WHERE route_id = $1) x
             WHERE dr.id = $1`, [routeId]);
    }

    // 2. курьеру
    for (const s of stops) {
        if (!s.courier_tg) continue;
        // курьер ещё не получил сообщение о заказе (оно в очереди) — просто не отправляем ничего
        if (await supersede(client, `assign:${s.id}`)) continue;
        await enqueue(client, {
            bot: 'courier', dedupKey: `cancel-edit:${s.id}`, dependsOn: `assign:${s.id}`, editStopMessage: s.id,
            method: 'editMessageReplyMarkup', payload: { reply_markup: { inline_keyboard: CANCELLED_BUTTON } }
        });
        await enqueue(client, {
            bot: 'courier', dedupKey: `cancel-courier:${s.id}`, dependsOn: `assign:${s.id}`,
            payload: {
                chat_id: String(s.courier_tg), parse_mode: 'HTML',
                text: `<b>Заказ отменён</b>\n\nЗаказ: ${escapeHtml(s.order_number)}\nАдрес: ${escapeHtml(s.address)}\n\n` +
                      `Этот заказ везти не нужно. Кнопки по нему отключены.`
            }
        });
    }

    // 3. клиенту
    if (order.user_id) {
        await enqueue(client, {
            bot: 'client', dedupKey: `cancel-client:${order.id}`,
            payload: { chat_id: String(order.user_id), parse_mode: 'HTML',
                       text: `<b>Заказ ${escapeHtml(order.order_number)}</b>\n\nСтатус: <b>Отменён</b>` }
        });
    }
}

// Можно ли курьеру работать с этой остановкой? Проверка перед каждой кнопкой курьерского бота.
async function checkStopActive(pool, stopId) {
    const r = await pool.query(
        `SELECT rs.status AS stop_status, rs.order_number, o.status AS order_status
           FROM route_stops rs LEFT JOIN orders o ON o.order_number = rs.order_number
          WHERE rs.id = $1`, [stopId]);
    const row = r.rows[0];
    if (!row) return { active: false, reason: 'not_found' };
    if (row.stop_status === 'cancelled' || row.order_status === 'CANCELLED') return { active: false, reason: 'cancelled', orderNumber: row.order_number };
    return { active: true, orderNumber: row.order_number, orderStatus: row.order_status };
}

module.exports = { queueCancelNotices, checkStopActive, CANCELLED_BUTTON };
