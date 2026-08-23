require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db-adapter');

const app = express();
const token = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PORT = process.env.PORT || 3000;
const WEB_APP_URL = process.env.WEB_APP_URL;

// ═══════════════════════════════════════════
// ПРОВЕРКА КОНФИГУРАЦИИ
// ═══════════════════════════════════════════

console.log('');
console.log('═══════════════════════════════════════════');
console.log('  АВТОПРОМОЙЛ — ЗАПУСК БОТА');
console.log('═══════════════════════════════════════════');
console.log('');

if (!token) {
    console.error('[ОШИБКА] BOT_TOKEN не задан!');
    console.error('   Откройте файл bot/.env и добавьте токен от @BotFather');
    process.exit(1);
}
console.log('[OK] BOT_TOKEN: задан');

if (!ADMIN_CHAT_ID) {
    console.warn('[ВНИМАНИЕ] ADMIN_CHAT_ID не задан — уведомления о заказах не будут отправляться');
} else {
    console.log('[OK] ADMIN_CHAT_ID: ' + ADMIN_CHAT_ID);
}

if (!WEB_APP_URL) {
    console.error('[ОШИБКА] WEB_APP_URL не задан!');
    console.error('   Откройте файл bot/.env и добавьте URL вашего Mini App');
    process.exit(1);
}
console.log('[OK] WEB_APP_URL: ' + WEB_APP_URL);
console.log('');

// ═══════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ БОТА
// ═══════════════════════════════════════════

const bot = new TelegramBot(token, { polling: false });
console.log('Бот запущен (webhook mode)...');
console.log('');

// ═══════════════════════════════════════════
// АВТОМАТИЧЕСКАЯ НАСТРОЙКА БОТА
// ═══════════════════════════════════════════

async function setupBotOnStart() {
    try {
        await bot.setMyCommands([
            { command: 'start', description: 'Открыть магазин' },
            { command: 'help', description: 'Помощь' }
        ]);
        console.log('[OK] Команды бота установлены');

        await bot.setChatMenuButton({
            menu_button: {
                type: 'web_app',
                text: 'Открыть магазин',
                web_app: { url: WEB_APP_URL }
            }
        });
        console.log('[OK] Кнопка меню "Открыть магазин" установлена');

        await bot.setMyDescription(
            'Магазин автотоваров АВТОПРОМОЙЛ\n\n' +
            'Откройте магазин через кнопку меню или команду /shop\n\n' +
            '- Моторные масла\n' +
            '- Трансмиссионные масла\n' +
            '- Фильтры\n' +
            '- Присадки\n' +
            '- Антифризы\n' +
            '- Тормозные жидкости\n\n' +
            'Доставка по СПб и ЛО'
        );
        console.log('[OK] Описание бота установлено');

    } catch (err) {
        console.error('[ОШИБКА] Настройка бота:', err.message);
    }
}

setupBotOnStart();

// ═══════════════════════════════════════════
// ОБРАБОТКА КОМАНД БОТА
// ═══════════════════════════════════════════

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Покупатель';

    console.log(`/start от ${userName} (ID: ${chatId})`);

    bot.sendMessage(chatId,
        `<b>Добро пожаловать в АВТОПРОМОЙЛ, ${userName}!</b>\n\n` +
        `Мы предлагаем качественные автомасла и расходники с доставкой по Санкт-Петербургу и Ленинградской области.\n\n` +
        `<b>Наш ассортимент:</b>\n` +
        `- Моторные масла (синтетика, полусинтетика, минералка)\n` +
        `- Трансмиссионные масла\n` +
        `- Фильтры (масляные, воздушные, салона)\n` +
        `- Присадки и жидкости\n` +
        `- Антифризы\n` +
        `- Тормозные жидкости\n\n` +
        `Нажмите кнопку ниже, чтобы открыть магазин.`, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{
                    text: 'Открыть магазин',
                    web_app: { url: WEB_APP_URL }
                }]
            ]
        }
    }).then(() => {
        console.log(`[OK] /start ответ отправлен ${userName}`);
    }).catch(e => {
        console.error(`[ОШИБКА] /start sendMessage: ${e.message}`);
    });
});

bot.onText(/\/shop/, (msg) => {
    const chatId = msg.chat.id;
    console.log(`/shop от ${msg.from.first_name} (ID: ${chatId})`);

    bot.sendMessage(chatId, 'Нажмите кнопку, чтобы открыть магазин:', {
        reply_markup: {
            inline_keyboard: [
                [{
                    text: 'Открыть магазин АВТОПРОМОЙЛ',
                    web_app: { url: WEB_APP_URL }
                }]
            ]
        }
    });
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    console.log(`/help от ${msg.from.first_name} (ID: ${chatId})`);

    bot.sendMessage(chatId,
        `<b>Помощь</b>\n\n` +
        `<b>Команды:</b>\n` +
        `/start — Приветствие и открытие магазина\n` +
        `/help — Эта справка\n\n` +
        `<b>Как сделать заказ:</b>\n` +
        `1. Откройте магазин через кнопку\n` +
        `2. Выберите товары\n` +
        `3. Добавьте в корзину\n` +
        `4. Укажите адрес и телефон\n` +
        `5. Подтвердите заказ\n\n` +
        `<b>Доставка:</b>\n` +
        `- Санкт-Петербург (в пределах КАД) — бесплатно от 5000 руб.\n` +
        `- Ленинградская область — по тарифам транспортной компании\n\n` +
        `<b>Оплата:</b>\n` +
        `- Наличные при получении\n` +
        `- Перевод на карту\n` +
        `- Онлайн-оплата (скоро)\n\n` +
        `<b>Документы:</b>\n` +
        `<a href="https://berluskone-bos.github.io/my-telegram-app/privacy.html">Политика конфиденциальности</a>\n\n` +
        `<b>Контакты:</b>\n` +
        `8-800-555-35-35 (бесплатно)\n` +
        `@avtopromol_support`,
        { parse_mode: 'HTML' });
});

bot.onText(/\/orders/, (msg) => {
    const chatId = msg.chat.id;
    console.log(`/orders от ${msg.from.first_name} (ID: ${chatId})`);

    bot.sendMessage(chatId,
        `<b>Ваши заказы</b>\n\n` +
        `Для просмотра истории заказов откройте магазин и перейдите в раздел "Профиль" - "История заказов".`, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{
                    text: 'Открыть историю заказов',
                    web_app: { url: WEB_APP_URL }
                }]
            ]
        }
    });
});

// ═══════════════════════════════════════════
// ОБРАБОТКА ДАННЫХ ОТ MINI APP
// ═══════════════════════════════════════════

bot.on('message', async (msg) => {
    console.log('[СООБЩЕНИЕ] от:', msg.from?.first_name, 'web_app_data:', !!msg.web_app_data);
    if (msg.web_app_data) {
        const chatId = msg.chat.id;
        console.log('[MINI APP] Получены данные от Mini App, длина:', msg.web_app_data.data.length);
        let orderData;

        try {
            orderData = JSON.parse(msg.web_app_data.data);
            console.log('[MINI APP] Тип данных:', orderData.type);
        } catch (e) {
            console.error('[ОШИБКА] Парсинг данных от Mini App:', e.message);
            bot.sendMessage(chatId, 'Произошла ошибка при обработке заказа. Попробуйте еще раз.');
            return;
        }

        if (orderData.type === 'order') {
            console.log('[MINI APP] Обрабатываем заказ...');
            await handleNewOrder(chatId, orderData);
        } else {
            console.log('[MINI APP] Неизвестный тип данных:', orderData.type);
        }
    }
});

// ═══════════════════════════════════════════
// ОБРАБОТКА ЗАКАЗОВ
// ═══════════════════════════════════════════

async function saveOrderToFile(orderId, order) {
    try {
        console.log(`[БД] Сохраняем заказ AP-${orderId}...`);
        const result = await db.createOrder({
            order_number: 'AP-' + orderId,
            user_id: order.userId || null,
            user_name: order.userName || '',
            phone: order.phone || '',
            address: order.address || '',
            zone: order.zone || 'spb',
            city: order.city || '',
            street: order.street || '',
            house: order.house || '',
            entrance: order.entrance || '',
            apartment: order.apartment || '',
            items: order.items || [],
            total: order.total || 0,
            discount: order.discount || 0,
            delivery_type: order.deliveryType || 'delivery',
            payment: order.payment || 'cash',
            comment: order.comment || '',
            status: 'NEW',
            payment_status: 'PENDING'
        });
        console.log(`[БД] Заказ AP-${orderId} сохранён:`, result ? result.id : 'нет ID');
    } catch (e) {
        console.error('[ОШИБКА] Сохранение заказа в БД:', e.message);
        console.error('[ОШИБКА] Стек:', e.stack);
    }
}

async function handleNewOrder(chatId, order) {
    const orderId = Date.now().toString().slice(-6);

    // Сохраняем заказ в БД для курьерской системы
    await saveOrderToFile(orderId, order);

    const itemsList = order.items
        .map(i => `- ${i.name} (${i.volume}) x ${i.qty} = ${(i.price * i.qty).toLocaleString()} руб.`)
        .join('\n');

    const zoneName = order.zone === 'spb' ? 'Санкт-Петербург (КАД)' : 'Ленинградская область';

    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log(`  НОВЫЙ ЗАКАЗ #${orderId}`);
    console.log('═══════════════════════════════════════════');
    console.log(`Клиент: ${order.userName}`);
    console.log(`Телефон: ${order.phone}`);
    console.log(`Адрес: ${order.address}`);
    console.log(`Сумма: ${order.total} руб.`);
    console.log('');

    try {
        await bot.sendMessage(chatId,
            `<b>Заказ оформлен!</b>\n\n` +
            `<b>Номер заказа:</b> #${orderId}\n` +
            `<b>Дата:</b> ${new Date().toLocaleString('ru-RU')}\n\n` +
            `<b>Товары:</b>\n${itemsList}\n\n` +
            `<b>Сумма:</b> ${order.total.toLocaleString()} руб.${order.discount > 0 ? ` (скидка ${order.discount}%)` : ''}\n` +
            `<b>Доставка:</b> ${zoneName}\n` +
            `<b>Адрес:</b> ${order.address}\n\n` +
            `Мы свяжемся с вами в ближайшее время для подтверждения заказа.`,
            { parse_mode: 'HTML' });
        console.log('[OK] Подтверждение отправлено покупателю');
    } catch (err) {
        console.error('[ОШИБКА] Отправка подтверждения:', err.message);
    }

    if (ADMIN_CHAT_ID && process.env.ADMIN_BOT_TOKEN) {
        const adminMsg =
            `<b>НОВЫЙ ЗАКАЗ #${orderId}!</b>\n\n` +
            `<b>Клиент:</b> ${order.userName || 'Не указано'}\n` +
            `<b>Телефон:</b> ${order.phone}\n` +
            `<b>Адрес:</b> ${order.address}\n` +
            `<b>Доставка:</b> ${zoneName}\n\n` +
            `<b>Товары:</b>\n${itemsList}\n\n` +
            `<b>Сумма:</b> ${order.total.toLocaleString()} руб.${order.discount > 0 ? ` (скидка ${order.discount}%)` : ''}\n\n` +
            `<b>Оплата:</b> При получении\n` +
            `<b>Дата:</b> ${new Date().toLocaleString('ru-RU')}`;

        try {
            const https = require('https');
            const payload = JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: adminMsg, parse_mode: 'HTML' });
            const url = new URL(`https://api.telegram.org/bot${process.env.ADMIN_BOT_TOKEN}/sendMessage`);
            const options = { hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
            await new Promise((resolve, reject) => {
                const req = https.request(options, (res) => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body)); });
                req.on('error', reject);
                req.write(payload);
                req.end();
            });
            console.log('[OK] Уведомление отправлено в админ-бот');
        } catch (err) {
            console.error('[ОШИБКА] Отправка в админ-бот:', err.message);
        }
    } else {
        console.log('[ВНИМАНИЕ] ADMIN_BOT_TOKEN не задан — уведомление не отправлено');
    }
}

// ═══════════════════════════════════════════
// EXPRESS СЕРВЕР (для статических файлов и API)
// ═══════════════════════════════════════════

app.use(express.static(path.join(__dirname, '..')));
app.use(express.json());

// CORS — разрешаем запросы с GitHub Pages и Telegram Mini App
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Подключаем API курьер-бота
try {
    const { registerCourierRoutes } = require('./courier-bot');
    registerCourierRoutes(app);
    console.log('[OK] Курьер-бот API подключён');
} catch (e) {
    console.warn('[ВНИМАНИЕ] Курьер-бот не загружен:', e.message);
}

app.post('/api/order', async (req, res) => {
    const order = req.body;
    const orderId = Date.now().toString().slice(-6);
    console.log('Получен заказ через API:', JSON.stringify(order, null, 2));

    // Сохраняем заказ в БД
    await saveOrderToFile(orderId, order);

    if (ADMIN_CHAT_ID && process.env.ADMIN_BOT_TOKEN) {
        const itemsList = (order.items || [])
            .map(i => `- ${i.name} (${i.volume}) x ${i.qty} = ${(i.price * i.qty).toLocaleString()} руб.`)
            .join('\n');

        const msg =
            `<b>НОВЫЙ ЗАКАЗ #${orderId} (API)!</b>\n\n` +
            `<b>Клиент:</b> ${order.userName || 'Не указано'}\n` +
            `<b>Телефон:</b> ${order.phone}\n` +
            `<b>Адрес:</b> ${order.address}\n\n` +
            `<b>Товары:</b>\n${itemsList}\n\n` +
            `<b>Сумма:</b> ${order.total.toLocaleString()} руб.`;

        try {
            const https = require('https');
            const payload = JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: msg, parse_mode: 'HTML' });
            const url = new URL(`https://api.telegram.org/bot${process.env.ADMIN_BOT_TOKEN}/sendMessage`);
            const options = { hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
            await new Promise((resolve, reject) => {
                const req = https.request(options, (res) => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body)); });
                req.on('error', reject);
                req.write(payload);
                req.end();
            });
        } catch (err) {
            console.error('[ОШИБКА] Отправка в админ-бот:', err.message);
        }
    }

    res.json({ success: true, orderId: orderId });
});

// Webhook endpoint for main bot
const webhookPath = '/webhook/main';
app.post(webhookPath, (req, res) => {
    console.log('[WEBHOOK] Received update:', JSON.stringify(req.body).substring(0, 200));
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/webhook-info', async (req, res) => {
    try {
        const info = await bot.getWebHookInfo();
        res.json(info);
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Инициализация БД и запуск сервера
db.init().then(async () => {
    await db.seedProductsFromCatalog();
    app.listen(PORT, async () => {
        console.log(`Веб-сервер запущен: http://localhost:${PORT}`);
        
        // Set webhook for main bot
        const webhookUrl = `https://gulf-bot-production.up.railway.app${webhookPath}`;
        try {
            await bot.setWebHook(webhookUrl);
            console.log(`[OK] Main webhook set: ${webhookUrl}`);
        } catch (e) {
            console.error('[ОШИБКА] Main webhook:', e.message);
        }
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  БОТ ГОТОВ К РАБОТЕ!');
    console.log('═══════════════════════════════════════════');
    console.log('');
    console.log('Команды бота:');
    console.log('  /start  — Приветствие и открытие магазина');
    console.log('  /shop   — Открыть магазин');
    console.log('  /help   — Помощь');
    console.log('  /orders — Мои заказы');
    console.log('');
    console.log('Для остановки нажмите Ctrl+C');
    console.log('');
    });
}).catch(e => {
    console.error('[ОШИБКА] Инициализация БД:', e.message);
    process.exit(1);
});



process.on('unhandledRejection', (reason, promise) => {
    console.error('[ОШИБКА] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[ОШИБКА] Uncaught exception:', err.message);
});

process.on('SIGINT', () => {
    console.log('');
    console.log('Остановка бота...');
    bot.stopPolling();
    process.exit(0);
});
