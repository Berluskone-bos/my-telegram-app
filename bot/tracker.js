'use strict';
// Трекер заказа для клиента: одна карточка (виджет), которая меняется по ходу заказа.
//   • создаётся вместе с заказом (в той же транзакции, сразу после текста с составом заказа);
//   • дальше бот меняет только её данные — клиент видит новый статус, не получая лишних сообщений;
//   • «Курьер приехал» и «Доставлен» по-прежнему приходят обычным сообщением (правка карточки уведомления не даёт);
//   • оценка доставки ставится звёздами прямо в карточке (нажатие приходит как widget_query «rate:N»).
// Если виджеты выключены (WIDGETS_ENABLED=0) или Telegram карточку не принял — trackerEvent вернёт false,
// и вызывающий код отправит прежнее текстовое сообщение.
const store = require('./widget-store');
const widgets = require('./widgets');
const { enqueue } = require('./outbox');

const widgetKey = (n) => `widget:tracker:${n}`;

// Элемент очереди «отправить карточку» для нового заказа или null, если виджеты выключены.
function trackerItem({ chatId, orderNumber, dependsOn }) {
    if (!widgets.widgetsEnabled() || !chatId) return null;
    const w = widgets.trackerWidget(orderNumber, { stage: 'accepted' });
    try { widgets.checkWidget(w); } catch (e) { console.error('[ВИДЖЕТ] трекер:', e.message); return null; }
    return {
        bot: 'client', method: 'sendWidget', dedupKey: widgetKey(orderNumber), dependsOn: dependsOn || null,
        payload: { chat_id: String(chatId), html: w.html, chat_data: w.chat_data, caption: w.caption, allow_queries: true },
        widget: { kind: 'tracker', ref: orderNumber, state: { stage: 'accepted' } },
        fallback: { method: 'sendMessage', payload: null }      // не приняли — молча; текст о заказе уже ушёл
    };
}

// Изменить карточку. patch: { stage, courier, eta, rating, canRate }. true — карточка есть и правка поставлена в очередь.
async function trackerEvent(db, orderNumber, patch, enqueueMessage = enqueue) {
    if (!widgets.widgetsEnabled() || !orderNumber) return false;
    // Pool calls own a short transaction so the displayed state cannot advance
    // unless its edit is durably present in notification_outbox. A PoolClient
    // supplied by an existing transaction remains owned by the caller.
    const ownsTransaction = typeof db.connect === 'function' && typeof db.release !== 'function';
    const client = ownsTransaction ? await db.connect() : db;
    try {
        if (ownsTransaction) await client.query('BEGIN');
        const row = await store.mergeState(client, 'tracker', orderNumber, patch);
        if (!row) {
            if (ownsTransaction) await client.query('COMMIT');
            return false;
        }
        const w = widgets.trackerWidget(orderNumber, row.state);
        await enqueueMessage(client, {
            bot: 'client', method: 'editMessageWidgetData', payload: { chat_data: w.chat_data },
            editRef: `tracker:${orderNumber}`, dependsOn: widgetKey(orderNumber)
        });
        if (ownsTransaction) await client.query('COMMIT');
        return true;
    } catch (e) {
        if (ownsTransaction) await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        if (ownsTransaction) client.release();
    }
}

// Есть ли рабочая карточка у заказа (для решения «слать ли старые кнопки оценки»)
async function hasTracker(db, orderNumber) {
    if (!widgets.widgetsEnabled()) return false;
    const w = await store.get(db, 'tracker', orderNumber);
    return !!(w && w.active);
}

// Нажатие в карточке. q — объект widget_query из Telegram. deps: { pool, db, call(method, payload) }.
// Возвращает короткое описание результата (для логов и тестов).
async function handleWidgetQuery(q, { pool, db, call }) {
    const answer = (text) => call('answerWidgetQuery', { widget_query_id: q.id, data: String(text).slice(0, 200) }).catch(() => {});
    const m = /^rate:([1-5])$/.exec(String(q.data || ''));
    if (!m) { await answer('?'); return 'ignored'; }
    const rating = Number(m[1]);
    const chatId = q.chat && q.chat.id, messageId = q.message_id;
    const fromId = q.from && q.from.id;
    if (!chatId || !messageId || !fromId || String(fromId) !== String(chatId)) { await answer('no'); return 'bad_chat'; }
    const w = await store.findByMessage(pool, 'tracker', chatId, messageId);
    if (!w) { await answer('old'); return 'no_tracker'; }
    const order = (await pool.query('SELECT user_id, status FROM orders WHERE order_number = $1', [w.ref])).rows[0];
    if (!order || String(order.user_id) !== String(fromId) || !['DELIVERED', 'COMPLETED'].includes(order.status)) { await answer('wait'); return 'not_delivered'; }
    const saved = await db.rateCourierForOrder(w.ref, fromId, rating);
    if (saved.status === 'not_allowed') { await answer('no'); return 'bad_chat'; }
    if (saved.status === 'no_courier') { await answer('no'); return 'no_courier'; }
    if (saved.status === 'not_delivered') { await answer('wait'); return 'not_delivered'; }
    if (saved.status === 'invalid') { await answer('?'); return 'ignored'; }
    if (saved.status !== 'rated' && saved.status !== 'already_rated') {
        await answer('fail'); return 'not_saved';
    }
    // Состояние карточки — только отображение. Единственный источник защиты от дублей — route_stops.client_rating.
    const ratingToShow = saved.status === 'rated' ? rating : Number(saved.rating);
    // Состояние карточки и запрос её редактирования фиксируем атомарно.
    // Если enqueue упадёт, транзакция откатит отображаемое состояние; повторный widget_query
    // получит already_rated из route_stops и сможет безопасно поставить правку повторно.
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const mark = await client.query(
            `UPDATE widget_messages SET state = state || $2::jsonb, updated_at = NOW()
              WHERE kind = 'tracker' AND ref = $1 AND active RETURNING state`,
            [w.ref, JSON.stringify({ rating: ratingToShow, canRate: false })]);
        const card = widgets.trackerWidget(w.ref, mark.rows[0]?.state || { rating: ratingToShow, canRate: false });
        await enqueue(client, {
            bot: 'client', method: 'editMessageWidgetData', payload: { chat_data: card.chat_data },
            editRef: `tracker:${w.ref}`
        });
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
    await answer(saved.status === 'rated' ? 'ok' : 'done');
    return saved.status === 'rated' ? 'rated' : 'already_rated';
}

module.exports = { trackerItem, trackerEvent, hasTracker, handleWidgetQuery, widgetKey };
