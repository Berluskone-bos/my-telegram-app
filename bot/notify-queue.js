'use strict';
// Общий для процесса отправщик очереди уведомлений: токены ботов берутся из переменных окружения.
const Notifier = require('./services/notifier');
const { createOutbox } = require('./outbox');
const { escapeHtml } = require('./services/notifier');
const widgets = require('./widgets');

let _q = null;
function instance() {
    if (_q) return _q;
    const { pool } = require('./db');
    const n = new Notifier(process.env.BOT_TOKEN || '', process.env.COURIER_BOT_TOKEN || '', process.env.ADMIN_CHAT_ID, process.env.ADMIN_BOT_TOKEN || '');
    const bases = {
        client: process.env.BOT_TOKEN ? n.clientBotBase : null,
        courier: process.env.COURIER_BOT_TOKEN ? n.courierBotBase : null,
        admin: (process.env.ADMIN_BOT_TOKEN || process.env.BOT_TOKEN) ? n.adminBotBase : null
    };
    const send = (bot, method, payload) => {
        if (!bases[bot]) throw new Error(`chat not found: токен бота «${bot}» не задан`);
        return n._call(bases[bot], method, payload);
    };
    _q = createOutbox({ pool, send });
    _q.pool = pool;
    _q.send = send;     // прямой вызов Bot API (например, ответ на нажатие в карточке — его нужно дать за 15 секунд)
    return _q;
}

// Короткая запись: текст в очередь (db — pool или client транзакции)
function notify(bot, chatId, text, { buttons = null, dedupKey = null, onSent = null, db = null, throwOnError = false } = {}) {
    if (chatId === null || chatId === undefined || chatId === '') return Promise.resolve(null);
    const payload = { chat_id: String(chatId), text, parse_mode: 'HTML' };
    if (buttons) payload.reply_markup = { inline_keyboard: buttons };
    const q = instance();
    return q.enqueue({ bot, payload, dedupKey, onSent }, db).catch(e => {
        console.error('[OUTBOX] не поставлено в очередь:', String(e.code || e.name || 'unknown').slice(0, 40));
        if (throwOnError) throw e;
        return null;
    });
}

// Интерактивная карточка (виджет) в очередь. Если виджеты выключены (WIDGETS_ENABLED=0), карточка не собралась или
// Telegram её не примет — уйдёт fallbackText обычным сообщением (null — тогда ничего не отправляется).
// kind/ref — как карточку найти позже (таблица widget_messages), state — что на ней сейчас показано.
// Возвращает true, если в очередь поставлена именно карточка.
function notifyWidget(bot, chatId, widget, { kind, ref, state = {}, fallbackText = null, buttons = null, dedupKey = null, dependsOn = null, db = null, throwOnError = false } = {}) {
    if (chatId === null || chatId === undefined || chatId === '') return Promise.resolve(false);
    const plain = () => fallbackText
        ? notify(bot, chatId, fallbackText, { buttons, dedupKey: dedupKey ? 'fb:' + dedupKey : null, db, throwOnError }).then(() => false)
        : Promise.resolve(false);
    let ok = widgets.widgetsEnabled();
    if (ok) { try { widgets.checkWidget(widget); } catch (e) { console.error('[ВИДЖЕТ]', e.message); ok = false; } }
    if (!ok) return plain();
    const fbPayload = fallbackText
        ? { chat_id: String(chatId), text: fallbackText, parse_mode: 'HTML', ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) }
        : null;
    return instance().enqueue({
        bot, method: 'sendWidget', dedupKey, dependsOn,
        payload: { chat_id: String(chatId), html: widget.html, chat_data: widget.chat_data, caption: widget.caption, allow_queries: widget.allow_queries !== false,
            ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) },
        widget: { kind, ref, state }, fallback: { method: 'sendMessage', payload: fbPayload }
    }, db).then(() => true).catch(e => {
        console.error('[OUTBOX] карточка не поставлена в очередь:', String(e.code || e.name || 'unknown').slice(0, 40));
        if (throwOnError) throw e;
        return false;
    });
}

// Изменить данные уже отправленной карточки (editMessageWidgetData). Пуш-уведомления клиенту такое изменение не даёт.
function editWidget(bot, kind, ref, chatData, { dependsOn = null, db = null } = {}) {
    return instance().enqueue({
        bot, method: 'editMessageWidgetData', payload: { chat_data: chatData },
        editRef: `${kind}:${ref}`, dependsOn
    }, db).catch(e => {
        console.error('[OUTBOX] изменение карточки не поставлено в очередь:', String(e.code || e.name || 'unknown').slice(0, 40));
        return null;
    });
}

module.exports = { instance, notify, notifyWidget, editWidget, escapeHtml };
