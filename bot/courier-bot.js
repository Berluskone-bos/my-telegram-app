const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const Geocoder = require('./services/geocoder');
const MapLinks = require('./services/map-links');
const RouteOptimizer = require('./services/route-optimizer');
const Notifier = require('./services/notifier');
const db = require('./db-adapter');
const queue = require('./notify-queue');
const { checkStopActive, CANCELLED_BUTTON, CANCELLED_BUTTON_OLD } = require('./cancel-flow');
const { trackerEvent, hasTracker } = require('./tracker');
const { buildRouteCard, buildReasonPicker, REASONS } = require('./courier-card');
const widgets = require('./widgets');
const { createRouteService } = require('./route-service');
const { registerOrderStatsRoutes } = require('./order-stats');
const { validateProductPayload, validateExpectedStock } = require('./product-validation');
const { filterProductsForRole, validateStockUpdate } = require('./admin-product-visibility');
const { requirePermission, requireOrderStatusPermission } = require('./admin-permissions');
const { filterOrderListItem, filterOrderDetails } = require('./admin-order-visibility');
const { filterCouriersForRole, filterRoutesForRole, filterRouteForRole } = require('./admin-dispatch-visibility');

// Конфигурация
const COURIER_BOT_TOKEN = process.env.COURIER_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
// Кто может нажимать админские кнопки: ТОЛЬКО перечисленные Telegram user ID (ADMIN_USER_IDS=123,456).
// ID чата для уведомлений (ADMIN_CHAT_ID) правом доступа не является. Если список не задан и
// ADMIN_CHAT_ID - личный чат (положительное число = ID пользователя), доступ только у него.
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || (Number(ADMIN_CHAT_ID) > 0 ? String(ADMIN_CHAT_ID) : ''))
    .split(',').map(s => s.trim()).filter(Boolean);
function isTrustedAdmin(userId) { return userId != null && ADMIN_USER_IDS.includes(String(userId)); }
const { escapeHtml } = require('./services/notifier');
const YANDEX_GEO_KEY = process.env.YANDEX_GEO_KEY || '';

function errorCode(err) {
    const code = err && (err.code || err.name);
    return typeof code === 'string' ? code.slice(0, 40) : 'unknown';
}

const geocoder = new Geocoder(YANDEX_GEO_KEY);
// Маршрут из нескольких заказов: порядок, время приезда, сообщения клиентам (см. route-service.js)
const routeSvc = createRouteService({ db, geocoder: YANDEX_GEO_KEY ? geocoder : null, queue });
// Очередь уведомлений: отправка с повторами (см. outbox.js). Запуск идемпотентный: можно вызывать из обоих модулей.
db.init().then(() => queue.instance().start()).catch(e => console.error('[OUTBOX] запуск не удался:', errorCode(e)));
const notifier = new Notifier(process.env.BOT_TOKEN || '', COURIER_BOT_TOKEN, ADMIN_CHAT_ID, process.env.ADMIN_BOT_TOKEN || '');

// ===== Безопасность =====
function requireEnv(name) {
    if (!process.env[name]) {
        console.error(`[КРИТИЧЕСКАЯ ОШИБКА] Переменная окружения ${name} не установлена`);
        process.exit(1);
    }
    return process.env[name];
}
const WEBHOOK_SECRET = requireEnv('WEBHOOK_SECRET');

// Вход администратора: сессия в HttpOnly-cookie (см. admin-auth.js). Ключ из заголовка больше не принимается.
function verifyAdmin(req, res, next) { return require('./admin-auth').instance().verifyAdmin(req, res, next); }
// Простое ограничение запросов (в памяти процесса): 30 запросов/мин с одного IP
const _pubBuckets = new Map();
function publicLimiter(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown', now = Date.now();
    let b = _pubBuckets.get(ip);
    if (!b || now > b.resetAt) {
        if (!b && _pubBuckets.size >= 10_000) {
            const oldestIp = _pubBuckets.keys().next().value;
            if (oldestIp !== undefined) _pubBuckets.delete(oldestIp);
        }
        b = { count: 0, resetAt: now + 60_000 };
        _pubBuckets.set(ip, b);
    }
    if (++b.count > 30) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((b.resetAt - now) / 1000))));
        return res.status(429).json({ error: 'Too many requests' });
    }
    next();
}
setInterval(() => { const n = Date.now(); for (const [k, v] of _pubBuckets) if (n > v.resetAt) _pubBuckets.delete(k); }, 60_000).unref();
function verifyWebhookSecret(req, res, next) {
    // Telegram сам шлёт этот заголовок, если вебхук зарегистрирован с secret_token
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    const a = Buffer.from(String(secret || '')), b = Buffer.from(WEBHOOK_SECRET);
    if (!secret || a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
        console.log(`[SECURITY] Неверный или отсутствующий webhook secret: ${secret ? '***' : 'missing'}`);
        return res.status(403).json({ error: 'Forbidden: invalid webhook secret' });
    }
    next();
}

let bot;
if (COURIER_BOT_TOKEN) {
    bot = new TelegramBot(COURIER_BOT_TOKEN, { polling: false });
}

// Админ-бот для обработки кнопок
let adminBot;
if (process.env.ADMIN_BOT_TOKEN) {
    // polling:false — опрос запускает poll-guard под замком в базе (только один экземпляр на всю базу, см. bot/poll-guard.js).
    // Тайм-аут запроса: «тихо» умершее соединение закончится ошибкой, а не зависанием. family:4 — Railway не выпускает IPv6,
    // без этого Node перебирает адреса и при сбое выдаёт непонятный AggregateError.
    adminBot = new TelegramBot(process.env.ADMIN_BOT_TOKEN, { polling: false, request: { timeout: 30_000, family: 4 } });
    adminBot.on('polling_error', () => { /* ошибки опроса пишет poll-guard (раз в минуту, с причиной и записью о восстановлении) */ });
    adminBot.on('callback_query', async (query) => {
        const data = query.data;
        // Только владелец админ-чата может подтверждать курьеров и отменять заказы
        if (!isTrustedAdmin(query.from?.id)) {
            adminBot.answerCallbackQuery(query.id, { text: 'Нет доступа' }).catch(() => {});
            return;
        }
        if (data && data.startsWith('activate_courier_')) {
            const cid = parseInt(data.split('_')[2]);
            try {
                await db.updateCourier(cid, { is_active: true });
                adminBot.answerCallbackQuery(query.id, { text: 'Курьер активирован' });
                adminBot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
            } catch (e) { adminBot.answerCallbackQuery(query.id, { text: 'Ошибка активации' }); }
            return;
        }
        if (data && data.startsWith('cancel_')) {
            const raw = data.slice('cancel_'.length);
            if (!/^[0-9]{1,14}$/.test(raw)) {
                adminBot.answerCallbackQuery(query.id, { text: 'Некорректный номер' });
                return;
            }
            try {
                // Новые кнопки несут внутренний номер (до 9 цифр). Старые сообщения — номер заказа без «AP-» (12–14 цифр).
                let orderId = Number(raw);
                if (raw.length > 9) {
                    const r = await require('./db').pool.query('SELECT id FROM orders WHERE order_number = $1', ['AP-' + raw]);
                    orderId = r.rows[0] ? r.rows[0].id : 0;
                }
                const done = orderId ? await db.updateOrderStatus(orderId, 'CANCELLED') : false;
                if (done === false) {
                    adminBot.answerCallbackQuery(query.id, { text: 'Заказ не найден' });
                    return;
                }
                if (done !== true) { // ALREADY, доставлен или завершён: повторно никого не уведомляем
                    adminBot.answerCallbackQuery(query.id, { text: done === 'ALREADY' ? 'Заказ уже отменён' : 'Заказ нельзя отменить в этом статусе' });
                    adminBot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                        chat_id: query.message.chat.id, message_id: query.message.message_id
                    }).catch(() => {});
                    return;
                }
                const order = await db.getOrderById(orderId);
                adminBot.answerCallbackQuery(query.id, { text: 'Заказ отменён' });
                adminBot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                    chat_id: query.message.chat.id, message_id: query.message.message_id
                }).catch(() => {});
                adminBot.sendMessage(query.message.chat.id, `Заказ ${order?.order_number || orderId} отменён. Клиенту и курьеру (если заказ был на маршруте) сообщения отправлены.`).catch(() => {});
                // Сообщения клиенту и курьеру уже поставлены в очередь внутри отмены (см. cancel-flow.js)
            } catch (e) {
                console.error('[ADMIN BOT] Cancel error:', errorCode(e));
                adminBot.answerCallbackQuery(query.id, { text: 'Ошибка отмены' });
            }
        }
    });
    // /summary — сводка дня карточкой; дальше она сама обновляется (summary.js)
    adminBot.onText(/^\/summary(?:@[\w_]+)?(?:\s|$)/, async (msg) => {
        if (!isTrustedAdmin(msg.from?.id)) return;
        try { await summarySvc().send(); }
        catch (e) { console.error('[СВОДКА]', errorCode(e)); adminBot.sendMessage(msg.chat.id, 'Не удалось собрать сводку.').catch(() => {}); }
    });
    console.log('[OK] Админ-бот запущен (polling)');
}
let _summary = null;
function summarySvc() {
    if (!_summary) {
        _summary = require('./summary').createSummaryService({ db, pool: require('./db').pool, queue, chatId: ADMIN_CHAT_ID });
        _summary.start();
    }
    return _summary;
}
if (adminBot && ADMIN_CHAT_ID) summarySvc();      // после перезапуска карточка продолжает обновляться

// Опрос Telegram админ-ботом (кнопки «Отменить», «Активировать курьера», команда /summary). ADMIN_POLLING=off — не опрашивать (тесты, второй сервис).
let adminPolling = null;
if (adminBot && process.env.ADMIN_POLLING !== 'off') {
    adminPolling = require('./poll-guard').startGuardedPolling(adminBot, { name: 'ADMIN BOT', pool: require('./db').pool });
}
const getAdminPollingStatus = () => adminPolling ? adminPolling.status() : { name: 'ADMIN BOT', enabled: false };
const stopAdminPolling = () => adminPolling ? adminPolling.stop() : Promise.resolve();

// ====== Утилиты ======

function notifyAdmin(text, buttons = null, dedupKey = null, db = null, throwOnError = false) {
    if (!ADMIN_CHAT_ID) return Promise.resolve();
    return queue.notify('admin', ADMIN_CHAT_ID, text, { buttons, dedupKey: dedupKey || undefined, db, throwOnError });
}

const trackerPool = () => require('./db').pool;

// Ждём от курьера текст причины недоставки («Другое»): chatId -> { routeId, stopId, messageId, at }
const pendingReasons = new Map();

// Показывает карточку маршрута: правит то же сообщение, а если Telegram не дал — отправляет новое.
// Карточка одна на маршрут: все заказы пронумерованы, текущий отмечен стрелкой (courier-card.js).
async function renderRouteCard(chatId, messageId, routeId, wantedStopId = null) {
    const route = await db.getRouteById(routeId);
    if (!route) return false;
    const card = buildRouteCard(route, wantedStopId);
    const opts = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: card.keyboard } };
    if (messageId) {
        try { await bot.editMessageText(card.text, { chat_id: chatId, message_id: messageId, ...opts }); return true; }
        catch (e) {
            if (/not modified/i.test(String(e && e.message))) return true;
            console.error('[ROUTE] Не удалось обновить карточку маршрута:', errorCode(e));
        }
    }
    try { await bot.sendMessage(chatId, card.text, opts); return true; }
    catch (e) { console.error('[ROUTE] Не удалось отправить карточку маршрута:', errorCode(e)); return false; }
}

// Сообщение админу о шаге доставки: забрал заказ / выехал / на месте / доставил (один раз на шаг)
async function notifyAdminStep(routeId, stopId, step, query) {
    try {
        const labels = {
            accept: 'курьер принял заказ (забрал со склада)',
            enroute: 'курьер выехал к клиенту',
            arrived: 'курьер приехал к клиенту',
            done: 'заказ доставлен'
        };
        const route = await db.getRouteById(routeId);
        const stop = route?.stops?.find(s => parseInt(s.id) === parseInt(stopId));
        if (!stop || stop.status === 'cancelled') return;
        const who = query && query.from ? [query.from.first_name, query.from.last_name].filter(Boolean).join(' ') : '';
        await notifyAdmin(
            `[ДОСТАВКА] ${escapeHtml(route.route_number)} | ${labels[step]}\n` +
            `Заказ: ${escapeHtml(stop.order_number || '')} (точка ${stop.stop_number} из ${(route.stops || []).length})\nАдрес: ${escapeHtml(stop.address || '')}` +
            (who ? `\nКурьер: ${escapeHtml(who)}` : ''),
            null, `admin-step-${step}:${stopId}`);
    } catch (e) { console.error('[DELIVER] admin notify error:', errorCode(e)); }
}

function generateRouteNumber() {
    return 'RL-' + String(Date.now()).slice(-4);
}

// Данные и действия выдаём только активному курьеру (деактивированный теряет доступ сразу)
async function getActiveCourier(user) {
    const c = await db.getCourierByTelegramId(user.id);
    return c && c.is_active ? c : null;
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

// ====== /car — Изменить авто и регномер ======
if (bot) {
bot.onText(/\/car/, async (msg) => {
    const chatId = msg.chat.id;
    const courier = await getActiveCourier(msg.from);
    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Сначала /start');
        return;
    }
    bot.sendMessage(chatId,
        `Текущий транспорт: <b>${escapeHtml(courier.vehicle_type || '—')}</b>\nРег.номер: <b>${escapeHtml(courier.license_plate || '—')}</b>\n\nОтправьте новый текст в формате:\n<b>Тип транспорта</b> (легковая/грузовая/пешком)\n<b>Рег. номер</b> (например: А 123 БВ 77)\n\nПример:\nлегковая\nА 777 ББ 97`,
        { parse_mode: 'HTML' }
    );
    bot.once('message', async (updMsg) => {
        if (updMsg.chat.id !== chatId || (updMsg.text || '').startsWith('/')) return;
        const lines = (updMsg.text || '').split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 1) {
            bot.sendMessage(chatId, 'Нужно указать хотя бы тип транспорта. Попробуйте /car заново.');
            return;
        }
        const updates = { vehicle_type: lines[0] || courier.vehicle_type };
        if (lines[1]) updates.license_plate = lines[1];
        const updated = await db.updateCourier(courier.id, updates);
        bot.sendMessage(chatId,
            `Обновлено!\nТранспорт: ${updated?.vehicle_type || updates.vehicle_type}\nРег.номер: ${updated?.license_plate || updates.license_plate || '—'}`,
            { parse_mode: 'HTML' }
        );
    });
});

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
            is_active: false,   // активирует администратор после проверки
            max_orders: 10,
            rating: 0,
            rating_count: 0
        });

        bot.sendMessage(chatId,
            `Регистрация завершена!\n\nИмя: ${newCourier.name}\nТелефон: ${newCourier.phone}\nТранспорт: ${newCourier.vehicle_type}\n\nАккаунт будет активирован администратором после проверки, затем вы получите маршрутные листы.`,
            { parse_mode: 'HTML' }
        );

        const regText = `[КУРЬЕР] Заявка: ${newCourier.name} (@${user.username || '-'})\nТел: ${newCourier.phone}\nТранспорт: ${newCourier.vehicle_type}\nАккаунт НЕ активен до подтверждения.`;
        const activationButtons = adminBot && ADMIN_CHAT_ID
            ? [[{ text: 'Активировать курьера', callback_data: `activate_courier_${newCourier.id}` }]]
            : null;
        await notifyAdmin(regText, activationButtons, `courier-registration:${newCourier.id}`);
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
    const remaining = stops.filter(s => s.status === 'pending' || s.status === 'in_progress').length;

    let text = `<b>АВТОПРОМОЙЛ — Курьер</b>\n\n`;
    text += `Добрый день, ${escapeHtml(courier.name)}!\n\n`;
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
    const courier = await getActiveCourier(msg.from);

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
        text += `<b>${escapeHtml(route.route_number)}</b> — ${stops.length} остановок (${delivered} доставлено)\n`;
        stops.forEach((stop, idx) => {
            const icon = stop.status === 'delivered' ? '[OK]' : stop.status === 'failed' ? '[X]' : `[${idx + 1}]`;
            text += `  ${icon} ${escapeHtml(stop.order_number || '')} ${escapeHtml(stop.address)}\n`;
        });
        text += '\n';
    });

    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// ====== /route — Маршрутный лист (детальный) ======

bot.onText(/\/route/, async (msg) => {
    const chatId = msg.chat.id;
    const courier = await getActiveCourier(msg.from);

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
    // Начатый маршрут показываем рабочей карточкой (те же номера и кнопки, что при старте маршрута).
    if (route.status === 'in_progress') { await renderRouteCard(chatId, null, route.id, null); return; }
    const stops = route.stops || [];
    const completed = stops.filter(s => s.status === 'delivered').length;
    const failed = stops.filter(s => s.status === 'failed').length;

    let text = `<b>Маршрут ${escapeHtml(route.route_number)}</b>\n`;
    text += `Дата: ${escapeHtml(route.route_date)}\n`;
    text += `Остановок: ${stops.length} | Доставлено: ${completed} | Не доставлено: ${failed}\n\n`;

    stops.forEach((stop, idx) => {
        const statusIcon = stop.status === 'delivered' ? '[ДОСТАВЛЕН]' :
                          stop.status === 'failed' ? '[НЕ ДОСТАВЛЕН]' :
                          stop.status === 'cancelled' ? '[ОТМЕНЁН]' : `[${stop.stop_number || idx + 1}]`;
        text += `<b>${statusIcon} ${escapeHtml(stop.order_number || '')}</b>\n`;
        text += `Адрес: ${escapeHtml(stop.address)}\n`;
        if (stop.items_count) text += `Товаров: ${escapeHtml(stop.items_count)}\n`;
        if (stop.amount_to_pay > 0) {
            text += `Сумма: ${escapeHtml(stop.amount_to_pay)} руб. [${stop.payment_status === 'paid' ? 'ОПЛАЧЕНО' : 'ОПЛАТА НА МЕСТЕ'}]\n`;
        }
        if (stop.phone) text += `Телефон: ${escapeHtml(stop.phone)}\n`;
        if (stop.time_window) text += `Окно: ${escapeHtml(stop.time_window)}\n`;
        if (stop.eta_at && stop.status === 'pending') text += `Ориентировочно: к ${require('./services/route-planner').formatEta(stop.eta_at).clock}\n`;
        if (stop.comment) text += `Комментарий: ${escapeHtml(stop.comment)}\n`;
        text += '\n';
    });

    // До старта маршрута кнопок «Доставлено/Не доставлено» нет (сервер всё равно ответит «Сначала начните маршрут»):
    // остаются только ссылки на навигацию. Телефон указан в тексте (кнопки tel: Telegram не принимает).
    const buttons = [];
    stops.forEach((stop) => {
        if (['pending', 'accepted'].includes(stop.status)) {
            const hasPoint = stop.lat && stop.lon;
            buttons.push([
                { text: `№${stop.stop_number} Навигатор`, url: hasPoint ? MapLinks.yandex(stop.address, parseFloat(stop.lat), parseFloat(stop.lon)) : MapLinks.yandex(stop.address) },
                { text: `№${stop.stop_number} 2GIS`, url: hasPoint ? MapLinks.gis2(parseFloat(stop.lat), parseFloat(stop.lon)) : 'https://2gis.ru' }
            ]);
        }
    });

    // Порядок точек строит система при назначении маршрута; кнопки «Построить маршрут» больше нет
    // (старый подбор считал по прямой линии и мог противоречить порядку, о котором уже знают клиенты).
    bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
    });
}

// ====== /done — Быстрая отметка доставки ======

bot.onText(/\/done/, async (msg) => {
    const chatId = msg.chat.id;
    const courier = await getActiveCourier(msg.from);

    if (!courier) {
        bot.sendMessage(chatId, 'Вы не зарегистрированы. Отправьте /start');
        return;
    }

    const activeRoute = await getActiveRoute(courier.id);
    if (!activeRoute) {
        bot.sendMessage(chatId, 'Нет активного маршрута.');
        return;
    }

    if (activeRoute.status !== 'in_progress') {
        bot.sendMessage(chatId, 'Маршрут ещё не начат. Примите заказы и нажмите «Начать маршрут» (команда /route покажет список).');
        return;
    }
    // Отметки делаются в карточке маршрута: заказ выбирается кнопкой «Выбрать №…», дальше «В пути» → «У клиента» → «Доставлен».
    await renderRouteCard(chatId, null, activeRoute.id, null);
});

// ====== /status — Статистика ======

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const courier = await getActiveCourier(msg.from);

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
        `Курьер: ${escapeHtml(courier.name)}\n` +
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

if (bot) {
bot.on('callback_query', async (query) => {
 try {
    const chatId = query.message.chat.id;
    const data = query.data;
    console.log('[CALLBACK] Получено действие курьера');

    // ── Авторизация: маршрут и остановка должны принадлежать этому курьеру ──
    const ROUTE_ACTIONS = ['showroute_', 'startroute_', 'deliver_', 'optimizeroute_', 'delivered_', 'quickdelivered_', 'failed_', 'failreason_', 'pickstop_'];
    if (ROUTE_ACTIONS.some(a => data.startsWith(a))) {
        const parts = data.split('_');
        const rId = parseInt(parts[1]);
        const sId = ['deliver_', 'delivered_', 'quickdelivered_', 'failed_', 'failreason_', 'pickstop_'].some(a => data.startsWith(a)) ? parseInt(parts[2]) : null;
        const me = await db.getCourierByTelegramId(query.from.id);
        const rt = Number.isInteger(rId) ? await db.getRouteById(rId) : null;
        const owns = me && me.is_active && rt && String(rt.courier_id) === String(me.id)
            && (sId === null || (rt.stops || []).some(s => s.id === sId));
        if (!owns) {
            console.warn('[SECURITY] Отклонено действие без прав на маршрут');
            bot.answerCallbackQuery(query.id, { text: 'Нет доступа к этому маршруту' }).catch(() => {});
            return;
        }
        const isAccept = data.startsWith('deliver_') && data.endsWith('_accept');
        // Сначала проверяем отмену: старые кнопки отменённого заказа должны сообщать об отмене,
        // а не маскировать её предупреждением о незапущенном маршруте.
        if (sId !== null) {
            const chk = await checkStopActive(require('./db').pool, sId);
            if (!chk.active) {
                bot.answerCallbackQuery(query.id, { text: chk.reason === 'cancelled' ? 'Заказ отменён. Везти его не нужно.' : 'Остановка не найдена', show_alert: true }).catch(() => {});
                if (chk.reason === 'cancelled' && query.message) {
                    bot.editMessageReplyMarkup({ inline_keyboard: CANCELLED_BUTTON }, { chat_id: chatId, message_id: query.message.message_id })
                        .catch(() => bot.editMessageReplyMarkup({ inline_keyboard: CANCELLED_BUTTON_OLD }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {}));
                }
                return;
            }
        }
        if (!isAccept && ['delivered_', 'quickdelivered_', 'failed_', 'failreason_'].some(a => data.startsWith(a)) && rt.status !== 'in_progress') {
            bot.answerCallbackQuery(query.id, { text: 'Сначала необходимо начать весь маршрут', show_alert: true }).catch(() => {});
            return;
        }
    }

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
        bot.answerCallbackQuery(query.id, { text: 'Проверяю готовность маршрута…' }).catch(() => {});
        await handleStartRoute(chatId, routeId, query.from);
        return;
    }

    // ====== Новый flow доставки: accept → enroute → arrived → done ======
    if (data.startsWith('deliver_')) {
        const parts = data.split('_');
        const routeId = parseInt(parts[1]);
        const stopId = parseInt(parts[2]);
        const action = parts[3];
        await handleDeliveryFlow(chatId, routeId, stopId, action, query);
        return;
    }

    if (data.startsWith('optimizeroute_')) {
        const routeId = parseInt(data.split('_')[1]);
        handleOptimizeRoute(chatId, routeId);
        bot.answerCallbackQuery(query.id);
        return;
    }

    // Кнопки «Доставлено» из старых сообщений: тот же путь, что и у «Доставлен» в карточке (одна транзакция, без дублей).
    if (data.startsWith('delivered_') || data.startsWith('quickdelivered_')) {
        const [, routeId, stopId] = data.split('_');
        await handleDeliveryFlow(chatId, parseInt(routeId), parseInt(stopId), 'done', query);
        return;
    }

    // Курьер сам выбирает, какой заказ везёт; порядок точек и состояние остальных не меняются.
    if (data.startsWith('pickstop_')) {
        const [, routeId, stopId] = data.split('_');
        pendingReasons.delete(chatId);
        await renderRouteCard(chatId, query.message?.message_id, parseInt(routeId), parseInt(stopId));
        bot.answerCallbackQuery(query.id).catch(() => {});
        return;
    }

    if (data.startsWith('failed_')) {
        const [, routeId, stopId] = data.split('_');
        await showFailureReasons(chatId, parseInt(routeId), parseInt(stopId), query.message?.message_id);
        bot.answerCallbackQuery(query.id).catch(() => {});
        return;
    }

    if (data.startsWith('failreason_')) {
        const parts = data.split('_');
        const routeId = parseInt(parts[1]);
        const stopId = parseInt(parts[2]);
        const code = parts.slice(3).join('_');
        // Короткие коды причин (лимит Telegram на callback_data — 64 байта); полный текст — из старых сообщений.
        const reason = code === 'other' ? 'Другое' : (REASONS[code] || code);
        // Callback приходит из самого сообщения с выбором причины; reply_to_message Telegram не гарантирует.
        const originMessageId = query.message?.message_id || null;
        await handleDeliveryResult(routeId, stopId, 'failed', chatId, query.id, reason, originMessageId);
        return;
    }

    if (data === 'noop_cancelled') {
        bot.answerCallbackQuery(query.id, { text: 'Заказ отменён. Везти его не нужно.', show_alert: true }).catch(() => {});
        return;
    }

    if (data === 'noop') {
        bot.answerCallbackQuery(query.id, { text: 'Заказ уже доставлен' });
        return;
    }

 } catch (e) {
    console.error('[ОШИБКА] Callback query:', e && (e.code || e.name) || 'unknown');
    try { bot.answerCallbackQuery(query.id, { text: 'Не удалось обработать действие' }); } catch (_) {}
 }
});
} // end if (bot) callback_query

// ====== Старт маршрута ======

async function handleStartRoute(chatId, routeId, user) {
    const route = await db.getRouteById(routeId);
    if (!route) return;
    const started = await db.startRouteIfAllAccepted(routeId);
    if (started.status === 'not_ready') {
        bot.sendMessage(chatId, `Сначала примите все заказы маршрута. Осталось принять: ${started.waiting}.`);
        return;
    }
    if (started.status === 'already') {
        bot.sendMessage(chatId, 'Этот маршрут уже начат.');
        return;
    }
    if (started.status !== 'started') {
        bot.sendMessage(chatId, 'Не удалось начать маршрут: нет активных заказов или маршрут недоступен.');
        return;
    }

    try {
        // Пересчитываем ETA без массовой рассылки клиентам: каждый клиент получит
        // «Курьер в пути» только когда курьер начнёт именно его заказ.
        await routeSvc.refreshEtas({ routeId, notifyNew: false });
        // Одна карточка маршрута: все заказы пронумерованы, курьер сам выбирает, какой везёт первым.
        const shown = await renderRouteCard(chatId, null, routeId, null);
        if (!shown) throw new Error('card not sent');
    } catch (e) {
        console.error('[ROUTE] Не удалось отправить единый маршрут:', errorCode(e));
        bot.sendMessage(chatId, 'Маршрут начат, но не удалось показать маршрутную карточку. Откройте /route для просмотра.');
    }
    await notifyAdmin(`[МАРШРУТ] ${escapeHtml(route.route_number)} начат курьером ${user.first_name || ''}`);
}

// ====== Flow доставки: accept → enroute → arrived → done ======

async function handleDeliveryFlow(chatId, routeId, stopId, action, query) {
    const msgId = query.message.message_id;
    const currentRoute = await db.getRouteById(routeId);
    if (!currentRoute) return;
    if (action !== 'accept' && currentRoute.status !== 'in_progress') {
        bot.answerCallbackQuery(query.id, { text: 'Сначала курьер должен начать весь маршрут', show_alert: true }).catch(() => {});
        return;
    }
    stopId = parseInt(stopId); // Гарантируем что stopId — число
    console.log(`[DELIVER] action=${action}, routeId=${routeId}, stopId=${stopId}`);

    // Курьер сам выбирает, какой заказ везёт: порядок точек не навязываем. Проверяем только, что заказ ещё в работе
    // и что курьер не «у клиента» по другому заказу (его сначала нужно закрыть: «Доставлен» или «Не доставлено»).
    if (['enroute', 'arrived', 'done'].includes(action)) {
        const stops = currentRoute.stops || [];
        const stop = stops.find(s => Number(s.id) === stopId);
        if (!stop || ['delivered', 'failed', 'cancelled'].includes(stop.status)) {
            const text = !stop ? 'Остановка не найдена.'
                : stop.status === 'delivered' ? `Заказ №${stop.stop_number} уже доставлен.`
                : stop.status === 'failed' ? `Заказ №${stop.stop_number} уже отмечен как недоставленный.`
                : 'Заказ отменён. Везти его не нужно.';
            bot.answerCallbackQuery(query.id, { text, show_alert: true }).catch(() => {});
            await renderRouteCard(chatId, msgId, routeId, null);
            return;
        }
        if (action !== 'done') {
            // Читаем актуальную остановку напрямую из БД, а не из снимка currentRoute.
            const atClient = await db.getRouteStopAtClient(routeId, stopId);
            if (atClient) {
                bot.answerCallbackQuery(query.id, {
                    text: `Сначала закончите заказ №${atClient.stop_number} (${atClient.order_number || ''}): вы у клиента. Нажмите «Доставлен» или «Не доставлено».`,
                    show_alert: true
                }).catch(() => {});
                await renderRouteCard(chatId, msgId, routeId, atClient.id);
                return;
            }
        }
    }

    if (action === 'accept') {
        const accepted = await db.acceptRouteStop(routeId, stopId);
        if (!['accepted', 'already'].includes(accepted.status)) {
            bot.answerCallbackQuery(query.id, { text: 'Не удалось принять заказ: ' + accepted.status, show_alert: true }).catch(() => {});
            return;
        }
        // До общего старта маршрута у принятого заказа не должно быть кнопки «У клиента».
        // Действия доставки появятся отдельной карточкой после нажатия «Начать маршрут».
        const nextButtons = [
            ...(query.message.reply_markup?.inline_keyboard?.filter(row => row.some(b => b.url)) || [])
        ];
        try { await bot.editMessageReplyMarkup({ inline_keyboard: nextButtons }, { chat_id: chatId, message_id: msgId }); }
        catch (e) { console.error('[DELIVER] edit error:', errorCode(e)); }
        bot.answerCallbackQuery(query.id, { text: accepted.status === 'already' ? 'Заказ уже принят' : 'Заказ принят. Примите остальные заказы маршрута.' }).catch(() => {});
        await notifyAdminStep(routeId, stopId, 'accept', query);

        // Явно показываем курьеру кнопку общего старта маршрута после принятия всех активных заказов.
        // Раньше «У клиента» появлялась сразу после принятия одной остановки, а кнопка старта
        // оставалась только на отдельном экране /start — курьер попадал в тупик на маршруте из одной точки.
        if (accepted.status === 'accepted') {
            const latestRoute = await db.getRouteById(routeId);
            const activeStops = (latestRoute?.stops || []).filter(s =>
                !['cancelled', 'delivered', 'failed'].includes(s.status));
            const waiting = activeStops.filter(s => s.status !== 'accepted' && s.status !== 'in_progress').length;
            const acceptedCount = activeStops.length - waiting;
            if (activeStops.length > 0 && waiting === 0 && latestRoute.status === 'assigned') {
                await bot.sendMessage(chatId,
                    `Все заказы маршрута ${latestRoute.route_number} приняты (${acceptedCount} из ${activeStops.length}). Можно выезжать.`,
                    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
                        { text: 'Начать маршрут', callback_data: `startroute_${routeId}` }
                    ]] } });
            } else if (activeStops.length > 0) {
                await bot.sendMessage(chatId,
                    `Заказ принят. Принято ${acceptedCount} из ${activeStops.length}. Осталось принять: ${waiting}.`);
            }
        }
    }

    else if (action === 'enroute') {
        // В пути: этап сохраняется в базе, карточка показывает его у этого заказа
        const changed = await db.setStopStage(stopId, 'enroute');
        if (!changed) {
            const atClient = await db.getRouteStopAtClient(routeId, stopId);
            if (atClient) {
                bot.answerCallbackQuery(query.id, {
                    text: `Сначала закончите заказ №${atClient.stop_number} (${atClient.order_number || ''}): вы у клиента. Нажмите «Доставлен» или «Не доставлено».`,
                    show_alert: true
                }).catch(() => {});
                await renderRouteCard(chatId, msgId, routeId, atClient.id);
                return;
            }
        }
        await renderRouteCard(chatId, msgId, routeId, stopId);
        bot.answerCallbackQuery(query.id, { text: changed ? 'Вы в пути. Клиент уведомлён.' : 'Этот шаг уже отмечен.' }).catch(() => {});
        if (!changed) return;
        await notifyAdminStep(routeId, stopId, 'enroute', query);

        // Уведомляем только клиента этого заказа; остальные клиенты ничего не получают.
        try {
            const route = await db.getRouteById(routeId);
            const stop = route?.stops?.find(s => parseInt(s.id) === parseInt(stopId));
            try {
                // Обновляем только внутренние ориентиры курьера; ETA клиенту не отправляем.
                await routeSvc.refreshEtas({ routeId, firstStopId: stopId });
            } catch (e) { console.error('[DELIVER] обновление маршрутного листа не удалось:', errorCode(e)); }
            const courier = await db.getCourierByTelegramId(query.from.id);
            const courierPhone = String(courier?.phone || '').trim();
            if (stop?.order_number && stop.status !== 'cancelled') {
                // Карточка заказа обновляется без ETA, а отдельное сообщение сообщает только о выезде.
                await trackerEvent(trackerPool(), stop.order_number, { stage: 'enroute', eta: '', courier: courier?.name || '' }).catch(() => {});
            }
            if (stop?.client_chat_id && stop.status !== 'cancelled') {
                const contact = courierPhone
                    ? `Для уточнения времени прибытия позвоните курьеру ${escapeHtml(courier?.name || '')}: ${escapeHtml(courierPhone)}.`
                    : 'Телефон курьера пока не указан. Для уточнения времени прибытия свяжитесь с нами.';
                await queue.notify('client', stop.client_chat_id,
                    `<b>Заказ ${escapeHtml(stop.order_number)}</b>\n\nСтатус: <b>Курьер выехал</b>\nКурьер везёт ваш заказ.\n${contact}`,
                    { dedupKey: `stop-enroute:${stopId}` });
            }
        } catch (e) { console.error('[DELIVER] notify error:', errorCode(e)); }
    }

    else if (action === 'arrived') {
        const changed = await db.setStopStage(stopId, 'arrived');
        if (!changed) {
            const atClient = await db.getRouteStopAtClient(routeId, stopId);
            if (atClient) {
                bot.answerCallbackQuery(query.id, {
                    text: `Сначала закончите заказ №${atClient.stop_number} (${atClient.order_number || ''}): вы у клиента. Нажмите «Доставлен» или «Не доставлено».`,
                    show_alert: true
                }).catch(() => {});
                await renderRouteCard(chatId, msgId, routeId, atClient.id);
                return;
            }
        }
        await renderRouteCard(chatId, msgId, routeId, stopId);
        bot.answerCallbackQuery(query.id, { text: changed ? 'Клиент уведомлён. Подтвердите передачу заказа.' : 'Этот шаг уже отмечен.' }).catch(() => {});
        if (!changed) return;
        await notifyAdminStep(routeId, stopId, 'arrived', query);

        // Курьер на месте: сообщаем клиенту
        try {
            const route = await db.getRouteById(routeId);
            const stop = route?.stops?.find(s => parseInt(s.id) === parseInt(stopId));
            if (stop?.client_chat_id && stop.status !== 'cancelled') {
                // карточка меняется молча, а это сообщение — уведомление на телефон: клиенту нужно выйти навстречу
                await trackerEvent(trackerPool(), stop.order_number, { stage: 'arrived', eta: '' }).catch(() => {});
                await queue.notify('client', stop.client_chat_id, `<b>Заказ ${escapeHtml(stop.order_number)}</b>\n\nСтатус: <b>Курьер приехал</b>\nКурьер у вас, встречайте заказ.`,
                    { dedupKey: `stop-arrived:${stopId}` });
            }
        } catch (e) { console.error('[DELIVER] notify error:', errorCode(e)); }
    }

    else if (action === 'done') {
        // Сначала атомарно фиксируем доставку. Только первый callback получает status=completed.
        let completion;
        try {
            completion = await db.completeDeliveryStop(stopId);
        } catch (e) {
            console.error('[DELIVER] completion transaction failed:', errorCode(e));
            bot.answerCallbackQuery(query.id, { text: 'Не удалось завершить доставку. Повторите позже.', show_alert: true }).catch(() => {});
            return;
        }

        if (completion.status !== 'completed') {
            const messages = {
                already: 'Доставка уже отмечена.',
                cancelled: 'Заказ отменён. Доставку завершить нельзя.',
                not_found: 'Остановка не найдена.',
                forbidden: 'Нельзя завершить доставку в текущем статусе.'
            };
            bot.answerCallbackQuery(query.id, {
                text: messages[completion.status] || 'Действие не выполнено.',
                show_alert: completion.status !== 'already'
            }).catch(() => {});
            await renderRouteCard(chatId, msgId, routeId, null);
            return;
        }

        // Карточка: этот заказ «доставлен», выбранным становится следующий (тот, к которому уже едет курьер, или первый по порядку).
        await renderRouteCard(chatId, msgId, routeId, null);
        bot.answerCallbackQuery(query.id, { text: 'Заказ доставлен!' }).catch(() => {});

        await notifyAdminStep(routeId, stopId, 'done', query);
        routeSvc.refreshEtas({ routeId, notifyNew: false }).catch(e => console.error('[DELIVER] пересчёт времени не удался:', errorCode(e)));

        // Клиентское уведомление уже записано в outbox в той же транзакции, что и доставка.
        // Здесь обновляем карточку и, если её нет, один раз ставим отдельный запрос оценки.
        try {
            const route = await db.getRouteById(routeId);
            const stop = route?.stops?.find(s => parseInt(s.id) === stopId);
            if (stop?.client_chat_id && stop.status !== 'cancelled') {
                const onCard = await trackerEvent(trackerPool(), stop.order_number, { stage: 'delivered', eta: '', canRate: true }).catch(() => false);
                const courier = onCard ? null : (await db.getCouriers()).find(c => c.id === route?.courier_id);
                if (courier) {
                    const rateButtons = [[1,2,3,4,5].map(n => ({
                        text: String(n),
                        callback_data: `rate_${courier.id}_${stop.id}_${n}`
                    }))];
                    await queue.notify('client', stop.client_chat_id, 'Пожалуйста, оцените доставку:', {
                        buttons: rateButtons,
                        dedupKey: `stop-rating:${stopId}`,
                        delaySec: 3
                    });
                }
            }
        } catch (e) { console.error('[DELIVER] client card/rating update error:', errorCode(e)); }
    }
}

function buildNavButtons(route, stop, nextState) {
    const buttons = [];

    // Кнопки навигации (всегда показываем если есть координаты)
    if (stop.lat && stop.lon) {
        const yandexUrl = MapLinks.yandex(stop.address, parseFloat(stop.lat), parseFloat(stop.lon));
        const gis2Url = MapLinks.gis2(parseFloat(stop.lat), parseFloat(stop.lon));
        buttons.push([
            { text: 'Яндекс Карты', url: yandexUrl },
            { text: '2GIS', url: gis2Url }
        ]);
    }

    // Кнопка действия в зависимости от состояния
    if (nextState === 'enroute') {
        buttons.push([{ text: 'В пути', callback_data: `deliver_${route.id}_${stop.id}_enroute` }]);
    } else if (nextState === 'arrived') {
        buttons.push([{ text: 'У клиента', callback_data: `deliver_${route.id}_${stop.id}_arrived` }]);
    } else if (nextState === 'done') {
        buttons.push([{ text: 'Доставлен', callback_data: `deliver_${route.id}_${stop.id}_done` }]);
    }

    // Кнопка "Не доставлено" (кроме финального состояния)
    if (nextState !== 'done') {
        buttons.push([{ text: 'Не доставлено', callback_data: `failed_${route.id}_${stop.id}` }]);
    }

    return buttons;
}

// ====== Причины не доставки ======

async function showFailureReasons(chatId, routeId, stopId, messageId = null) {
    const route = await db.getRouteById(routeId);
    if (!route) return;
    // Список причин показываем в том же сообщении, что и карточка: новых сообщений не появляется.
    const picker = buildReasonPicker(route, stopId);
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: picker.keyboard } };
    if (messageId) {
        try { await bot.editMessageText(picker.text, { chat_id: chatId, message_id: messageId, ...opts }); return; }
        catch (e) {
            if (/not modified/i.test(String(e && e.message))) return;
            console.error('[ROUTE] Не удалось показать причины в карточке:', errorCode(e));
        }
    }
    await bot.sendMessage(chatId, picker.text, opts);
}

// ====== Обработка результата: заказ не доставлен ======
// «Доставлен» обрабатывает handleDeliveryFlow (action done). Здесь — только недоставка.

async function handleDeliveryResult(routeId, stopId, status, chatId, callbackQueryId, reason = '', routeMessageId = null) {
    const toast = (text, alert = false) => callbackQueryId
        ? bot.answerCallbackQuery(callbackQueryId, { text, show_alert: alert }).catch(() => {}) : null;
    const route = await db.getRouteById(routeId);
    if (!route) { toast('Маршрут не найден'); return; }
    const stop = (route.stops || []).find(s => s.id === stopId);
    if (!stop) { toast('Остановка не найдена'); return; }
    if (stop.status === 'cancelled') {
        if (callbackQueryId) toast('Заказ отменён. Везти его не нужно.', true);
        else bot.sendMessage(chatId, `Заказ ${stop.order_number || ''} отменён, причина недоставки не нужна.`).catch(() => {});
        return;
    }
    if (status !== 'failed') return;

    if (reason === 'Другое') {
        // Просим написать причину; ответ ловит один общий обработчик сообщений (pendingReasons), а не «следующее любое сообщение».
        pendingReasons.set(chatId, { routeId, stopId, messageId: routeMessageId, at: Date.now() });
        toast('Напишите причину одним сообщением');
        const text = `<b>Заказ №${stop.stop_number} ${escapeHtml(stop.order_number || '')}: причина недоставки</b>\nНапишите причину ответным сообщением.`;
        const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Назад, заказ не отмечать', callback_data: `pickstop_${routeId}_${stopId}` }]] } };
        if (routeMessageId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: routeMessageId, ...opts }); return; } catch (e) { /* пришлём новое */ } }
        await bot.sendMessage(chatId, text, opts);
        return;
    }

    let failure;
    try {
        failure = await db.failDeliveryStop(stopId, reason || 'Не указана');
    } catch (e) {
        console.error('[DELIVER] failure transaction failed:', errorCode(e));
        toast('Не удалось сохранить недоставку. Повторите позже.', true);
        return;
    }
    if (!['failed', 'already'].includes(failure.status)) {
        const messages = {
            not_found: 'Остановка не найдена.',
            cancelled: 'Заказ отменён. Недоставку фиксировать нельзя.',
            forbidden: 'Остановка уже завершена или ещё не начата.',
            route_not_started: 'Сначала необходимо начать весь маршрут.'
        };
        toast(messages[failure.status] || 'Не удалось отметить недоставку.', true);
        return;
    }

    // Та же карточка: заказ отмечен «НЕ ДОСТАВЛЕН», текущим становится следующий активный заказ.
    const shown = await renderRouteCard(chatId, routeMessageId, routeId, null);
    try { await routeSvc.refreshEtas({ routeId, notifyNew: false }); }
    catch (e) { console.error('[DELIVER] пересчёт времени после недоставки не удался:', errorCode(e)); }

    const safeReason = String(reason || 'Не указана').slice(0, 300);
    toast(failure.status === 'already' ? 'Недоставка уже отмечена.'
        : (shown ? `Заказ №${stop.stop_number} отмечен как не доставленный.` : 'Недоставка сохранена, но карточку не удалось обновить. Откройте /route.'));
    if (failure.status === 'failed') {
        await notifyAdmin(
            `[ДОСТАВКА] ${escapeHtml(route.route_number)} | НЕ ДОСТАВЛЕНО (точка ${stop.stop_number} из ${(route.stops || []).length})\n` +
            `Заказ: ${escapeHtml(stop.order_number || '')}\nАдрес: ${escapeHtml(stop.address)}\nПричина: ${escapeHtml(safeReason)}\n` +
            'Статус заказа в админке: «Не доставлен». Решите: отправить повторно или отменить.',
            null, `admin-step-failed:${stopId}`);
        if (stop.client_chat_id) {
            await trackerEvent(trackerPool(), stop.order_number, { stage: 'failed', eta: '' }).catch(() => {});
            await queue.notify('client', stop.client_chat_id,
                `<b>Заказ ${escapeHtml(stop.order_number)}</b>\n\nВаш заказ <b>не доставлен</b>.\nПричина: ${escapeHtml(safeReason)}`,
                { dedupKey: `stop-failed:${stopId}` });
        }
    }
}

// Текст причины для «Другое»: принимаем следующее текстовое сообщение курьера (команды отменяют ожидание)
if (bot) {
    bot.on('message', async (msg) => {
        const p = msg && msg.chat ? pendingReasons.get(msg.chat.id) : null;
        if (!p || !msg.text) return;
        if (msg.text.startsWith('/') || Date.now() - p.at > 15 * 60_000) { pendingReasons.delete(msg.chat.id); return; }
        pendingReasons.delete(msg.chat.id);
        const text = msg.text.trim().slice(0, 300);
        await handleDeliveryResult(p.routeId, p.stopId, 'failed', msg.chat.id, null, text === 'Другое' ? 'Другое (без пояснения)' : text, p.messageId);
    });
}

// ====== Оптимизация маршрута ======

async function handleOptimizeRoute(chatId, routeId) {
    // Порядок точек строит система при назначении маршрута (route-service.js). Кнопка осталась в старых сообщениях:
    // показываем актуальный маршрутный лист с временем вместо старого подбора по прямой линии.
    const route = await db.getRouteById(routeId);
    if (!route) return;
    bot.sendMessage(chatId, 'Порядок точек уже рассчитан системой по дорогам. Вот актуальный маршрутный лист:');
    sendRouteDetails(chatId, route);
}

// ====== Обработка фото ======

bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const courier = await getActiveCourier(msg.from);
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
        console.error('[ОШИБКА] Настройка команд курьер-бота:', errorCode(e));
    }
}

setupCourierBotCommands();
} // end if (bot)

// ====== API для диспетчера ======

function registerCourierRoutes(app) {
    app.use(express.json());

    // Webhook endpoint for courier bot
    if (bot && COURIER_BOT_TOKEN) {
        const webhookPath = '/webhook/courier';
        const webhookUrl = (process.env.WEBHOOK_URL || 'https://gulf-bot-production.up.railway.app').replace(/\/+$/, '') + webhookPath;  // WEBHOOK_URL — это база без пути
        
        app.post(webhookPath, verifyWebhookSecret, (req, res) => {
            // Содержимое Telegram update может включать личные данные — не пишем его в логи.
            bot.processUpdate(req.body);
            res.sendStatus(200);
        });

        // Set webhook on startup
        bot.setWebHook(webhookUrl, { secret_token: WEBHOOK_SECRET }).then(() => {
            console.log(`[OK] Courier webhook set: ${webhookUrl}`);
        }).catch(e => {
            console.error('[ОШИБКА] Courier webhook:', errorCode(e));
        });
    }

    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', bots: ['AutoPromoilBot', 'APCourier_Bot'], timestamp: new Date().toISOString() });
    });

    // Состояние системы для владельца (вкладка «Журнал» в админке): связь с базой, очередь уведомлений админ-чату, опрос админ-бота.
    app.get('/api/admin/system-status', verifyAdmin, requirePermission('settings.manage'), async (req, res) => {
        const out = { time: new Date().toISOString(), uptimeSec: Math.round(process.uptime()), db: { ok: false }, outbox: {}, adminPolling: getAdminPollingStatus() };
        try {
            const pool = require('./db').pool;
            const t0 = Date.now();
            await pool.query('SELECT 1');
            out.db = { ok: true, pingMs: Date.now() - t0, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } };
            const r = await pool.query(`SELECT status, COUNT(*)::int AS c FROM notification_outbox WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY status`);
            out.outbox = Object.fromEntries(r.rows.map(x => [x.status, x.c]));
            const old = await pool.query(`SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0)::int AS age FROM notification_outbox WHERE status IN ('pending','sending')`);
            out.outbox.oldestPendingSec = old.rows[0].age;
            const lastAdmin = await pool.query(`SELECT sent_at, last_error FROM notification_outbox WHERE bot = 'admin' AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`);
            out.lastAdminNotificationAt = lastAdmin.rows[0] ? lastAdmin.rows[0].sent_at : null;
            const fail = await pool.query(`SELECT created_at, last_error FROM notification_outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 1`);
            out.lastFailed = fail.rows[0] ? { at: fail.rows[0].created_at, error: String(fail.rows[0].last_error || '').slice(0, 200) } : null;
            const w = require('./widgets').widgetsPausedUntil();
            out.widgetsPausedUntil = w > Date.now() ? new Date(w).toISOString() : null;
        } catch (e) {
            out.db = { ok: false, error: errorCode(e) };
        }
        res.json(out);
    });

    app.get('/api/couriers', verifyAdmin, requirePermission('routes.manage'), async (req, res) => {
        try { res.json(filterCouriersForRole(await db.getCouriers(), req.admin && req.admin.role)); } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    // Старый ручной API отключён: маршруты должны создаваться только через buildRoute,
    // который проверяет READY_FOR_SHIPMENT, исключает самовывоз и защищает от двойного назначения.
    app.post('/api/routes', verifyAdmin, requirePermission('routes.manage'), (req, res) => {
        return res.status(410).json({ error: 'Используйте построение маршрутного листа через /api/routes/build' });
    });;

    app.post('/api/routes/:id/assign', verifyAdmin, requirePermission('routes.manage'), (req, res) => {
        return res.status(410).json({ error: 'Повторное назначение маршрута отключено. Создайте маршрут через /api/routes/build' });
    });;

    // Собрать маршрут из нескольких заказов: система строит порядок и время, курьер получает маршрутный лист
    app.post('/api/routes/build', verifyAdmin, requirePermission('routes.manage'), async (req, res) => {
        try {
            const { order_ids, courier_id } = req.body || {};
            const courier = (await db.getCouriers()).find(c => c.id === parseInt(courier_id));
            if (!courier) return res.status(404).json({ error: 'Курьер не найден' });
            if (!courier.is_active) return res.status(409).json({ error: 'Курьер не активен' });
            const out = await routeSvc.buildRoute({ orderIds: order_ids, courier, notifyAdmin: (t, options = {}) => notifyAdmin(t, null, options.dedupKey, options.db, true) });
            res.json({ success: true, route: filterRouteForRole(out.route, req.admin && req.admin.role), plan: out.plan, sequence: out.sequence });
        } catch (e) {
            const status = { BAD_REQUEST: 400, NOT_FOUND: 404, CONFLICT: 409 }[e.code];
            if (status) return res.status(status).json({ error: e.message });
            console.error('[API /routes/build]', errorCode(e)); res.status(500).json({ error: 'Internal error' });
        }
    });

    app.get('/api/routes', verifyAdmin, requirePermission('routes.manage'), async (req, res) => {
        try { res.json(filterRoutesForRole(await db.getRoutes(), req.admin && req.admin.role)); } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    registerOrderStatsRoutes(app, { db, verifyAdmin });

    app.get('/api/orders', verifyAdmin, requirePermission('orders.view'), async (req, res) => {
        try {
            const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
            const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
            const result = await db.getOrdersPage(page, limit);
            result.items = result.items.map(order => filterOrderListItem(order, req.admin && req.admin.role));
            res.set('Cache-Control', 'no-store');
            res.json(result);
        } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    app.get('/api/orders/customers', verifyAdmin, requirePermission('customers.view'), async (req, res) => {
        try {
            res.set('Cache-Control', 'no-store');
            res.json(await db.getOrderCustomers());
        } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    app.get('/api/orders/:id', verifyAdmin, requirePermission('orders.view'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            const order = await db.getOrderById(id);
            if (!order) return res.status(404).json({ error: 'Order not found' });
            res.set('Cache-Control', 'no-store');
            res.json(filterOrderDetails(order, req.admin && req.admin.role));
        } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    app.get('/api/zones', verifyAdmin, requirePermission('settings.manage'), async (req, res) => {
        try { res.json(await db.getZones()); } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    app.get('/api/geocode', verifyAdmin, requirePermission('settings.manage'), async (req, res) => {
        const address = req.query.address;
        if (!address) return res.status(400).json({ error: 'address required' });
        try {
            const result = await geocoder.geocode(address);
            res.json(result ? { found: true, ...result } : { found: false });
        } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    app.get('/api/map-links', verifyAdmin, requirePermission('settings.manage'), (req, res) => {
        const { address, lat, lon } = req.query;
        if (!address && (!lat || !lon)) return res.status(400).json({ error: 'address or lat/lon required' });
        res.json(MapLinks.all(address || '', parseFloat(lat), parseFloat(lon)));
    });

    app.post('/api/map-links/route', verifyAdmin, requirePermission('routes.manage'), (req, res) => {
        const { stops } = req.body;
        if (!stops || stops.length < 2) return res.status(400).json({ error: 'stops array with 2+ required' });
        res.json(MapLinks.allRoute(stops));
    });

    app.post('/api/routes/:id/optimize', verifyAdmin, requirePermission('settings.manage'), async (req, res) => {
        try {
            const route = await db.getRouteById(parseInt(req.params.id));
            if (!route) return res.status(404).json({ error: 'Route not found' });
            const stops = route.stops || [];
            if (stops.length < 2) return res.json({ message: 'Nothing to optimize', stops });
            const { start_lat, start_lon } = req.body;
            const optimized = RouteOptimizer.optimizeRoute(stops, start_lat || 59.9343, start_lon || 30.3351);
            const distance = RouteOptimizer.calcDistance(optimized, start_lat || 59.9343, start_lon || 30.3351);
            res.json({ route_number: route.route_number, stops: optimized, total_distance_km: distance });
        } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    app.get('/api/dispatch/stats', verifyAdmin, requirePermission('routes.manage'), async (req, res) => {
        try {
            const date = req.query.date || new Date().toISOString().split('T')[0];
            res.json(await db.getDayStats(date));
        } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    // Возвращает полные записи заказов для вкладки диспетчеризации; доступ только у роли с settings.manage.
    // routes.manage сам по себе недостаточен: оператору не нужен полный набор полей orders.
    app.get('/api/dispatch/unassigned-orders', verifyAdmin, requirePermission('settings.manage'), async (req, res) => {
        try { res.json(await db.getOrders()); } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    app.get('/api/analytics', verifyAdmin, requirePermission('settings.manage'), async (req, res) => {
        try {
            const from = req.query.date_from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const to = req.query.date_to || new Date().toISOString().split('T')[0];
            res.json(await db.getAnalytics(from, to));
        } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    // ====== Admin: управление заказами ======
    app.put('/api/orders/:id/status', verifyAdmin, requireOrderStatusPermission, async (req, res) => {
        try {
            const { status } = req.body;
            const valid = ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT', 'READY_FOR_PICKUP', 'PICKED_UP', 'CANCELLED'];
            if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
            const orderId = parseInt(req.params.id);
            const changed = await db.updateOrderStatus(orderId, status, {
                afterUpdate: async ({ order, client }) => {
                    const statusLabels = {
                        NEW: 'Новый', CONFIRMED: 'Подтверждён', ASSEMBLING: 'Сборка',
                        READY_FOR_SHIPMENT: 'Готов к отправке', READY_FOR_PICKUP: 'Готов к выдаче',
                        PICKED_UP: 'Выдан клиенту', SHIPPING: 'В доставке',
                        DELIVERY_FAILED: 'Не доставлен', DELIVERED: 'Доставлен',
                        COMPLETED: 'Выполнен', CANCELLED: 'Отменён'
                    };
                    const label = statusLabels[status];
                    if (!label) return;

                    const cancelBtn = status !== 'CANCELLED' && status !== 'COMPLETED' && status !== 'PICKED_UP'
                        ? [[{ text: 'Отменить заказ', callback_data: `cancel_${orderId}` }]]
                        : null;
                    await notifyAdmin(
                        `<b>Смена статуса</b>\n\n` +
                        `Заказ: <b>${escapeHtml(order.order_number)}</b>\n` +
                        `Клиент: ${escapeHtml(order.user_name || '-') }\n` +
                        `Телефон: ${escapeHtml(order.phone || '-') }\n` +
                        `Адрес: ${escapeHtml(order.address || '-') }\n` +
                        `Сумма: ${parseFloat(order.total || 0).toLocaleString()} руб.\n` +
                        `Статус: <b>${label}</b>`,
                        cancelBtn, `admin-order-status:${order.id}:${status}`, client, true
                    );

                    // Отмену клиенту и курьеру уже ставит cancel-flow в этой же транзакции.
                    if (order.user_id && status !== 'CANCELLED') {
                        const stageMap = { NEW: 'accepted', CONFIRMED: 'accepted', ASSEMBLING: 'assembling', SHIPPING: 'shipping', DELIVERED: 'delivered', COMPLETED: 'delivered', READY_FOR_PICKUP: 'accepted', PICKED_UP: 'delivered' };
                        const finalSt = status === 'DELIVERED' || status === 'COMPLETED';
                        const pickupNotice = status === 'READY_FOR_PICKUP' || status === 'PICKED_UP';
                        const onCard = stageMap[status]
                            ? await trackerEvent(client, order.order_number, {
                                stage: stageMap[status],
                                ...(finalSt ? { eta: '', canRate: true } : {}),
                                ...(status === 'PICKED_UP' ? { eta: '', canRate: false } : {})
                            })
                            : false;
                        if (!onCard || finalSt || pickupNotice) {
                            await queue.notify('client', order.user_id,
                                `<b>Заказ ${escapeHtml(order.order_number)}</b>\n\nСтатус: <b>${label}</b>`,
                                { dedupKey: `client-order-status:${order.id}:${status}`, db: client, throwOnError: true });
                        }
                    }
                }
            });
            if (changed === 'CANCELLED_LOCKED') return res.status(409).json({ error: 'Отменённый заказ нельзя вернуть в работу. Оформите новый заказ.' });
            if (changed === 'TRANSITION_FORBIDDEN') return res.status(409).json({ error: 'Недопустимая смена статуса: доставленный или завершённый заказ нельзя вернуть в работу.' });
            if (!changed) return res.status(404).json({ error: 'Заказ не найден' });
            // Тот же статус уже стоял: повторных сообщений и повторной работы с маршрутом не нужно
            if (changed === 'ALREADY') return res.json({ success: true, unchanged: true });

            // Обновляем маршрут при доставке. Отмена обрабатывается внутри updateOrderStatus (cancel-flow.js):
            // остановка маршрута помечается «отменена», курьеру и клиенту ставятся в очередь сообщения.
            if (status === 'DELIVERED' || status === 'COMPLETED') {
                const routes = await db.getRoutes();
                for (const route of routes) {
                    const stop = (route.stops || []).find(s => String(s.order_id) === String(orderId));
                    if (stop) {
                        const stopStatus = 'delivered';
                        await db.updateStopStatus(stop.id, stopStatus, '');
                        const stops = route.stops || [];
                        const newCompleted = stops.filter(s => s.status === 'delivered' || (s.id === stop.id && stopStatus === 'delivered')).length;
                        const newFailed = stops.filter(s => s.status === 'failed' || (s.id === stop.id && stopStatus === 'failed')).length;
                        const allDone = stops.every(s => s.id === stop.id ? stopStatus !== 'pending' : s.status !== 'pending');
                        const newRouteStatus = allDone ? 'completed' : route.status;
                        await db.updateRouteStatus(route.id, newRouteStatus, newCompleted, newFailed);
                        console.log(`[МАРШРУТ] ${escapeHtml(route.route_number)}: стоп ${stop.id} -> ${stopStatus}, маршрут -> ${newRouteStatus}`);
                        break;
                    }
                }
            }

            res.json({ success: true });
        } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    // Назначить курьера на заказ
    // Совместимый endpoint одиночного назначения: использует тот же маршрутный процесс, что и пакетная отправка.
    app.post('/api/orders/:id/assign', verifyAdmin, requirePermission('routes.manage'), async (req, res) => {
        const orderId = Number(req.params.id);
        if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'Некорректный номер заказа' });
        try {
            let courierId = Number(req.body && req.body.courier_id);
            const couriers = await db.getCouriers();
            if (!courierId) {
                const active = couriers.filter(x => x.is_active);
                if (active.length === 1) courierId = Number(active[0].id);
                else return res.status(400).json({ error: 'Выберите курьера' });
            }
            const courier = couriers.find(x => Number(x.id) === courierId && x.is_active);
            if (!courier) return res.status(404).json({ error: 'Активный курьер не найден' });
            const out = await routeSvc.buildRoute({ orderIds: [orderId], courier, notifyAdmin: (t, options = {}) => notifyAdmin(t, null, options.dedupKey, options.db, true) });
            return res.json({ success: true, route: filterRouteForRole(out.route, req.admin && req.admin.role), plan: out.plan, sequence: out.sequence });
        } catch (e) {
            const status = { BAD_REQUEST: 400, NOT_FOUND: 404, CONFLICT: 409 }[e.code];
            if (status) return res.status(status).json({ error: e.message });
            console.error('[API /orders/assign]', errorCode(e));
            return res.status(500).json({ error: 'Internal error' });
        }
    });;

    // ====== Admin: управление товарами ======
    app.get('/api/products', verifyAdmin, requirePermission('products.view'), async (req, res) => {
        try {
            let catalog = await db.getAllProducts();
            // Если БД пуста — подгружаем из catalog.json (например, при локальном запуске без БД)
            if (!catalog || catalog.length === 0) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const filePath = path.join(__dirname, '..', 'data', 'catalog.json');
                    if (fs.existsSync(filePath)) {
                        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                        const fallbackProducts = raw.products || raw.catalog || raw.items || [];
                        catalog = fallbackProducts.map(p => ({
                            ...p,
                            price: parseFloat(p.price) || 0,
                            old_price: parseFloat(p.old_price) || 0,
                            volume: p.volume || '',
                            image: p.image || p.main_image || ''
                        }));
                    }
                } catch (e) {
                    console.warn('[ПРЕДУПРЕЖДЕНИЕ] Не удалось загрузить catalog.json:', errorCode(e));
                }
            }
            res.json(filterProductsForRole(catalog, req.admin && req.admin.role));
        } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    app.patch('/api/products/:id/stock', verifyAdmin, requirePermission('inventory.manage'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        const validated = validateStockUpdate(req.body);
        if (!validated.ok) return res.status(400).json({ error: validated.error });
        try {
            const product = await db.updateProduct(id, validated.data, { expectedStock: validated.expectedStock });
            if (!product) return res.status(404).json({ error: 'not found' });
            res.json(filterProductsForRole([product], req.admin && req.admin.role)[0]);
        } catch (e) {
            if (e.code === 'STOCK_CONFLICT') return res.status(409).json({ error: 'Остаток уже изменился. Обновите список товаров и повторите корректировку.' });
            console.error('[API]', errorCode(e));
            return res.status(500).json({ error: 'Internal error' });
        }
    });

    app.post('/api/products', verifyAdmin, requirePermission('settings.manage'), async (req, res) => {
        const validated = validateProductPayload(req.body);
        if (!validated.ok) return res.status(400).json({ error: validated.error });
        try {
            let product = await db.createProduct(validated.data);
            if (validated.data.coming_soon === true) product = await db.updateProduct(product.id, { coming_soon: true });
            res.status(201).json(product);
        } catch (e) { { console.error('[API]', errorCode(e)); res.status(500).json({ error: 'Internal error' }); }; }
    });

    app.put('/api/products/:id', verifyAdmin, requirePermission('settings.manage'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        const validated = validateProductPayload(req.body, { partial: true });
        if (!validated.ok) return res.status(400).json({ error: validated.error });
        let expectedStock;
        if (Object.prototype.hasOwnProperty.call(validated.data, 'stock')) {
            if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'expected_stock')) {
                return res.status(400).json({ error: 'Для изменения остатка обязательно передать expected_stock' });
            }
            const expected = validateExpectedStock(req.body.expected_stock);
            if (!expected.ok) return res.status(400).json({ error: expected.error });
            expectedStock = expected.value;
        }
        try {
            const product = await db.updateProduct(id, validated.data, { expectedStock });
            if (!product) return res.status(404).json({ error: 'not found' });
            res.json(product);
        } catch (e) {
            if (e.code === 'STOCK_CONFLICT') return res.status(409).json({ error: 'Остаток уже изменился. Обновите список товаров и повторите корректировку.' });
            console.error('[API]', errorCode(e));
            return res.status(500).json({ error: 'Internal error' });
        }
    });
}
}

module.exports = { registerCourierRoutes, verifyAdmin, getAdminPollingStatus, stopAdminPolling };

console.log('APCourier_Bot module loaded');
