// Рассыльщик: уведомления клиенту, менеджеру, курьеру
// Использует Telegram Bot API для отправки сообщений

const https = require('https');

class Notifier {
    constructor(clientBotToken, courierBotToken, managerChatId) {
        this.clientBotBase = `https://api.telegram.org/bot${clientBotToken}`;
        this.courierBotBase = `https://api.telegram.org/bot${courierBotToken}`;
        this.managerChatId = managerChatId;
    }

    // Отправка сообщения через Telegram API
    _send(botBase, chatId, text, buttons = null) {
        return new Promise((resolve, reject) => {
            const payload = {
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML'
            };
            if (buttons) {
                payload.reply_markup = { inline_keyboard: buttons };
            }

            const data = JSON.stringify(payload);
            const url = new URL(`${botBase}/sendMessage`);

            const options = {
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(body);
                        if (json.ok) resolve(json.result);
                        else reject(new Error(json.description || 'Telegram API error'));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.write(data);
            req.end();
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
        let text = `<b>Заказ ${orderNumber}</b>\n\n`;
        text += `Статус: <b>${statusText}</b>\n`;
        if (details) text += `${details}\n`;

        return this._send(this.clientBotBase, chatId, text);
    }

    // Уведомление менеджеру о новом заказе
    async notifyManager(orderData) {
        if (!this.managerChatId) return;

        const itemsList = (orderData.items || [])
            .map(i => `- ${i.name} x${i.qty}`)
            .join('\n');

        let text = `<b>НОВЫЙ ЗАКАЗ ${orderData.order_number || ''}</b>\n\n`;
        text += `<b>Клиент:</b> ${orderData.user_name || 'Не указано'}\n`;
        text += `<b>Телефон:</b> ${orderData.phone || 'Не указан'}\n`;
        text += `<b>Адрес:</b> ${orderData.address || 'Не указан'}\n`;
        text += `<b>Сумма:</b> ${orderData.total || 0} руб.\n\n`;
        if (itemsList) text += `<b>Товары:</b>\n${itemsList}\n`;

        return this._send(this.clientBotBase, this.managerChatId, text);
    }

    // Уведомление курьеру о новом маршруте
    async notifyCourier(courierTelegramId, routeData) {
        const stopsCount = (routeData.stops || []).length;

        let text = `<b>Новый маршрут!</b>\n\n`;
        text += `Маршрут: ${routeData.route_number}\n`;
        text += `Дата: ${routeData.route_date}\n`;
        text += `Остановок: ${stopsCount}\n\n`;
        text += 'Отправьте /route для просмотра деталей.';

        return this._send(this.courierBotBase, courierTelegramId, text);
    }

    // Уведомление менеджеру о доставке
    async notifyManagerDelivery(routeNumber, stopData, status, reason = '') {
        if (!this.managerChatId) return;

        const statusText = status === 'delivered' ? 'Доставлено' : 'Не доставлено';
        let text = `[ДОСТАВКА] ${routeNumber} | ${statusText}\n`;
        text += `Адрес: ${stopData.address}\n`;
        if (stopData.order_number) text += `Заказ: ${stopData.order_number}\n`;
        if (reason) text += `Причина: ${reason}\n`;

        return this._send(this.courierBotBase, this.managerChatId, text);
    }

    // Уведомление клиенту о доставке
    async notifyClientDelivery(clientChatId, orderNumber, status, reason = '') {
        const statusText = status === 'delivered' ? 'доставлен' : 'не доставлен';
        let text = `<b>Заказ ${orderNumber}</b>\n\n`;
        text += `Ваш заказ <b>${statusText}</b>.\n`;
        if (reason) text += `Причина: ${reason}\n`;
        text += '\nСпасибо за покупку!';

        return this._send(this.clientBotBase, clientChatId, text);
    }
}

module.exports = Notifier;
