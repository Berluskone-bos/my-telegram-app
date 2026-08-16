/**
 * Скрипт для настройки Telegram Mini App
 *
 * Инструкция:
 * 1. Откройте @BotFather в Telegram
 * 2. Отправьте /newbot
 * 3. Следуйте инструкциям (имя бота, username)
 * 4. Скопируйте полученный токен
 * 5. Запустите этот скрипт: node setup-bot.js
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;

if (!token) {
    console.log('═══════════════════════════════════════════');
    console.log('  НАСТРОЙКА TELEGRAM MINI APP');
    console.log('═══════════════════════════════════════════');
    console.log('');
    console.log('Шаг 1: Создайте бота');
    console.log('  → Откройте @BotFather в Telegram');
    console.log('  → Отправьте /newbot');
    console.log('  → Укажите имя: АВТОПРОМОЙЛ Shop');
    console.log('  → Укажите username: avtopromol_bot');
    console.log('  → Скопируйте токен');
    console.log('');
    console.log('Шаг 2: Настройте токен');
    console.log('  → Создайте файл bot/.env');
    console.log('  → Добавьте строку: BOT_TOKEN=ваш_токен');
    console.log('');
    console.log('Шаг 3: Запустите скрипт снова');
    console.log('  → cd bot && node setup-bot.js');
    console.log('');
    process.exit(0);
}

const bot = new TelegramBot(token, { polling: false });

async function setupBot() {
    console.log('═══════════════════════════════════════════');
    console.log('  НАСТРОЙКА БОТА');
    console.log('═══════════════════════════════════════════');
    console.log('');

    try {
        // 1. Получаем информацию о боте
        console.log('1. Получение информации о боте...');
        const me = await bot.getMe();
        console.log(`   [OK] Бот: @${me.username} (${me.first_name})`);
        console.log('');

        // 2. Устанавливаем команды бота
        console.log('2. Установка команд бота...');
        await bot.setMyCommands([
            { command: 'start', description: 'Открыть магазин' },
            { command: 'shop', description: 'Открыть магазин масел' },
            { command: 'help', description: 'Помощь' },
            { command: 'orders', description: 'Мои заказы' }
        ]);
        console.log('   [OK] Команды установлены');
        console.log('');

        // 3. Устанавливаем описание бота
        console.log('3. Установка описания бота...');
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
        console.log('   [OK] Описание установлено');
        console.log('');

        // 4. Устанавливаем короткое описание
        console.log('4. Установка короткого описания...');
        await bot.setMyShortDescription('Магазин автотоваров АВТОПРОМОЙЛ. Доставка по СПб и ЛО');
        console.log('   [OK] Короткое описание установлено');
        console.log('');

        // 5. Информация о настройке Mini App
        console.log('═══════════════════════════════════════════');
        console.log('  НАСТРОЙКА MINI APP');
        console.log('═══════════════════════════════════════════');
        console.log('');
        console.log('Теперь нужно настроить Mini App в @BotFather:');
        console.log('');
        console.log('1. Откройте @BotFather');
        console.log('2. Отправьте /mybots');
        console.log(`3. Выберите @${me.username}`);
        console.log('4. Перейдите в Bot Settings → Mini Apps');
        console.log('5. Нажмите "Configure Mini App"');
        console.log('6. Укажите URL вашего хостинга (HTTPS)');
        console.log('');
        console.log('Для локального тестирования используйте ngrok:');
        console.log('  → Установите: npm install -g ngrok');
        console.log('  → Запустите: ngrok http 3000');
        console.log('  → Скопируйте HTTPS URL');
        console.log('');

        // 6. Информация о menu button
        console.log('═══════════════════════════════════════════');
        console.log('  НАСТРОЙКА КНОПКИ МЕНЮ');
        console.log('═══════════════════════════════════════════');
        console.log('');
        console.log('Чтобы кнопка "Открыть магазин" appeared в меню:');
        console.log('');
        console.log('1. В @BotFather: /mybots → ваш бот');
        console.log('2. Bot Settings → Menu Button');
        console.log('3. Configure Menu Button');
        console.log('4. Укажите Web App URL');
        console.log('');

        console.log('═══════════════════════════════════════════');
        console.log('  ГОТОВО!');
        console.log('═══════════════════════════════════════════');
        console.log('');
        console.log('Бот настроен. Теперь:');
        console.log('1. Разместите приложение на HTTPS хостинге');
        console.log('2. Настройте Mini App URL в @BotFather');
        console.log('3. Отправьте боту команду /start');
        console.log('');

    } catch (error) {
        console.error('Ошибка:', error.message);
    }
}

setupBot();
