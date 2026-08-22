const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');
const Geocoder = require('./services/geocoder');
const MapLinks = require('./services/map-links');
const RouteOptimizer = require('./services/route-optimizer');
const Notifier = require('./services/notifier');
const Dispatcher = require('./services/dispatcher');

// Конфигурация
const COURIER_BOT_TOKEN = process.env.COURIER_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const YANDEX_GEO_KEY = process.env.YANDEX_GEO_KEY || '';

const DATA_DIR = path.join(__dirname, '..', 'data');
const geocoder = new Geocoder(YANDEX_GEO_KEY);
const notifier = new Notifier(process.env.BOT_TOKEN || '', COURIER_BOT_TOKEN, ADMIN_CHAT_ID);

const bot = new TelegramBot(COURIER_BOT_TOKEN, { polling: true });

// ====== Утилиты ======

function readJSON(filename) {
    try {
        const filePath = path.join(DATA_DIR, filename);
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) { return []; }
}

function writeJSON(filename, data) {
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf-8');
}

function generateId(items) {
    if (items.length === 0) return 1;
    return Math.max(...items.map(i => i.id || 0)) + 1;
}

function generateRouteNumber() {
    const routes = readJSON('delivery-routes.json');
    const maxNum = routes.reduce((max, r) => {
        const num = parseInt((r.route_number || '').replace('RL-', ''));
        return num > max ? num : max;
    }, 0);
    return 'RL-' + String(maxNum + 1).padStart(4, '0');
}

function getCourier(user) {
    const couriers = readJSON('couriers.json');
    return couriers.find(c => c.telegram_id === user.id);
}

function getTodayRoutes(courierId) {
    const routes = readJSON('delivery-routes.json');
    const today = new Date().toISOString().split('T')[0];
    return routes.filter(r => r.courier_id === courierId && r.route_date === today);
}

function getActiveRoute(courierId) {
    const todayRoutes = getTodayRoutes(courierId);
    return todayRoutes.find(r => ['assigned', 'in_progress'].includes(r.status));
}

// ====== /start — Регистрация ======

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const courier = getCourier(user);

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

    bot.once('message', (regMsg) => {
        if (regMsg.chat.id !== chatId) return;
        if (regMsg.text && regMsg.text.startsWith('/')) return;

        const lines = (regMsg.text || '').split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) {
            bot.sendMessage(chatId, 'Нужно указать минимум имя и телефон. Попробуйте /start заново.');
            return;
        }

        const couriers = readJSON('couriers.json');
        const newCourier = {
            id: generateId(couriers),
            name: lines[0],
            phone: lines[1] || '',
            telegram_id: user.id,
            telegram_user: user.username || '',
            vehicle_type: lines[2] || 'легковая',
            zones: ['spb'],
            is_active: true,
            max_orders: 10,
            rating: 0,
            rating_count: 0,
            created_at: new Date().toISOString()
        };

        couriers.push(newCourier);
        writeJSON('couriers.json', couriers);

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

function showMainScreen(chatId, courier) {
    const todayRoutes = getTodayRoutes(courier.id);
    const activeRoute = getActiveRoute(courier.id);
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

bot.onText(/\/today/, (msg) => {
    const chatId = msg.chat.id;
    const courier = getCourier(msg.from);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const todayRoutes = getTodayRoutes(courier.id);
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

bot.onText(/\/route/, (msg) => {
    const chatId = msg.chat.id;
    const courier = getCourier(msg.from);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const activeRoute = getActiveRoute(courier.id);
    if (!activeRoute) {
        bot.sendMessage(chatId, 'На сегодня маршрутов нет.');
        return;
    }

    sendRouteDetails(chatId, activeRoute);
});

function sendRouteDetails(chatId, route) {
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
            // Навигация
            const yandexUrl = stop.lat && stop.lon
                ? MapLinks.yandex(stop.address, stop.lat, stop.lon)
                : MapLinks.yandex(stop.address);
            const gis2Url = stop.lat && stop.lon
                ? MapLinks.gis2(stop.lat, stop.lon)
                : 'https://2gis.ru';
            buttons.push([
                { text: `[${idx + 1}] Навигация`, url: yandexUrl },
                { text: `[${idx + 1}] 2GIS`, url: gis2Url }
            ]);
            // Доставлено / Не доставлено
            buttons.push([
                { text: `[${idx + 1}] Доставлено`, callback_data: `delivered_${route.id}_${stop.id}` },
                { text: `[${idx + 1}] Не доставлено`, callback_data: `failed_${route.id}_${stop.id}` }
            ]);
            // Позвонить клиенту
            if (stop.phone) {
                buttons.push([
                    { text: `[${idx + 1}] Позвонить клиенту`, url: `tel:${stop.phone}` }
                ]);
            }
        }
    });

    // Кнопка "Построить маршрут"
    if (stops.filter(s => s.status === 'pending').length >= 2) {
        buttons.push([{ text: 'Построить маршрут', callback_data: `optimizeroute_${route.id}` }]);
    }

    bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
    });
}

// ====== /done — Быстрая отметка доставки ======

bot.onText(/\/done/, (msg) => {
    const chatId = msg.chat.id;
    const courier = getCourier(msg.from);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const activeRoute = getActiveRoute(courier.id);
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

bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const courier = getCourier(msg.from);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const todayRoutes = getTodayRoutes(courier.id);
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

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    // Показать маршрут
    if (data.startsWith('showroute_')) {
        const routeId = parseInt(data.split('_')[1]);
        const routes = readJSON('delivery-routes.json');
        const route = routes.find(r => r.id === routeId);
        if (route) sendRouteDetails(chatId, route);
        bot.answerCallbackQuery(query.id);
        return;
    }

    // Обновить главный экран
    if (data === 'refresh_main') {
        const courier = getCourier(query.from);
        if (courier) showMainScreen(chatId, courier);
        bot.answerCallbackQuery(query.id);
        return;
    }

    // Поехал! — старт маршрута + уведомление клиентам
    if (data.startsWith('startroute_')) {
        const routeId = parseInt(data.split('_')[1]);
        handleStartRoute(chatId, routeId, query.from);
        bot.answerCallbackQuery(query.id, { text: 'Маршрут начат!' });
        return;
    }

    // Оптимизировать маршрут
    if (data.startsWith('optimizeroute_')) {
        const routeId = parseInt(data.split('_')[1]);
        handleOptimizeRoute(chatId, routeId);
        bot.answerCallbackQuery(query.id);
        return;
    }

    // Доставлено
    if (data.startsWith('delivered_')) {
        const [, routeId, stopId] = data.split('_');
        handleDeliveryResult(parseInt(routeId), parseInt(stopId), 'delivered', chatId, query.id);
        return;
    }

    // Быстрая доставка (из /done)
    if (data.startsWith('quickdelivered_')) {
        const [, routeId, stopId] = data.split('_');
        handleDeliveryResult(parseInt(routeId), parseInt(stopId), 'delivered', chatId, query.id);
        return;
    }

    // Не доставлено — показать причины
    if (data.startsWith('failed_')) {
        const [, routeId, stopId] = data.split('_');
        showFailureReasons(chatId, parseInt(routeId), parseInt(stopId));
        bot.answerCallbackQuery(query.id);
        return;
    }

    // Выбрана причина не доставки
    if (data.startsWith('failreason_')) {
        const parts = data.split('_');
        const routeId = parseInt(parts[1]);
        const stopId = parseInt(parts[2]);
        const reason = parts.slice(3).join('_');
        handleDeliveryResult(routeId, stopId, 'failed', chatId, query.id, reason);
        return;
    }

    // Оценка доставки клиентом
    if (data.startsWith('rate_')) {
        const parts = data.split('_');
        const courierId = parseInt(parts[1]);
        const rating = parseInt(parts[3]);

        const couriers = readJSON('couriers.json');
        const courier = couriers.find(c => c.id === courierId);
        if (courier) {
            const totalRating = (courier.rating || 0) * (courier.rating_count || 0) + rating;
            courier.rating_count = (courier.rating_count || 0) + 1;
            courier.rating = Math.round((totalRating / courier.rating_count) * 100) / 100;
            writeJSON('couriers.json', couriers);
            bot.answerCallbackQuery(query.id, { text: `Спасибо за оценку ${rating}!` });
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: chatId,
                message_id: query.message.message_id
            });
            bot.sendMessage(chatId, `Спасибо за оценку ${rating}/5!`);
        }
        return;
    }
});

// ====== Причины не доставки ======

// ====== Старт маршрута + уведомления клиентам ======

function handleStartRoute(chatId, routeId, user) {
    const routes = readJSON('delivery-routes.json');
    const route = routes.find(r => r.id === routeId);
    if (!route) return;

    route.status = 'in_progress';
    route.started_at = new Date().toISOString();
    writeJSON('delivery-routes.json', routes);

    bot.sendMessage(chatId, 'Маршрут начат! Удачи в доставке!');

    // Уведомляем всех клиентов в маршруте
    const stops = route.stops || [];
    stops.forEach(stop => {
        if (stop.status === 'pending' && stop.client_chat_id) {
            const timeText = stop.time_window ? `, ожидайте ${stop.time_window}` : '';
            bot.sendMessage(stop.client_chat_id,
                `<b>Курьер в пути!</b>\n\n` +
                `Заказ: ${stop.order_number || ''}\n` +
                `Адрес доставки: ${stop.address}\n` +
                `Курьер уже выехал к вам${timeText}.\n\n` +
                `Ожидайте доставку.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
    });

    // Уведомляем админа
    bot.sendMessage(ADMIN_CHAT_ID,
        `[МАРШРУТ] ${route.route_number} начат курьером ${user.first_name || ''}`
    ).catch(() => {});
}

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

    // Если "Другое" — запрашиваем текст
    if (reason === 'Другое') {
        bot.answerCallbackQuery(callbackQueryId);
        bot.sendMessage(chatId, 'Введите причину:');
        bot.once('message', (msg) => {
            if (msg.chat.id !== chatId) return;
            const customReason = msg.text || 'Не указана';
            handleDeliveryResult(routeId, stopId, 'failed', chatId, null, customReason);
        });
        return;
    }

    stop.status = status;
    stop.delivered_at = new Date().toISOString();
    if (reason) stop.fail_reason = reason;

    // Обновляем счётчики
    route.completed = (route.stops || []).filter(s => s.status === 'delivered').length;
    route.failed = (route.stops || []).filter(s => s.status === 'failed').length;

    // Проверяем завершение маршрута
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
    if (callbackQueryId) {
        bot.answerCallbackQuery(callbackQueryId, { text: `${statusText}: ${stop.address}` });
    }

    bot.sendMessage(chatId,
        `${statusText}: ${stop.order_number || ''}\nАдрес: ${stop.address}${reason ? '\nПричина: ' + reason : ''}`
    );

    // Уведомляем админа
    bot.sendMessage(ADMIN_CHAT_ID,
        `[ДОСТАВКА] ${route.route_number} | ${statusText}\nАдрес: ${stop.address}${stop.order_number ? '\nЗаказ: ' + stop.order_number : ''}${reason ? '\nПричина: ' + reason : ''}`
    ).catch(() => {});

    // Уведомляем клиента
    if (stop.client_chat_id) {
        if (status === 'delivered') {
            // Уведомление с кнопкой оценки
            const courierId = route.courier_id;
            bot.sendMessage(stop.client_chat_id,
                `<b>Заказ ${stop.order_number || ''} доставлен!</b>\n\n` +
                `Спасибо за покупку в АВТОПРОМОЙЛ!\n\n` +
                `Пожалуйста, оцените доставку:`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '1', callback_data: `rate_${courierId}_${stop.id}_1` },
                                { text: '2', callback_data: `rate_${courierId}_${stop.id}_2` },
                                { text: '3', callback_data: `rate_${courierId}_${stop.id}_3` },
                                { text: '4', callback_data: `rate_${courierId}_${stop.id}_4` },
                                { text: '5', callback_data: `rate_${courierId}_${stop.id}_5` }
                            ]
                        ]
                    }
                }
            ).catch(() => {});
        } else {
            notifier.notifyClientDelivery(stop.client_chat_id, stop.order_number || route.route_number, status, reason).catch(() => {});
        }
    }
}

// ====== Оптимизация маршрута из бота ======

function handleOptimizeRoute(chatId, routeId) {
    const routes = readJSON('delivery-routes.json');
    const route = routes.find(r => r.id === routeId);
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

    // Обновляем порядок остановок в маршруте
    let pendingIdx = 0;
    stops.forEach(stop => {
        if (stop.status === 'pending') {
            if (stop.lat && stop.lon) {
                const opt = optimized[pendingIdx];
                if (opt) {
                    stop.stop_number = stops.indexOf(stop) + 1;
                }
                pendingIdx++;
            }
        }
    });

    route.total_distance = distance;
    writeJSON('delivery-routes.json', routes);

    let text = `<b>Маршрут оптимизирован!</b>\n\n`;
    text += `Оптимальный порядок:\n`;
    optimized.forEach((stop, idx) => {
        text += `${idx + 1}. ${stop.order_number || ''} — ${stop.address}\n`;
    });
    text += `\nРасстояние: ~${distance} км\n`;

    // Ссылки на навигаторы для всего маршрута
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

// ====== Обработка фото (для подтверждения доставки) ======

bot.on('photo', (msg) => {
    const chatId = msg.chat.id;
    const courier = getCourier(msg.from);

    if (!courier) return;

    const activeRoute = getActiveRoute(courier.id);
    if (!activeRoute) return;

    // Сохраняем фото для последней доставки
    const pendingStops = (activeRoute.stops || []).filter(s => s.status === 'pending');
    if (pendingStops.length === 0) return;

    const photo = msg.photo[msg.photo.length - 1]; // Максимальное разрешение
    const fileId = photo.file_id;

    bot.sendMessage(chatId,
        'Фото получено. К какому заказу привязать?\n\n' +
        'Отправьте номер заказа (например: AP-000001) или нажмите /route для выбора.',
        { parse_mode: 'HTML' }
    );

    bot.once('message', (orderMsg) => {
        if (orderMsg.chat.id !== chatId) return;
        const orderNum = (orderMsg.text || '').trim();

        const stop = pendingStops.find(s => s.order_number === orderNum);
        if (stop) {
            stop.photo_file_id = fileId;
            const routes = readJSON('delivery-routes.json');
            const route = routes.find(r => r.id === activeRoute.id);
            if (route) {
                const routeStop = (route.stops || []).find(s => s.id === stop.id);
                if (routeStop) routeStop.photo_file_id = fileId;
                writeJSON('delivery-routes.json', routes);
            }
            bot.sendMessage(chatId, `Фото привязано к заказу ${orderNum}`);
        } else {
            bot.sendMessage(chatId, 'Заказ не найден. Фото сохранено, привяжите позже через /route.');
        }
    });
});

// ====== API для диспетчера (экспорт) ======

function registerCourierRoutes(app) {
    app.use(express.json());

    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', bots: ['AutoPromoilBot', 'APCourier_Bot'], timestamp: new Date().toISOString() });
    });

    app.get('/api/couriers', (req, res) => res.json(readJSON('couriers.json')));

    app.post('/api/routes', async (req, res) => {
        const { courier_id, route_date, stops } = req.body;
        console.log('POST /api/routes — stops:', stops ? stops.length : 0);
        console.log('YANDEX_GEO_KEY:', YANDEX_GEO_KEY ? YANDEX_GEO_KEY.substring(0, 8) + '...' : 'НЕ ЗАДАН');
        const processedStops = [];
        if (stops && stops.length > 0) {
            for (let i = 0; i < stops.length; i++) {
                const stop = stops[i];
                const processed = { ...stop, id: i + 1, stop_number: i + 1, status: 'pending' };
                console.log(`Stop ${i}: address="${processed.address}", lat=${processed.lat}, key=${!!YANDEX_GEO_KEY}`);
                if (!processed.lat && processed.address && YANDEX_GEO_KEY) {
                    try {
                        const geo = await geocoder.geocode(processed.address);
                        console.log(`Гео-результат:`, JSON.stringify(geo));
                        if (geo) {
                            processed.lat = geo.lat;
                            processed.lon = geo.lon;
                            console.log(`Геокодировано: ${processed.address} -> ${geo.lat}, ${geo.lon}`);
                        }
                    } catch (e) {
                        console.log(`Ошибка геокодирования "${processed.address}":`, e.message);
                    }
                } else {
                    console.log(`Пропуск геокодирования: lat=${processed.lat}, address=${!!processed.address}, key=${!!YANDEX_GEO_KEY}`);
                }
                if (processed.lat && processed.lon) {
                    processed.yandex_url = MapLinks.yandex(processed.address, processed.lat, processed.lon);
                    processed.google_url = MapLinks.google(processed.lat, processed.lon);
                    processed.gis2_url = MapLinks.gis2(processed.lat, processed.lon);
                }
                processedStops.push(processed);
            }
        }
        const routes = readJSON('delivery-routes.json');
        const maxId = routes.reduce((max, r) => Math.max(max, r.id || 0), 0);
        const maxNum = routes.reduce((max, r) => { const n = parseInt((r.route_number||'').replace('RL-','')); return n > max ? n : max; }, 0);
        const newRoute = {
            id: maxId + 1, route_number: 'RL-' + String(maxNum + 1).padStart(4, '0'),
            route_date: route_date || new Date().toISOString().split('T')[0],
            courier_id, status: 'draft', total_orders: processedStops.length,
            completed: 0, failed: 0, cash_to_collect: 0, cash_collected: 0,
            stops: processedStops, started_at: null, completed_at: null, created_at: new Date().toISOString()
        };
        routes.push(newRoute);
        writeJSON('delivery-routes.json', routes);
        res.json(newRoute);
    });

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
        bot.sendMessage(courier.telegram_id,
            `<b>Новый маршрут!</b>\n\nМаршрут: ${route.route_number}\nДата: ${route.route_date}\nОстановок: ${(route.stops||[]).length}\n\nОтправьте /route для просмотра.`,
            { parse_mode: 'HTML' }
        ).then(() => res.json({ success: true })).catch(err => res.json({ success: false, error: err.message }));
    });

    app.get('/api/routes', (req, res) => res.json(readJSON('delivery-routes.json')));
    app.get('/api/orders', (req, res) => res.json(readJSON('orders.json')));
    app.get('/api/zones', (req, res) => res.json(readJSON('delivery-zones.json')));

    app.get('/api/geocode', async (req, res) => {
        const address = req.query.address;
        if (!address) return res.status(400).json({ error: 'address required' });
        try {
            const result = await geocoder.geocode(address);
            res.json(result ? { found: true, ...result } : { found: false });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Тест геокодера
    app.get('/api/test-geocode', async (req, res) => {
        const address = req.query.address || 'Санкт-Петербург, Невский проспект, 10';
        try {
            console.log('Тест геокодера:', address);
            console.log('YANDEX_GEO_KEY:', YANDEX_GEO_KEY ? 'задан' : 'НЕ ЗАДАН');
            const result = await geocoder.geocode(address);
            console.log('Результат:', result);
            res.json({ success: true, result, keySet: !!YANDEX_GEO_KEY });
        } catch (e) {
            console.log('Ошибка:', e.message);
            res.json({ success: false, error: e.message, keySet: !!YANDEX_GEO_KEY });
        }
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

    app.post('/api/routes/:id/optimize', (req, res) => {
        const routeId = parseInt(req.params.id);
        const { start_lat, start_lon } = req.body;
        const routes = readJSON('delivery-routes.json');
        const route = routes.find(r => r.id === routeId);
        if (!route) return res.status(404).json({ error: 'Route not found' });
        const stops = route.stops || [];
        if (stops.length < 2) return res.json({ message: 'Nothing to optimize', stops });
        const optimized = RouteOptimizer.optimizeRoute(stops, start_lat || 59.9343, start_lon || 30.3351);
        route.stops = optimized;
        route.total_distance = RouteOptimizer.calcDistance(optimized, start_lat || 59.9343, start_lon || 30.3351);
        writeJSON('delivery-routes.json', routes);
        res.json({ route_number: route.route_number, stops: optimized, total_distance_km: route.total_distance });
    });

    app.post('/api/dispatch/create-route', (req, res) => {
        const { order_ids, courier_id, route_date } = req.body;
        if (!order_ids || !order_ids.length) return res.status(400).json({ error: 'order_ids required' });
        const route = Dispatcher.createRouteFromOrders(order_ids, courier_id, route_date);
        if (!route) return res.status(404).json({ error: 'No orders found' });
        res.json(route);
    });

    app.get('/api/dispatch/available-couriers', (req, res) => {
        res.json(Dispatcher.getAvailableCouriers(req.query.date || new Date().toISOString().split('T')[0]));
    });

    app.get('/api/dispatch/unassigned-orders', (req, res) => res.json(Dispatcher.getUnassignedOrders()));

    app.get('/api/dispatch/stats', (req, res) => {
        res.json(Dispatcher.getDayStats(req.query.date || new Date().toISOString().split('T')[0]));
    });

    app.get('/api/dispatch/delivery-cost', (req, res) => {
        const { zone, total } = req.query;
        res.json({ zone, order_total: parseFloat(total), delivery_cost: Dispatcher.calcDeliveryCost(zone, parseFloat(total)) });
    });

    // Аналитика доставки
    app.get('/api/analytics', (req, res) => {
        const { date_from, date_to } = req.query;
        const routes = readJSON('delivery-routes.json');
        const couriers = readJSON('couriers.json');

        const from = date_from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const to = date_to || new Date().toISOString().split('T')[0];

        const filtered = routes.filter(r => r.route_date >= from && r.route_date <= to);

        const totalRoutes = filtered.length;
        const completedRoutes = filtered.filter(r => r.status === 'completed').length;
        const totalStops = filtered.reduce((sum, r) => sum + (r.total_orders || 0), 0);
        const delivered = filtered.reduce((sum, r) => sum + (r.completed || 0), 0);
        const failed = filtered.reduce((sum, r) => sum + (r.failed || 0), 0);
        const totalDistance = filtered.reduce((sum, r) => sum + (r.total_distance || 0), 0);
        const cashToCollect = filtered.reduce((sum, r) => sum + (r.cash_to_collect || 0), 0);
        const cashCollected = filtered.reduce((sum, r) => sum + (r.cash_collected || 0), 0);

        // Среднее время доставки (от старта до завершения)
        const completedRoutesData = filtered.filter(r => r.status === 'completed' && r.started_at && r.completed_at);
        const avgTime = completedRoutesData.length > 0
            ? completedRoutesData.reduce((sum, r) => {
                const start = new Date(r.started_at).getTime();
                const end = new Date(r.completed_at).getTime();
                return sum + (end - start);
            }, 0) / completedRoutesData.length / 60000 // в минутах
            : 0;

        // Загрузка курьеров
        const courierStats = couriers.map(c => {
            const courierRoutes = filtered.filter(r => r.courier_id === c.id);
            const courierDelivered = courierRoutes.reduce((sum, r) => sum + (r.completed || 0), 0);
            const courierFailed = courierRoutes.reduce((sum, r) => sum + (r.failed || 0), 0);
            return {
                id: c.id,
                name: c.name,
                rating: c.rating || 0,
                rating_count: c.rating_count || 0,
                routes: courierRoutes.length,
                delivered: courierDelivered,
                failed: courierFailed,
                success_rate: courierDelivered + courierFailed > 0
                    ? Math.round(courierDelivered / (courierDelivered + courierFailed) * 100)
                    : 0
            };
        });

        res.json({
            period: { from, to },
            summary: {
                total_routes: totalRoutes,
                completed_routes: completedRoutes,
                total_stops: totalStops,
                delivered,
                failed,
                pending: totalStops - delivered - failed,
                success_rate: totalStops > 0 ? Math.round(delivered / totalStops * 100) : 0,
                total_distance_km: Math.round(totalDistance * 10) / 10,
                avg_delivery_time_min: Math.round(avgTime),
                cash_to_collect: cashToCollect,
                cash_collected: cashCollected
            },
            couriers: courierStats
        });
    });
}

module.exports = { registerCourierRoutes };

console.log('APCourier_Bot module loaded');
