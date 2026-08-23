const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const Geocoder = require('./services/geocoder');
const MapLinks = require('./services/map-links');
const RouteOptimizer = require('./services/route-optimizer');
const Notifier = require('./services/notifier');
const db = require('./db-adapter');

// Конфигурация
const COURIER_BOT_TOKEN = process.env.COURIER_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const YANDEX_GEO_KEY = process.env.YANDEX_GEO_KEY || '';

const geocoder = new Geocoder(YANDEX_GEO_KEY);
const notifier = new Notifier(process.env.BOT_TOKEN || '', COURIER_BOT_TOKEN, ADMIN_CHAT_ID);

let bot;
if (COURIER_BOT_TOKEN) {
    bot = new TelegramBot(COURIER_BOT_TOKEN, { polling: true });
}

// ====== Утилиты ======

function generateRouteNumber() {
    return 'RL-' + String(Date.now()).slice(-4);
}

async function getCourier(user) {
    return await db.getCourierByTelegramId(user.id);
}

async function getTodayRoutes(courierId) {
    const today = new Date().toISOString().split('T')[0];
    return await db.getRoutesByDateAndCourier(today, courierId);
}

async function getActiveRoute(courierId) {
    const routes = await getTodayRoutes(courierId);
    return routes.find(r => ['assigned', 'in_progress'].includes(r.status));
}

// ====== /start — Регистрация ======

if (bot) {
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const courier = await getCourier(user);

    if (courier) {
        if (!courier.is_active) {
            bot.sendMessage(chatId, 'Ваш аккаунт деактивирован. Обратитесь к администратору.');
            return;
        }
        showMainScreen(chatId, courier);
        return;
    }

    bot.sendMessage(chatId,
        'Добро пожаловать в систему доставки АВТОПРОМОЙЛ!\n\n' +
        'Для регистрации отправьте ваши данные в формате:\n\n' +
        '<b>Имя Фамилия</b>\n' +
        '<b>Телефон</b>\n' +
        '<b>Транспорт</b> (легковая/грузовая/пешком)\n\n' +
        'Пример:\nИванов Иван\n+79001234567\nлегковая',
        { parse_mode: 'HTML' }
    );

    bot.once('message', async (regMsg) => {
        if (regMsg.chat.id !== chatId) return;
        if (regMsg.text && regMsg.text.startsWith('/')) return;

        const lines = (regMsg.text || '').split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) {
            bot.sendMessage(chatId, 'Нужно указать минимум имя и телефон. Попробуйте /start заново.');
            return;
        }

        const newCourier = await db.createCourier({
            name: lines[0],
            phone: lines[1] || '',
            telegram_id: user.id,
            telegram_user: user.username || '',
            vehicle_type: lines[2] || 'легковая',
            zones: ['spb'],
            is_active: true,
            max_orders: 10,
            rating: 0,
            rating_count: 0
        });

        bot.sendMessage(chatId,
            `Регистрация завершена!\n\nИмя: ${newCourier.name}\nТелефон: ${newCourier.phone}\nТранспорт: ${newCourier.vehicle_type}\n\nОжидайте маршрутный лист от диспетчера.`,
            { parse_mode: 'HTML' }
        );

        bot.sendMessage(ADMIN_CHAT_ID,
            `[КУРЬЕР] Зарегистрирован: ${newCourier.name} (@${user.username || '-'})\nТел: ${newCourier.phone}\nТранспорт: ${newCourier.vehicle_type}`
        ).catch(() => {});
    });
});

// ====== Главный экран курьера ======

async function showMainScreen(chatId, courier) {
    const todayRoutes = await getTodayRoutes(courier.id);
    const activeRoute = await getActiveRoute(courier.id);
    const stops = activeRoute ? (activeRoute.stops || []) : [];
    const totalStops = stops.length;
    const delivered = stops.filter(s => s.status === 'delivered').length;
    const failed = stops.filter(s => s.status === 'failed').length;
    const remaining = totalStops - delivered - failed;

    let text = `<b>АВТОПРОМОЙЛ — Курьер</b>\n\n`;
    text += `Добрый день, ${courier.name}!\n\n`;
    text += `<b>Сегодня:</b>\n`;
    text += `Доставок: ${totalStops}\n`;
    text += `Выполнено: ${delivered}\n`;
    text += `Осталось: ${remaining}\n`;

    if (activeRoute) {
        text += `\n<b>Маршрут ${activeRoute.route_number}</b>\n`;
        text += `Статус: ${activeRoute.status === 'in_progress' ? 'В пути' : 'Назначен'}\n`;
    }

    const buttons = [];
    if (activeRoute && stops.length > 0) {
        if (activeRoute.status === 'assigned') {
            buttons.push([{ text: 'Поехал!', callback_data: `startroute_${activeRoute.id}` }]);
        }
        buttons.push([{ text: 'Маршрутный лист', callback_data: `showroute_${activeRoute.id}` }]);
        buttons.push([{ text: 'Построить маршрут', callback_data: `optimizeroute_${activeRoute.id}` }]);
    }
    buttons.push([{ text: 'Обновить', callback_data: 'refresh_main' }]);

    bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
    });
}

// ====== /today — Сегодняшние доставки ======

bot.onText(/\/today/, async (msg) => {
    const chatId = msg.chat.id;
    const courier = await getCourier(msg.from);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const todayRoutes = await getTodayRoutes(courier.id);
    if (todayRoutes.length === 0) {
        bot.sendMessage(chatId, 'На сегодня доставок нет.');
        return;
    }

    let text = `<b>Доставки на сегодня</b>\n\n`;

    todayRoutes.forEach(route => {
        const stops = route.stops || [];
        const delivered = stops.filter(s => s.status === 'delivered').length;
        text += `<b>${route.route_number}</b> — ${stops.length} остановок (${delivered} доставлено)\n`;
        stops.forEach((stop, idx) => {
            const icon = stop.status === 'delivered' ? '[OK]' : stop.status === 'failed' ? '[X]' : `[${idx + 1}]`;
            text += `  ${icon} ${stop.order_number || ''} ${stop.address}\n`;
        });
        text += '\n';
    });

    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// ====== /route — Маршрутный лист (детальный) ======

bot.onText(/\/route/, async (msg) => {
    const chatId = msg.chat.id;
    const courier = await getCourier(msg.from);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const activeRoute = await getActiveRoute(courier.id);
    if (!activeRoute) {
        bot.sendMessage(chatId, 'На сегодня маршрутов нет.');
        return;
    }

    sendRouteDetails(chatId, activeRoute);
});

async function sendRouteDetails(chatId, route) {
    const stops = route.stops || [];
    const completed = stops.filter(s => s.status === 'delivered').length;
    const failed = stops.filter(s => s.status === 'failed').length;

    let text = `<b>Маршрут ${route.route_number}</b>\n`;
    text += `Дата: ${route.route_date}\n`;
    text += `Остановок: ${stops.length} | Доставлено: ${completed} | Не доставлено: ${failed}\n\n`;

    stops.forEach((stop, idx) => {
        const statusIcon = stop.status === 'delivered' ? '[OK]' :
                          stop.status === 'failed' ? '[X]' : `[${idx + 1}]`;
        text += `<b>${statusIcon} ${stop.order_number || ''}</b>\n`;
        text += `Адрес: ${stop.address}\n`;
        if (stop.items_count) text += `Товаров: ${stop.items_count}\n`;
        if (stop.amount_to_pay > 0) {
            text += `Сумма: ${stop.amount_to_pay} руб. [${stop.payment_status === 'paid' ? 'ОПЛАЧЕНО' : 'ОПЛАТА НА МЕСТЕ'}]\n`;
        }
        if (stop.phone) text += `Телефон: ${stop.phone}\n`;
        if (stop.time_window) text += `Окно: ${stop.time_window}\n`;
        if (stop.comment) text += `Комментарий: ${stop.comment}\n`;
        text += '\n';
    });

    const buttons = [];
    stops.forEach((stop, idx) => {
        if (stop.status === 'pending') {
            const yandexUrl = stop.lat && stop.lon
                ? MapLinks.yandex(stop.address, parseFloat(stop.lat), parseFloat(stop.lon))
                : MapLinks.yandex(stop.address);
            const gis2Url = stop.lat && stop.lon
                ? MapLinks.gis2(parseFloat(stop.lat), parseFloat(stop.lon))
                : 'https://2gis.ru';
            buttons.push([
                { text: `[${idx + 1}] Навигация`, url: yandexUrl },
                { text: `[${idx + 1}] 2GIS`, url: gis2Url }
            ]);
            buttons.push([
                { text: `[${idx + 1}] Доставлено`, callback_data: `delivered_${route.id}_${stop.id}` },
                { text: `[${idx + 1}] Не доставлено`, callback_data: `failed_${route.id}_${stop.id}` }
            ]);
            if (stop.phone) {
                buttons.push([
                    { text: `[${idx + 1}] Позвонить клиенту`, url: `tel:${stop.phone}` }
                ]);
            }
        }
    });

    if (stops.filter(s => s.status === 'pending').length >= 2) {
        buttons.push([{ text: 'Построить маршрут', callback_data: `optimizeroute_${route.id}` }]);
    }

    bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
    });
}

// ====== /done — Быстрая отметка доставки ======

bot.onText(/\/done/, async (msg) => {
    const chatId = msg.chat.id;
    const courier = await getCourier(msg.from);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const activeRoute = await getActiveRoute(courier.id);
    if (!activeRoute) {
        bot.sendMessage(chatId, 'Нет активного маршрута.');
        return;
    }

    const pendingStops = (activeRoute.stops || []).filter(s => s.status === 'pending');
    if (pendingStops.length === 0) {
        bot.sendMessage(chatId, 'Все доставки выполнены!');
        return;
    }

    const buttons = pendingStops.map((stop, idx) => [{
        text: `${stop.order_number || '#' + (idx + 1)} — ${stop.address}`,
        callback_data: `quickdelivered_${activeRoute.id}_${stop.id}`
    }]);

    bot.sendMessage(chatId, '<b>Выберите доставку для отметки:</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
    });
});

// ====== /status — Статистика ======

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const courier = await getCourier(msg.from);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const todayRoutes = await getTodayRoutes(courier.id);
    let totalDelivered = 0, totalFailed = 0, totalCash = 0;

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

// ====== /help ======

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
        '<b>Команды курьера</b>\n\n' +
        '/start — регистрация / главный экран\n' +
        '/route — текущий маршрутный лист\n' +
        '/today — сегодняшние доставки\n' +
        '/done — быстрая отметка доставки\n' +
        '/status — статус смены\n' +
        '/help — эта справка\n\n' +
        'По вопросам: @avtopromol_support',
        { parse_mode: 'HTML' }
    );
});

// ====== Обработка callback-кнопок ======

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('showroute_')) {
        const routeId = parseInt(data.split('_')[1]);
        const route = await db.getRouteById(routeId);
        if (route) sendRouteDetails(chatId, route);
        bot.answerCallbackQuery(query.id);
        return;
    }

    if (data === 'refresh_main') {
        const courier = await getCourier(query.from);
        if (courier) showMainScreen(chatId, courier);
        bot.answerCallbackQuery(query.id);
        return;
    }

    if (data.startsWith('startroute_')) {
        const routeId = parseInt(data.split('_')[1]);
        handleStartRoute(chatId, routeId, query.from);
        bot.answerCallbackQuery(query.id, { text: 'Маршрут начат!' });
        return;
    }

    if (data.startsWith('optimizeroute_')) {
        const routeId = parseInt(data.split('_')[1]);
        handleOptimizeRoute(chatId, routeId);
        bot.answerCallbackQuery(query.id);
        return;
    }

    if (data.startsWith('delivered_')) {
        const [, routeId, stopId] = data.split('_');
        handleDeliveryResult(parseInt(routeId), parseInt(stopId), 'delivered', chatId, query.id);
        return;
    }

    if (data.startsWith('quickdelivered_')) {
        const [, routeId, stopId] = data.split('_');
        handleDeliveryResult(parseInt(routeId), parseInt(stopId), 'delivered', chatId, query.id);
        return;
    }

    if (data.startsWith('failed_')) {
        const [, routeId, stopId] = data.split('_');
        showFailureReasons(chatId, parseInt(routeId), parseInt(stopId));
        bot.answerCallbackQuery(query.id);
        return;
    }

    if (data.startsWith('failreason_')) {
        const parts = data.split('_');
        const routeId = parseInt(parts[1]);
        const stopId = parseInt(parts[2]);
        const reason = parts.slice(3).join('_');
        handleDeliveryResult(routeId, stopId, 'failed', chatId, query.id, reason);
        return;
    }

    if (data.startsWith('rate_')) {
        const parts = data.split('_');
        const courierId = parseInt(parts[1]);
        const rating = parseInt(parts[3]);
        await db.updateCourierRating(courierId, rating);
        bot.answerCallbackQuery(query.id, { text: `Спасибо за оценку ${rating}!` });
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: chatId,
            message_id: query.message.message_id
        });
        bot.sendMessage(chatId, `Спасибо за оценку ${rating}/5!`);
        return;
    }
});

// ====== Старт маршрута ======

async function handleStartRoute(chatId, routeId, user) {
    const route = await db.getRouteById(routeId);
    if (!route) return;

    await db.updateRouteStatus(routeId, 'in_progress', route.completed || 0, route.failed || 0);

    bot.sendMessage(chatId, 'Маршрут начат! Удачи в доставке!');

    const stops = route.stops || [];
    for (const stop of stops) {
        if (stop.status === 'pending' && stop.client_chat_id) {
            const timeText = stop.time_window ? `, ожидайте ${stop.time_window}` : '';
            bot.sendMessage(stop.client_chat_id,
                `<b>Курьер в пути!</b>\n\nЗаказ: ${stop.order_number || ''}\nАдрес: ${stop.address}\nКурьер уже выехал к вам${timeText}.\n\nОжидайте доставку.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
    }

    bot.sendMessage(ADMIN_CHAT_ID, `[МАРШРУТ] ${route.route_number} начат курьером ${user.first_name || ''}`).catch(() => {});
}

// ====== Причины не доставки ======

function showFailureReasons(chatId, routeId, stopId) {
    const buttons = [
        [{ text: 'Клиента нет дома', callback_data: `failreason_${routeId}_${stopId}_Клиента нет дома` }],
        [{ text: 'Не отвечает на звонки', callback_data: `failreason_${routeId}_${stopId}_Не отвечает на звонки` }],
        [{ text: 'Неверный адрес', callback_data: `failreason_${routeId}_${stopId}_Неверный адрес` }],
        [{ text: 'Клиент отказался', callback_data: `failreason_${routeId}_${stopId}_Клиент отказался` }],
        [{ text: 'Другое (ввести вручную)', callback_data: `failreason_${routeId}_${stopId}_Другое` }]
    ];

    bot.sendMessage(chatId, '<b>Причина не доставки:</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
    });
}

// ====== Обработка результата доставки ======

async function handleDeliveryResult(routeId, stopId, status, chatId, callbackQueryId, reason = '') {
    const route = await db.getRouteById(routeId);
    if (!route) {
        if (callbackQueryId) bot.answerCallbackQuery(callbackQueryId, { text: 'Маршрут не найден' });
        return;
    }

    const stop = (route.stops || []).find(s => s.id === stopId);
    if (!stop) {
        if (callbackQueryId) bot.answerCallbackQuery(callbackQueryId, { text: 'Остановка не найдена' });
        return;
    }

    if (reason === 'Другое') {
        if (callbackQueryId) bot.answerCallbackQuery(callbackQueryId);
        bot.sendMessage(chatId, 'Введите причину:');
        bot.once('message', async (msg) => {
            if (msg.chat.id !== chatId) return;
            const customReason = msg.text || 'Не указана';
            handleDeliveryResult(routeId, stopId, 'failed', chatId, null, customReason);
        });
        return;
    }

    await db.updateStopStatus(stopId, status, reason);

    const stops = route.stops || [];
    const newCompleted = stops.filter(s => s.status === 'delivered' || (s.id === stopId && status === 'delivered')).length;
    const newFailed = stops.filter(s => s.status === 'failed' || (s.id === stopId && status === 'failed')).length;
    const allDone = stops.every(s => s.id === stopId ? status !== 'pending' : s.status !== 'pending');
    const newStatus = allDone ? 'completed' : (route.status === 'assigned' ? 'in_progress' : route.status);

    await db.updateRouteStatus(routeId, newStatus, newCompleted, newFailed);

    const statusText = status === 'delivered' ? 'Доставлено' : 'Не доставлено';
    if (callbackQueryId) {
        bot.answerCallbackQuery(callbackQueryId, { text: `${statusText}: ${stop.address}` });
    }

    bot.sendMessage(chatId, `${statusText}: ${stop.order_number || ''}\nАдрес: ${stop.address}${reason ? '\nПричина: ' + reason : ''}`);

    bot.sendMessage(ADMIN_CHAT_ID,
        `[ДОСТАВКА] ${route.route_number} | ${statusText}\nАдрес: ${stop.address}${stop.order_number ? '\nЗаказ: ' + stop.order_number : ''}${reason ? '\nПричина: ' + reason : ''}`
    ).catch(() => {});

    if (stop.client_chat_id) {
        if (status === 'delivered') {
            bot.sendMessage(stop.client_chat_id,
                `<b>Заказ ${stop.order_number || ''} доставлен!</b>\n\nСпасибо за покупку в АВТОПРОМОЙЛ!\n\nПожалуйста, оцените доставку:`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '1', callback_data: `rate_${route.courier_id}_${stop.id}_1` },
                            { text: '2', callback_data: `rate_${route.courier_id}_${stop.id}_2` },
                            { text: '3', callback_data: `rate_${route.courier_id}_${stop.id}_3` },
                            { text: '4', callback_data: `rate_${route.courier_id}_${stop.id}_4` },
                            { text: '5', callback_data: `rate_${route.courier_id}_${stop.id}_5` }
                        ]]
                    }
                }
            ).catch(() => {});
        } else {
            bot.sendMessage(stop.client_chat_id, `<b>Заказ ${stop.order_number || ''}</b>\nНе удалось доставить. Причина: ${reason || 'Не указана'}`, { parse_mode: 'HTML' }).catch(() => {});
        }
    }
}

// ====== Оптимизация маршрута ======

async function handleOptimizeRoute(chatId, routeId) {
    const route = await db.getRouteById(routeId);
    if (!route) {
        bot.sendMessage(chatId, 'Маршрут не найден.');
        return;
    }

    const stops = route.stops || [];
    const pendingStops = stops.filter(s => s.status === 'pending' && s.lat && s.lon);

    if (pendingStops.length < 2) {
        bot.sendMessage(chatId, 'Недостаточно остановок с координатами для оптимизации.');
        return;
    }

    const optimized = RouteOptimizer.optimizeRoute(pendingStops);
    const distance = RouteOptimizer.calcDistance(optimized);

    let text = `<b>Маршрут оптимизирован!</b>\n\nОптимальный порядок:\n`;
    optimized.forEach((stop, idx) => {
        text += `${idx + 1}. ${stop.order_number || ''} — ${stop.address}\n`;
    });
    text += `\nРасстояние: ~${distance} км\n`;

    const allLinks = MapLinks.allRoute(optimized);
    const buttons = [
        [{ text: 'Яндекс Карты', url: allLinks.yandex }],
        [{ text: 'Google Maps', url: allLinks.google }],
        [{ text: '2GIS', url: allLinks.gis2 }]
    ];

    bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
    });
}

// ====== Обработка фото ======

bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const courier = await getCourier(msg.from);
    if (!courier) return;

    const activeRoute = await getActiveRoute(courier.id);
    if (!activeRoute) return;

    const pendingStops = (activeRoute.stops || []).filter(s => s.status === 'pending');
    if (pendingStops.length === 0) return;

    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    bot.sendMessage(chatId, 'Фото получено. К какому заказу привязать?\n\nОтправьте номер заказа (например: AP-000001) или нажмите /route для выбора.', { parse_mode: 'HTML' });

    bot.once('message', async (orderMsg) => {
        if (orderMsg.chat.id !== chatId) return;
        const orderNum = (orderMsg.text || '').trim();
        const stop = pendingStops.find(s => s.order_number === orderNum);
        if (stop) {
            await db.updateStopPhoto(stop.id, fileId);
            bot.sendMessage(chatId, `Фото привязано к заказу ${orderNum}`);
        } else {
            bot.sendMessage(chatId, 'Заказ не найден. Фото сохранено, привяжите позже через /route.');
        }
    });
});

// ====== Настройка команд ======

async function setupCourierBotCommands() {
    try {
        await bot.setMyCommands([
            { command: 'start', description: 'Регистрация / главный экран' },
            { command: 'route', description: 'Текущий маршрутный лист' },
            { command: 'today', description: 'Сегодняшние доставки' },
            { command: 'done', description: 'Отметить доставку выполненной' },
            { command: 'status', description: 'Статус смены' },
            { command: 'help', description: 'Справка' }
        ]);
        console.log('[OK] Команды курьер-бота установлены');
    } catch (e) {
        console.error('[ОШИБКА] Настройка команд курьер-бота:', e.message);
    }
}

setupCourierBotCommands();
} // end if (bot)

// ====== API для диспетчера ======

function registerCourierRoutes(app) {
    app.use(express.json());

    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', bots: ['AutoPromoilBot', 'APCourier_Bot'], timestamp: new Date().toISOString() });
    });

    app.get('/api/couriers', async (req, res) => {
        try { res.json(await db.getCouriers()); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/routes', async (req, res) => {
        try {
            const { courier_id, route_date, stops } = req.body;
            const processedStops = [];
            if (stops && stops.length > 0) {
                for (let i = 0; i < stops.length; i++) {
                    const stop = stops[i];
                    const processed = { ...stop, stop_number: i + 1, status: 'pending' };
                    if (!processed.lat && processed.address && YANDEX_GEO_KEY) {
                        try {
                            const geo = await geocoder.geocode(processed.address);
                            if (geo) { processed.lat = geo.lat; processed.lon = geo.lon; }
                        } catch (e) { console.log(`Геокодирование не удалось: ${e.message}`); }
                    }
                    if (processed.lat && processed.lon) {
                        processed.yandex_url = MapLinks.yandex(processed.address, processed.lat, processed.lon);
                        processed.google_url = MapLinks.google(processed.lat, processed.lon);
                        processed.gis2_url = MapLinks.gis2(processed.lat, processed.lon);
                    }
                    processedStops.push(processed);
                }
            }
            const route = await db.createRoute({
                route_number: generateRouteNumber(),
                route_date: route_date || new Date().toISOString().split('T')[0],
                courier_id, status: 'draft',
                total_orders: processedStops.length,
                stops: processedStops
            });
            res.json(route);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/routes/:id/assign', async (req, res) => {
        try {
            const route = await db.getRouteById(parseInt(req.params.id));
            if (!route) return res.status(404).json({ error: 'Route not found' });
            const couriers = await db.getCouriers();
            const courier = couriers.find(c => c.id === route.courier_id);
            if (!courier) return res.status(404).json({ error: 'Courier not found' });
            await db.updateRouteStatus(route.id, 'assigned', route.completed || 0, route.failed || 0);
            bot.sendMessage(courier.telegram_id,
                `<b>Новый маршрут!</b>\n\nМаршрут: ${route.route_number}\nДата: ${route.route_date}\nОстановок: ${(route.stops||[]).length}\n\nОтправьте /route для просмотра.`,
                { parse_mode: 'HTML' }
            ).then(() => res.json({ success: true })).catch(err => res.json({ success: false, error: err.message }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/routes', async (req, res) => {
        try { res.json(await db.getRoutes()); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/orders', async (req, res) => {
        try { res.json(await db.getOrders()); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/zones', async (req, res) => {
        try { res.json(await db.getZones()); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/geocode', async (req, res) => {
        const address = req.query.address;
        if (!address) return res.status(400).json({ error: 'address required' });
        try {
            const result = await geocoder.geocode(address);
            res.json(result ? { found: true, ...result } : { found: false });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/map-links', (req, res) => {
        const { address, lat, lon } = req.query;
        if (!address && (!lat || !lon)) return res.status(400).json({ error: 'address or lat/lon required' });
        res.json(MapLinks.all(address || '', parseFloat(lat), parseFloat(lon)));
    });

    app.post('/api/map-links/route', (req, res) => {
        const { stops } = req.body;
        if (!stops || stops.length < 2) return res.status(400).json({ error: 'stops array with 2+ required' });
        res.json(MapLinks.allRoute(stops));
    });

    app.post('/api/routes/:id/optimize', async (req, res) => {
        try {
            const route = await db.getRouteById(parseInt(req.params.id));
            if (!route) return res.status(404).json({ error: 'Route not found' });
            const stops = route.stops || [];
            if (stops.length < 2) return res.json({ message: 'Nothing to optimize', stops });
            const { start_lat, start_lon } = req.body;
            const optimized = RouteOptimizer.optimizeRoute(stops, start_lat || 59.9343, start_lon || 30.3351);
            const distance = RouteOptimizer.calcDistance(optimized, start_lat || 59.9343, start_lon || 30.3351);
            res.json({ route_number: route.route_number, stops: optimized, total_distance_km: distance });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/dispatch/stats', async (req, res) => {
        try {
            const date = req.query.date || new Date().toISOString().split('T')[0];
            res.json(await db.getDayStats(date));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/dispatch/unassigned-orders', async (req, res) => {
        try { res.json(await db.getOrders()); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/analytics', async (req, res) => {
        try {
            const from = req.query.date_from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const to = req.query.date_to || new Date().toISOString().split('T')[0];
            res.json(await db.getAnalytics(from, to));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ====== Admin: управление заказами ======
    app.put('/api/orders/:id/status', async (req, res) => {
        try {
            const { status } = req.body;
            const valid = ['NEW', 'CONFIRMED', 'ASSEMBLING', 'SHIPPING', 'DELIVERED', 'CANCELLED'];
            if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
            const orderId = parseInt(req.params.id);
            await db.updateOrderStatus(orderId, status);

            // Уведомление клиенту о смене статуса
            const order = await db.getOrderByNumber(orderId);
            if (order && order.user_id) {
                const statusLabels = {
                    'CONFIRMED': 'Подтверждён',
                    'ASSEMBLING': 'Собирается',
                    'SHIPPING': 'Передан в доставку',
                    'DELIVERED': 'Доставлен',
                    'CANCELLED': 'Отменён'
                };
                const label = statusLabels[status];
                if (label && bot) {
                    bot.sendMessage(order.user_id,
                        `<b>Заказ ${order.order_number || ''}</b>\n\nСтатус: <b>${label}</b>`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }
            }

            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Удалить все заказы
    app.delete('/api/orders', async (req, res) => {
        try {
            await db.deleteAllOrders();
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Назначить курьера на заказ
    app.post('/api/orders/:id/assign', async (req, res) => {
        try {
            const orderId = parseInt(req.params.id);
            const { courier_id } = req.body;
            if (!courier_id) return res.status(400).json({ error: 'courier_id required' });

            const order = await db.getOrderByNumber(orderId);
            if (!order) return res.status(404).json({ error: 'Order not found' });

            const courier = (await db.getCouriers()).find(c => c.id === courier_id);
            if (!courier) return res.status(404).json({ error: 'Courier not found' });

            // Создаём маршрут из заказа
            const route = await db.createRoute({
                route_number: 'RL-' + String(Date.now()).slice(-4),
                route_date: new Date().toISOString().split('T')[0],
                courier_id: courier_id,
                status: 'assigned',
                total_orders: 1,
                stops: [{
                    order_id: String(order.id),
                    order_number: order.order_number,
                    address: order.address || '',
                    city: order.city || '',
                    street: order.street || '',
                    house: order.house || '',
                    phone: order.phone || '',
                    client_name: order.user_name || '',
                    client_chat_id: order.user_id || null,
                    amount_to_pay: order.payment === 'cash' ? order.total : 0,
                    payment_status: order.payment === 'cash' ? 'pending' : 'paid',
                    status: 'pending',
                    comment: order.comment || ''
                }]
            });

            // Обновляем статус заказа
            await db.updateOrderStatus(orderId, 'SHIPPING');

            // Уведомляем курьера
            if (bot && courier.telegram_id) {
                bot.sendMessage(courier.telegram_id,
                    `<b>Новый маршрут!</b>\n\nМаршрут: ${route.route_number}\nЗаказ: ${order.order_number}\nАдрес: ${order.address}\n\nОтправьте /route для просмотра.`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }

            // Уведомляем клиента
            if (bot && order.user_id) {
                bot.sendMessage(order.user_id,
                    `<b>Заказ ${order.order_number}</b>\n\nСтатус: <b>Передан в доставку</b>\nКурьер уже выезжает к вам!`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }

            res.json({ success: true, route });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ====== Admin: управление товарами ======
    app.get('/api/products', async (req, res) => {
        try {
            const catalog = await db.getProducts();
            res.json(catalog);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/products', async (req, res) => {
        try {
            const product = await db.createProduct(req.body);
            res.json(product);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
}

module.exports = { registerCourierRoutes };

console.log('APCourier_Bot module loaded');
