'use strict';

// Курьерский бот работает только в личном чате: ID личного чата Telegram совпадает с user ID.
function isPrivateCourierMessage(message) {
    return Boolean(message
        && message.chat
        && message.chat.type === 'private'
        && message.from
        && String(message.chat.id) === String(message.from.id));
}

function isPrivateCourierCallback(query) {
    return Boolean(query
        && query.message
        && query.message.chat
        && query.message.chat.type === 'private'
        && query.from
        && String(query.message.chat.id) === String(query.from.id));
}

function isSameTelegramSender(message, originalMessage) {
    return Boolean(message && message.from && originalMessage && originalMessage.from
        && String(message.from.id) === String(originalMessage.from.id));
}

module.exports = { isPrivateCourierMessage, isPrivateCourierCallback, isSameTelegramSender };
