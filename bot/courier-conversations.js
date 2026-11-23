'use strict';
function createConversationStore({ ttlMs = 15 * 60_000, now = Date.now } = {}) {
    const conversations = new Map();
    const keyOf = (chatId, userId) => `${String(chatId)}:${String(userId)}`;
    function set(chatId, userId, type, payload = {}) {
        const timestamp = now();
        for (const [key, value] of conversations) if (timestamp - value.createdAt > ttlMs) conversations.delete(key);
        conversations.set(keyOf(chatId, userId), { type, payload, createdAt: timestamp });
    }
    function get(chatId, userId) {
        const key = keyOf(chatId, userId), value = conversations.get(key);
        if (!value) return null;
        if (now() - value.createdAt > ttlMs) { conversations.delete(key); return null; }
        return value;
    }
    function take(chatId, userId) { const value = get(chatId, userId); if (value) conversations.delete(keyOf(chatId, userId)); return value; }
    function clear(chatId, userId) { return conversations.delete(keyOf(chatId, userId)); }
    return { set, get, take, clear };
}
module.exports = { createConversationStore };
