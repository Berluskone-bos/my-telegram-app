const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Конфигурация
const COURIER_BOT_TOKEN = process.env.COURIER_BOT_TOKEN || '8495118590:AAEM_9w9zxHI6D6YIHEe6w0wLp1c0US01hM';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '695826264';
const PORT = process.env.COURIER_PORT || 3001;

const DATA_DIR = path.join(__dirname, '..', 'data');

// Инициализация бота
const bot = new TelegramBot(COURIER_BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json());

// ====== Утилиты для работы с данными ======

function readJSON(filename) {
    try {
        const filePath = path.join(DATA_DIR, filename);
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        console.error(`Error reading ${filename}:`, e.message);
        return [];
    }
}

function writeJSON(filename, data) {
    const filePath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function generateId(items) {
    if (items.length === 0) return 1;
    return Math.max(...items.map(i => i.id || 0)) + 1;
}

function generateRouteNumber() {
    const routes = readJSON('delivery-routes.json');
    const maxNum = routes.reduce((max, r) => {
        const num = parseInt(r.route_number.replace('RL-', ''));
        return num > max ? num : max;
    }, 0);
    return 'RL-' + String(maxNum + 1).padStart(4, '0');
}

// ====== Регистрация курьера ======

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    const couriers = readJSON('couriers.json');
    const existing = couriers.find(c => c.telegram_id === user.id);

    if (existing) {
        if (!existing.is_active) {
            bot.sendMessage(chatId, 'Ваш аккаунт деактивирован. Обратитесь к администратору.');
            return;
        }
        bot.sendMessage(chatId,
            `С возвращением, ${existing.name}!\n\n` +
            'Команды:\n' +
            '/route — текущий маршрут\n' +
            '/status — статус смены\n' +
            '/help — помощь',
            { parse_mode: 'HTML' }
        );
        return;
    }

    // Новый курьер — запрашиваем данные
    bot.sendMessage(chatId,
        'Добро пожаловать в систему доставки АВТОПРОМОЙЛ!\n\n' +
        'Для регистрации отправьте ваши данные в формате:\n\n' +
        '<b>Имя</b>\n' +
        '<b>Телефон</b>\n' +
        '<b>Транспорт</b> (легковая/грузовая/пешком)\n\n' +
        'Пример:\n' +
        'Иванов Иван\n+79001234567\nлегковая',
        { parse_mode: 'HTML' }
    );

    // Ожидаем следующее сообщение с данными
    bot.once('message', (regMsg) => {
        if (regMsg.chat.id !== chatId) return;
        if (regMsg.text && regMsg.text.startsWith('/')) return;

        const lines = (regMsg.text || '').split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) {
            bot.sendMessage(chatId, 'Нужно указать минимум имя и телефон. Попробуйте /start заново.');
            return;
        }

        const name = lines[0];
        const phone = lines[1] || '';
        const vehicle = lines[2] || 'легковая';

        const newCourier = {
            id: generateId(couriers),
            name: name,
            phone: phone,
            telegram_id: user.id,
            telegram_user: user.username || '',
            vehicle_type: vehicle,
            zones: ['spb'],
            is_active: true,
            max_orders: 10,
            created_at: new Date().toISOString()
        };

        couriers.push(newCourier);
        writeJSON('couriers.json', couriers);

        bot.sendMessage(chatId,
            `Регистрация завершена!\n\n` +
            `Имя: ${name}\n` +
            `Телефон: ${phone}\n` +
            `Транспорт: ${vehicle}\n\n` +
            'Ожидайте маршрутный лист от диспетчера.\n' +
            'Команды: /route /status /help',
            { parse_mode: 'HTML' }
        );

        // Уведомляем админа
        bot.sendMessage(ADMIN_CHAT_ID,
            `[КУРЬЕР] Зарегистрирован: ${name} (@${user.username || 'нет'})\nТел: ${phone}\nТранспорт: ${vehicle}`
        ).catch(() => {});
    });
});

// ====== Команда /route — текущий маршрут ======

bot.onText(/\/route/, (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    const couriers = readJSON('couriers.json');
    const courier = couriers.find(c => c.telegram_id === user.id);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const routes = readJSON('delivery-routes.json');
    const today = new Date().toISOString().split('T')[0];
    const activeRoute = routes.find(r =>
        r.courier_id === courier.id &&
        r.route_date === today &&
        ['assigned', 'in_progress'].includes(r.status)
    );

    if (!activeRoute) {
        bot.sendMessage(chatId, 'На сегодня маршрутов нет.');
        return;
    }

    const stops = activeRoute.stops || [];
    const completed = stops.filter(s => s.status === 'delivered').length;
    const failed = stops.filter(s => s.status === 'failed').length;

    let text = `<b>Маршрут ${activeRoute.route_number}</b>\n`;
    text += `Дата: ${activeRoute.route_date}\n`;
    text += `Остановок: ${stops.length} | Доставлено: ${completed} | Не доставлено: ${failed}\n\n`;

    stops.forEach((stop, idx) => {
        const statusIcon = stop.status === 'delivered' ? '[OK]' :
                          stop.status === 'failed' ? '[X]' : `[${idx + 1}]`;
        text += `${statusIcon} ${stop.address}\n`;
        if (stop.order_number) text += `   Заказ: ${stop.order_number}\n`;
        if (stop.amount_to_pay > 0) text += `   Сумма: ${stop.amount_to_pay} руб.\n`;
        text += '\n';
    });

    const buttons = [];
    stops.forEach((stop, idx) => {
        if (stop.status === 'pending') {
            buttons.push([
                { text: `[${idx + 1}] Доставлено`, callback_data: `delivered_${activeRoute.id}_${stop.id}` },
                { text: `[${idx + 1}] Не доставлено`, callback_data: `failed_${activeRoute.id}_${stop.id}` }
            ]);
            // Кнопки навигации
            buttons.push([
                { text: `[${idx + 1}] Яндекс.Карты`, url: stop.yandex_url || 'https://yandex.ru/maps' },
                { text: `[${idx + 1}] 2GIS`, url: stop.gis2_url || 'https://2gis.ru' }
            ]);
        }
    });

    bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
    });
});

// ====== Обработка кнопок доставки ======

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('delivered_')) {
        const [, routeId, stopId] = data.split('_');
        handleDeliveryResult(parseInt(routeId), parseInt(stopId), 'delivered', chatId, query.id);
    } else if (data.startsWith('failed_')) {
        const [, routeId, stopId] = data.split('_');
        // Запрашиваем причину
        bot.sendMessage(chatId, 'Укажите причину не доставки:');
        bot.once('message', (msg) => {
            if (msg.chat.id !== chatId) return;
            const reason = msg.text || 'Не указана';
            handleDeliveryResult(parseInt(routeId), parseInt(stopId), 'failed', chatId, query.id, reason);
        });
        bot.answerCallbackQuery(query.id);
    }
});

function handleDeliveryResult(routeId, stopId, status, chatId, callbackQueryId, reason = '') {
    const routes = readJSON('delivery-routes.json');
    const route = routes.find(r => r.id === routeId);
    if (!route) {
        bot.answerCallbackQuery(callbackQueryId, { text: 'Маршрут не найден' });
        return;
    }

    const stop = (route.stops || []).find(s => s.id === stopId);
    if (!stop) {
        bot.answerCallbackQuery(callbackQueryId, { text: 'Остановка не найдена' });
        return;
    }

    stop.status = status;
    stop.delivered_at = new Date().toISOString();
    if (reason) stop.fail_reason = reason;

    // Обновляем счётчики маршрута
    route.completed = (route.stops || []).filter(s => s.status === 'delivered').length;
    route.failed = (route.stops || []).filter(s => s.status === 'failed').length;

    // Проверяем, завершён ли маршрут
    const allDone = (route.stops || []).every(s => s.status !== 'pending');
    if (allDone) {
        route.status = 'completed';
        route.completed_at = new Date().toISOString();
    } else if (route.status === 'assigned') {
        route.status = 'in_progress';
        route.started_at = route.started_at || new Date().toISOString();
    }

    writeJSON('delivery-routes.json', routes);

    const statusText = status === 'delivered' ? 'Доставлено' : 'Не доставлено';
    bot.answerCallbackQuery(callbackQueryId, { text: `${statusText}: ${stop.address}` });
    bot.sendMessage(chatId, `${statusText}: ${stop.address}${reason ? '\nПричина: ' + reason : ''}`);

    // Уведомляем админа
    bot.sendMessage(ADMIN_CHAT_ID,
        `[ДОСТАВКА] ${route.route_number} | ${statusText}\nАдрес: ${stop.address}${stop.order_number ? '\nЗаказ: ' + stop.order_number : ''}${reason ? '\nПричина: ' + reason : ''}`
    ).catch(() => {});
}

// ====== Команда /status — статус смены ======

bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    const couriers = readJSON('couriers.json');
    const courier = couriers.find(c => c.telegram_id === user.id);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const routes = readJSON('delivery-routes.json');
    const today = new Date().toISOString().split('T')[0];
    const todayRoutes = routes.filter(r => r.courier_id === courier.id && r.route_date === today);

    let totalDelivered = 0;
    let totalFailed = 0;
    let totalCash = 0;

    todayRoutes.forEach(r => {
        totalDelivered += r.completed || 0;
        totalFailed += r.failed || 0;
        totalCash += r.cash_collected || 0;
    });

    bot.sendMessage(chatId,
        `<b>Статус смены</b>\n\n` +
        `Курьер: ${courier.name}\n` +
        `Маршрутов сегодня: ${todayRoutes.length}\n` +
        `Доставлено: ${totalDelivered}\n` +
        `Не доставлено: ${totalFailed}\n` +
        `Собрано наличных: ${totalCash} руб.`,
        { parse_mode: 'HTML' }
    );
});

// ====== Команда /help ======

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
        '<b>Команды курьера</b>\n\n' +
        '/start — регистрация\n' +
        '/route — текущий маршрут\n' +
        '/status — статус смены\n' +
        '/help — эта справка\n\n' +
        'По вопросам: @avtopromol_support',
        { parse_mode: 'HTML' }
    );
});

// ====== API для диспетчера ======

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', bot: 'APCourier_Bot', timestamp: new Date().toISOString() });
});

// Получить список курьеров
app.get('/api/couriers', (req, res) => {
    res.json(readJSON('couriers.json'));
});

// Создать маршрут
app.post('/api/routes', (req, res) => {
    const { courier_id, route_date, stops } = req.body;

    const routes = readJSON('delivery-routes.json');
    const newRoute = {
        id: generateId(routes),
        route_number: generateRouteNumber(),
        route_date: route_date || new Date().toISOString().split('T')[0],
        courier_id: courier_id,
        status: 'draft',
        total_orders: stops ? stops.length : 0,
        completed: 0,
        failed: 0,
        cash_to_collect: 0,
        cash_collected: 0,
        stops: stops || [],
        started_at: null,
        completed_at: null,
        created_at: new Date().toISOString()
    };

    routes.push(newRoute);
    writeJSON('delivery-routes.json', routes);
    res.json(newRoute);
});

// Назначить маршрут курьеру (отправить уведомление)
app.post('/api/routes/:id/assign', (req, res) => {
    const routeId = parseInt(req.params.id);
    const routes = readJSON('delivery-routes.json');
    const route = routes.find(r => r.id === routeId);

    if (!route) return res.status(404).json({ error: 'Route not found' });

    const couriers = readJSON('couriers.json');
    const courier = couriers.find(c => c.id === route.courier_id);

    if (!courier) return res.status(404).json({ error: 'Courier not found' });

    route.status = 'assigned';
    writeJSON('delivery-routes.json', routes);

    // Уведомляем курьера
    const stopsCount = (route.stops || []).length;
    bot.sendMessage(courier.telegram_id,
        `<b>Новый маршрут!</b>\n\n` +
        `Маршрут: ${route.route_number}\n` +
        `Дата: ${route.route_date}\n` +
        `Остановок: ${stopsCount}\n\n` +
        'Отправьте /route для просмотра деталей.',
        { parse_mode: 'HTML' }
    ).then(() => {
        res.json({ success: true, message: 'Courier notified' });
    }).catch(err => {
        res.json({ success: false, error: err.message });
    });
});

// Получить маршруты
app.get('/api/routes', (req, res) => {
    res.json(readJSON('delivery-routes.json'));
});

// Получить зоны доставки
app.get('/api/zones', (req, res) => {
    res.json(readJSON('delivery-zones.json'));
});

// Запуск
app.listen(PORT, () => {
    console.log(`Courier bot API running on port ${PORT}`);
});

console.log('APCourier_Bot started');
