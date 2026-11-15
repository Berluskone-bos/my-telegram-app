'use strict';
// Сводка дня для админа — карточка (виджет) в админ-боте: заказов, сумма, сколько в каждом статусе.
//   /summary в админ-боте — прислать свежую карточку; дальше раз в несколько минут бот молча обновляет её данные,
//   если цифры изменились (уведомлений нет). Если виджеты выключены или Telegram карточку не принял — приходит обычный текст.
const store = require('./widget-store');
const widgets = require('./widgets');
const { enqueue } = require('./outbox');

const sig = (sum) => JSON.stringify({ ...sum, updated: undefined });
const summaryKey = (chatId) => `widget:summary:${chatId}`;

function createSummaryService({ db, pool, queue, chatId }) {
    let timer = null;

    // Прислать новую карточку (или текст). Возвращает true, если ушла именно карточка.
    async function send() {
        if (!chatId) return false;
        const sum = await db.getDaySummary();
        const card = widgets.summaryWidget(sum);
        const ok = queue.notifyWidget
            ? await queue.notifyWidget('admin', chatId, card, { kind: 'summary', ref: chatId, state: { sig: sig(sum) }, fallbackText: widgets.summaryFallbackText(sum) })
            : (await queue.notify('admin', chatId, widgets.summaryFallbackText(sum)), false);
        return ok;
    }

    // Обновить данные уже отправленной карточки, если цифры изменились
    async function refresh() {
        if (!chatId || !widgets.widgetsEnabled()) return false;
        const w = await store.get(pool, 'summary', chatId);
        if (!w || !w.active || !w.message_id) return false;
        const sum = await db.getDaySummary();
        if ((w.state || {}).sig === sig(sum)) return false;
        await store.mergeState(pool, 'summary', chatId, { sig: sig(sum) });
        await enqueue(pool, {
            bot: 'admin', method: 'editMessageWidgetData', payload: { chat_data: widgets.summaryWidget(sum).chat_data },
            editRef: `summary:${chatId}`
        });
        return true;
    }

    function start(intervalMs = 5 * 60e3) {
        if (timer || process.env.OUTBOX_DISABLED === '1') return;
        timer = setInterval(() => refresh().catch(e => console.error('[СВОДКА] не обновлена:', String(e.message).slice(0, 150))), intervalMs);
        if (timer.unref) timer.unref();
    }
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

    return { send, refresh, start, stop };
}

module.exports = { createSummaryService, summaryKey };
