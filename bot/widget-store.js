'use strict';
// Хранилище карточек-виджетов (таблица widget_messages): какое сообщение в каком чате и что на нём показано.
// db — pool или client внутри транзакции.

const ref = (v) => String(v);

// Создать/обновить запись. active = true: карточка ожидается или уже отправлена.
async function upsert(db, kind, key, state = {}) {
    await db.query(
        `INSERT INTO widget_messages (kind, ref, state) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (kind, ref) DO UPDATE SET state = EXCLUDED.state, active = true, updated_at = NOW()`,
        [kind, ref(key), JSON.stringify(state)]);
}

async function get(db, kind, key) {
    const r = await db.query('SELECT * FROM widget_messages WHERE kind = $1 AND ref = $2', [kind, ref(key)]);
    return r.rows[0] || null;
}

// Слить изменения в state (одной командой, чтобы два события подряд не затёрли друг друга). Возвращает новую строку или null.
async function mergeState(db, kind, key, patch) {
    const r = await db.query(
        `UPDATE widget_messages SET state = state || $3::jsonb, updated_at = NOW()
          WHERE kind = $1 AND ref = $2 AND active RETURNING *`, [kind, ref(key), JSON.stringify(patch)]);
    return r.rows[0] || null;
}

async function setMessage(db, kind, key, chatId, messageId) {
    await db.query(
        `INSERT INTO widget_messages (kind, ref, chat_id, message_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (kind, ref) DO UPDATE SET chat_id = EXCLUDED.chat_id, message_id = EXCLUDED.message_id, active = true, updated_at = NOW()`,
        [kind, ref(key), String(chatId), messageId]);
}

async function deactivate(db, kind, key) {
    await db.query('UPDATE widget_messages SET active = false, updated_at = NOW() WHERE kind = $1 AND ref = $2', [kind, ref(key)]);
}

async function findByMessage(db, kind, chatId, messageId) {
    const r = await db.query(
        'SELECT * FROM widget_messages WHERE kind = $1 AND chat_id = $2 AND message_id = $3 AND active', [kind, String(chatId), messageId]);
    return r.rows[0] || null;
}

module.exports = { upsert, get, mergeState, setMessage, deactivate, findByMessage };
