// Рассыльщик: уведомления клиенту, менеджеру, курьеру
// Использует Telegram Bot API для отправки сообщений

const https = require('https');

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

class Notifier {
    constructor(clientBotToken, courierBotToken, managerChatId, adminBotToken) {
        this.clientBotBase = `https://api.telegram.org/bot${clientBotToken}`;
        this.courierBotBase = `https://api.telegram.org/bot${courierBotToken}`;
        this.adminBotBase = adminBotToken ? `https://api.telegram.org/bot${adminBotToken}` : this.clientBotBase;
        this.managerChatId = managerChatId;
    }

    // Любой метод Bot API (sendMessage, editMessageReplyMarkup, ...).
    // При ошибке Telegram бросает Error с полями tgCode (error_code) и retryAfter (секунды, если Telegram просит подождать).
    _call(botBase, method, payload, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(payload);
            const url = new URL(`${botBase}/${method}`);
            const options = {
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                },
                timeout: timeoutMs
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    let json;
                    try { json = JSON.parse(body); } catch (e) {
                        const err = new Error(`Ответ Telegram не разобран (HTTP ${res.statusCode})`);
                        err.tgCode = res.statusCode;
                        return reject(err);
                    }
                    if (json.ok) return resolve(json.result);
                    const err = new Error(json.description || 'Telegram API error');
                    err.tgCode = json.error_code || res.statusCode;
                    if (json.parameters && json.parameters.retry_after) err.retryAfter = Number(json.parameters.retry_after);
                    reject(err);
                });
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    // Отправка сообщения через Telegram API
    _send(botBase, chatId, text, buttons = null) {
        const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
        if (buttons) payload.reply_markup = { inline_keyboard: buttons };
        return this._call(botBase, 'sendMessage', payload).catch(e => {
            console.error(`[NOTIFIER] Ошибка отправки chat_id=${chatId}: ${String(e.message).slice(0, 120)}`);
            throw e;
        });
    }

    // Уведомление клиенту о статусе заказа
    async notifyClient(chatId, orderNumber, status, details = '') {
        const statusTexts = {
            'confirmed': 'подтверждён',
            'assembling': 'собирается',
            'shipped': 'передан курьеру',
            'delivered': 'доставлен',
            'cancelled': 'отменён'
        };

        const statusText = statusTexts[status] || status;
        let text = `<b>Заказ ${escapeHtml(orderNumber)}</b>\n\n`;
        text += `Статус: <b>${statusText}</b>\n`;
        if (details) text += `${escapeHtml(details)}\n`;

        console.log(`[NOTIFIER] Отправка клиенту ${chatId}: ${escapeHtml(orderNumber)} -> ${statusText}`);
        return this._send(this.clientBotBase, chatId, text);
    }

    // Уведомление менеджеру о новом заказе
    async notifyManager(orderData) {
        if (!this.managerChatId) return;

        const itemsList = (orderData.items || [])
            .map(i => `- ${escapeHtml(i.name)} x${i.qty}`)
            .join('\n');

        let text = `<b>НОВЫЙ ЗАКАЗ ${escapeHtml(orderData.order_number || '')}</b>\n\n`;
        text += `<b>Клиент:</b> ${escapeHtml(orderData.user_name || 'Не указано')}\n`;
        text += `<b>Телефон:</b> ${escapeHtml(orderData.phone || 'Не указан')}\n`;
        text += `<b>Адрес:</b> ${escapeHtml(orderData.address || 'Не указан')}\n`;
        text += `<b>Сумма:</b> ${escapeHtml(orderData.total || 0)} руб.\n\n`;
        if (itemsList) text += `<b>Товары:</b>\n${itemsList}\n`;

        return this._send(this.adminBotBase, this.managerChatId, text);
    }

    // Уведомление курьеру о новом маршруте
    async notifyCourier(courierTelegramId, routeData) {
        const stopsCount = (routeData.stops || []).length;

        let text = `<b>Новый маршрут!</b>\n\n`;
        text += `Маршрут: ${escapeHtml(routeData.route_number)}\n`;
        text += `Дата: ${escapeHtml(routeData.route_date)}\n`;
        text += `Остановок: ${stopsCount}\n\n`;
        text += 'Отправьте /route для просмотра деталей.';

        return this._send(this.courierBotBase, courierTelegramId, text);
    }

    // Уведомление менеджеру о доставке
    async notifyManagerDelivery(routeNumber, stopData, status, reason = '') {
        if (!this.managerChatId) return;

        const statusText = status === 'delivered' ? 'Доставлено' : 'Не доставлено';
        let text = `[ДОСТАВКА] ${escapeHtml(routeNumber)} | ${statusText}\n`;
        text += `Адрес: ${escapeHtml(stopData.address)}\n`;
        if (stopData.order_number) text += `Заказ: ${escapeHtml(stopData.order_number)}\n`;
        if (reason) text += `Причина: ${escapeHtml(reason)}\n`;

        return this._send(this.adminBotBase, this.managerChatId, text);
    }

    // Уведомление клиенту о доставке
    async notifyClientDelivery(clientChatId, orderNumber, status, reason = '') {
        const statusText = status === 'delivered' ? 'доставлен' : 'не доставлен';
        let text = `<b>Заказ ${escapeHtml(orderNumber)}</b>\n\n`;
        text += `Ваш заказ <b>${statusText}</b>.\n`;
        if (reason) text += `Причина: ${escapeHtml(reason)}\n`;
        text += '\nСпасибо за покупку!';

        return this._send(this.clientBotBase, clientChatId, text);
    }
}

module.exports = Notifier;
module.exports.escapeHtml = escapeHtml;
