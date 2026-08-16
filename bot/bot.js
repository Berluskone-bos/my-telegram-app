require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');

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

const bot = new TelegramBot(token, { polling: true });
console.log('Бот запущен и ожидает сообщения...');
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
    if (msg.web_app_data) {
        const chatId = msg.chat.id;
        let orderData;

        try {
            orderData = JSON.parse(msg.web_app_data.data);
        } catch (e) {
            console.error('[ОШИБКА] Парсинг данных от Mini App:', e.message);
            bot.sendMessage(chatId, 'Произошла ошибка при обработке заказа. Попробуйте еще раз.');
            return;
        }

        console.log('Получены данные от Mini App:', JSON.stringify(orderData, null, 2));

        if (orderData.type === 'order') {
            await handleNewOrder(chatId, orderData);
        }
    }
});

// ═══════════════════════════════════════════
// ОБРАБОТКА ЗАКАЗОВ
// ═══════════════════════════════════════════

async function handleNewOrder(chatId, order) {
    const orderId = Date.now().toString().slice(-6);
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

    if (ADMIN_CHAT_ID) {
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
            await bot.sendMessage(ADMIN_CHAT_ID, adminMsg, { parse_mode: 'HTML' });
            console.log('[OK] Уведомление отправлено администратору');
        } catch (err) {
            console.error('[ОШИБКА] Отправка уведомления администратору:', err.message);
        }
    } else {
        console.log('[ВНИМАНИЕ] ADMIN_CHAT_ID не задан — уведомление не отправлено');
    }
}

// ═══════════════════════════════════════════
// EXPRESS СЕРВЕР (для статических файлов и API)
// ═══════════════════════════════════════════

app.use(express.static(path.join(__dirname, '..')));
app.use(express.json());

app.post('/api/order', async (req, res) => {
    const order = req.body;
    console.log('Получен заказ через API:', JSON.stringify(order, null, 2));

    if (ADMIN_CHAT_ID) {
        const itemsList = order.items
            .map(i => `- ${i.name} (${i.volume}) x ${i.qty} = ${(i.price * i.qty).toLocaleString()} руб.`)
            .join('\n');

        const msg =
            `<b>НОВЫЙ ЗАКАЗ (API)!</b>\n\n` +
            `<b>Клиент:</b> ${order.userName || 'Не указано'}\n` +
            `<b>Телефон:</b> ${order.phone}\n` +
            `<b>Адрес:</b> ${order.address}\n\n` +
            `<b>Товары:</b>\n${itemsList}\n\n` +
            `<b>Сумма:</b> ${order.total.toLocaleString()} руб.`;

        try {
            await bot.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
        } catch (err) {
            console.error('[ОШИБКА] Отправка:', err.message);
        }
    }

    res.json({ success: true, orderId: Date.now() });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`Веб-сервер запущен: http://localhost:${PORT}`);
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

bot.on('polling_error', (error) => {
    console.error('[ОШИБКА] Polling:', error.code, error.message);
});

process.on('SIGINT', () => {
    console.log('');
    console.log('Остановка бота...');
    bot.stopPolling();
    process.exit(0);
});
