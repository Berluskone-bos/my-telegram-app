'use strict';
// Общий для процесса отправщик очереди уведомлений: токены ботов берутся из переменных окружения.
const Notifier = require('./services/notifier');
const { createOutbox } = require('./outbox');
const { escapeHtml } = require('./services/notifier');

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
    return _q;
}

// Короткая запись: текст в очередь (db — pool или client транзакции)
function notify(bot, chatId, text, { buttons = null, dedupKey = null, onSent = null, db = null } = {}) {
    if (chatId === null || chatId === undefined || chatId === '') return Promise.resolve(null);
    const payload = { chat_id: String(chatId), text, parse_mode: 'HTML' };
    if (buttons) payload.reply_markup = { inline_keyboard: buttons };
    const q = instance();
    return q.enqueue({ bot, payload, dedupKey, onSent }, db).catch(e => {
        console.error('[OUTBOX] не поставлено в очередь:', String(e.message).slice(0, 150));
        return null;
    });
}

module.exports = { instance, notify, escapeHtml };
