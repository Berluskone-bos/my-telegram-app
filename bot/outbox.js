'use strict';
// Очередь уведомлений (notification_outbox).
//
// Зачем: раньше сообщения отправлялись «выстрелил и забыл» сразу после записи заказа. Если Telegram
// отвечал ошибкой или процесс перезапускался, клиент, админ или курьер сообщения не получали, а следа не оставалось.
// Теперь сообщение записывается в таблицу (для нового заказа — в той же транзакции, что и сам заказ),
// а фоновый обработчик отправляет его и при сбое повторяет с нарастающей паузой.
//
// Строка очереди: какой бот (client | admin | courier), метод Bot API, тело запроса, ключ дедупликации
// (одно и то же событие не отправится дважды), зависимость (отправлять только после другого сообщения).
const MAX_ATTEMPTS = 8;
const RETRY_SEC = [30, 120, 600, 3600, 3 * 3600, 6 * 3600, 12 * 3600]; // пауза после 1-й, 2-й, ... неудачи
const LEASE_SEC = 120;          // «аренда» строки обработчиком: если процесс умер, строку возьмёт другой
const BOTS = ['client', 'admin', 'courier'];

const retryDelaySec = (attempts) => RETRY_SEC[Math.min(Math.max(attempts, 1), RETRY_SEC.length) - 1];

// permanent — повторять бессмысленно (бот заблокирован, чат не найден, сообщение уже изменено...)
function classifyError(err) {
    const msg = String((err && err.message) || '').toLowerCase();
    if (msg.includes('message is not modified')) return { kind: 'done' }; // кнопки уже сняты — цель достигнута
    if (err && err.tgCode === 429) return { kind: 'retry', afterSec: (err.retryAfter || 5) + 1 };
    const permanentText = ['bot was blocked', 'chat not found', 'user is deactivated', 'message to edit not found',
        "message can't be edited", "can't parse entities", 'have no rights', 'bot was kicked', 'peer_id_invalid'];
    if (permanentText.some(t => msg.includes(t))) return { kind: 'permanent' };
    if (err && (err.tgCode === 400 || err.tgCode === 403 || err.tgCode === 404)) return { kind: 'permanent' };
    return { kind: 'retry' };
}

// Положить сообщение в очередь. db — pool или client внутри транзакции.
// item: { bot, method='sendMessage', payload, dedupKey, dependsOn, onSent }
//   onSent: { stopId } — запомнить message_id отправленного курьеру сообщения в route_stops
//   editStopMessage: stopId — для editMessageReplyMarkup: message_id взять из route_stops в момент отправки
async function enqueue(db, item) {
    if (!BOTS.includes(item.bot)) throw new Error('outbox: неизвестный бот ' + item.bot);
    const r = await db.query(
        `INSERT INTO notification_outbox (bot, method, payload, dedup_key, depends_on, on_sent, edit_stop_id)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7)
         ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [item.bot, item.method || 'sendMessage', JSON.stringify(item.payload || {}), item.dedupKey || null,
         item.dependsOn || null, item.onSent ? JSON.stringify(item.onSent) : null, item.editStopMessage || null]);
    return r.rowCount ? r.rows[0].id : null;
}

// Отменить ещё не отправленное сообщение. true — отменено (адресат его так и не получил).
async function supersede(db, dedupKey) {
    const r = await db.query(
        `UPDATE notification_outbox SET status = 'skipped', last_error = 'заменено более новым событием'
          WHERE dedup_key = $1 AND status = 'pending'`, [dedupKey]);
    return r.rowCount > 0;
}

function createOutbox({ pool, send, batch = 10 }) {
    let timer = null, running = false, lastPurge = 0;

    async function resolveMessageId(stopId) {
        const r = await pool.query('SELECT courier_chat_id, courier_message_id FROM route_stops WHERE id = $1', [stopId]);
        const row = r.rows[0];
        return row && row.courier_message_id ? { chat_id: String(row.courier_chat_id), message_id: Number(row.courier_message_id) } : null;
    }

    async function deliver(row) {
        let payload = row.payload;
        if (row.edit_stop_id) {
            const ref = await resolveMessageId(row.edit_stop_id);
            if (!ref) return { skipped: 'нет сообщения для изменения' };
            payload = { ...payload, chat_id: ref.chat_id, message_id: ref.message_id };
        }
        const result = await send(row.bot, row.method, payload);
        if (row.on_sent && row.on_sent.stopId && result && result.message_id) {
            await pool.query('UPDATE route_stops SET courier_chat_id = $1, courier_message_id = $2 WHERE id = $3',
                [String(payload.chat_id), result.message_id, row.on_sent.stopId]);
        }
        return { messageId: result && result.message_id ? result.message_id : null };
    }

    // Один проход: берёт готовые строки и отправляет. Возвращает { sent, failed, retried, skipped }.
    async function processOnce() {
        const stats = { sent: 0, failed: 0, retried: 0, skipped: 0 };
        const claimed = await pool.query(
            `UPDATE notification_outbox o
                SET status = 'sending', attempts = attempts + 1, locked_until = NOW() + ($2::int * INTERVAL '1 second')
              WHERE o.id IN (
                    SELECT c.id FROM notification_outbox c
                     WHERE ((c.status = 'pending' AND c.next_attempt_at <= NOW()) OR (c.status = 'sending' AND c.locked_until < NOW()))
                       AND (c.depends_on IS NULL OR NOT EXISTS (
                            SELECT 1 FROM notification_outbox d
                             WHERE d.dedup_key = c.depends_on AND d.status IN ('pending', 'sending')))
                     ORDER BY c.id LIMIT $1 FOR UPDATE SKIP LOCKED)
          RETURNING o.*`, [batch, LEASE_SEC]);
        const rows = claimed.rows.sort((a, b) => Number(a.id) - Number(b.id));
        for (const row of rows) {
            try {
                const r = await deliver(row);
                if (r.skipped) {
                    await pool.query(`UPDATE notification_outbox SET status = 'skipped', last_error = $2 WHERE id = $1`, [row.id, r.skipped]);
                    stats.skipped++;
                } else {
                    await pool.query(
                        `UPDATE notification_outbox SET status = 'sent', sent_at = NOW(), tg_message_id = $2, last_error = NULL WHERE id = $1`,
                        [row.id, r.messageId]);
                    stats.sent++;
                }
            } catch (e) {
                const c = classifyError(e);
                const err = String(e.message).slice(0, 300);
                if (c.kind === 'done') {
                    await pool.query(`UPDATE notification_outbox SET status = 'sent', sent_at = NOW(), last_error = $2 WHERE id = $1`, [row.id, err]);
                    stats.sent++;
                } else if (c.kind === 'permanent' || row.attempts >= MAX_ATTEMPTS) {
                    await pool.query(`UPDATE notification_outbox SET status = 'failed', last_error = $2 WHERE id = $1`, [row.id, err]);
                    console.error(`[OUTBOX] #${row.id} (${row.bot}) не доставлено: ${err}`);
                    stats.failed++;
                } else {
                    const wait = c.afterSec || retryDelaySec(row.attempts);
                    await pool.query(
                        `UPDATE notification_outbox SET status = 'pending', last_error = $2,
                                next_attempt_at = NOW() + ($3::int * INTERVAL '1 second') WHERE id = $1`, [row.id, err, wait]);
                    stats.retried++;
                }
            }
        }
        return stats;
    }

    async function purge() {
        await pool.query(`DELETE FROM notification_outbox WHERE status IN ('sent', 'skipped') AND created_at < NOW() - INTERVAL '14 days'`);
        await pool.query(`DELETE FROM notification_outbox WHERE status = 'failed' AND created_at < NOW() - INTERVAL '90 days'`);
    }

    async function tick() {
        if (running) return;
        running = true;
        try {
            await processOnce();
            if (Date.now() - lastPurge > 6 * 3600e3) { lastPurge = Date.now(); await purge(); }
        } catch (e) {
            console.error('[OUTBOX] проход не удался:', String(e.message).slice(0, 150));
        } finally { running = false; }
    }

    function start(intervalMs = 3000) {
        if (timer || process.env.OUTBOX_DISABLED === '1') return; // OUTBOX_DISABLED=1 — только для тестов
        timer = setInterval(tick, intervalMs);
        if (timer.unref) timer.unref();
        console.log('[OK] Очередь уведомлений запущена');
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    return { processOnce, start, stop, tick, purge, enqueue: (item, db) => enqueue(db || pool, item), supersede: (key, db) => supersede(db || pool, key) };
}

module.exports = { createOutbox, enqueue, supersede, classifyError, retryDelaySec, MAX_ATTEMPTS };
