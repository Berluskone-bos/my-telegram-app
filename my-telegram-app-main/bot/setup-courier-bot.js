// Настройка команд курьер-бота в BotFather
const TelegramBot = require('node-telegram-bot-api');

const COURIER_BOT_TOKEN = process.env.COURIER_BOT_TOKEN || '8495118590:AAEM_9w9zxHI6D6YIHEe6w0wLp1c0US01hM';

const bot = new TelegramBot(COURIER_BOT_TOKEN, { polling: false });

async function setup() {
    console.log('Настройка курьер-бота @APCourier_Bot...\n');

    // Устанавливаем команды
    const commands = [
        { command: 'start', description: 'Регистрация / главный экран' },
        { command: 'route', description: 'Текущий маршрутный лист' },
        { command: 'today', description: 'Сегодняшние доставки' },
        { command: 'done', description: 'Отметить доставку выполненной' },
        { command: 'status', description: 'Статус смены' },
        { command: 'help', description: 'Справка' }
    ];

    try {
        await bot.setMyCommands(commands);
        console.log('[OK] Команды установлены:');
        commands.forEach(c => console.log(`  /${c.command} — ${c.description}`));
    } catch (e) {
        console.error('[ОШИБКА]', e.message);
    }

    // Устанавливаем описание
    try {
        await bot.setMyDescription('Бот курьеров АВТОПРОМОЙЛ. Маршрутные листы, навигация, подтверждение доставки.');
        console.log('\n[OK] Описание бота установлено');
    } catch (e) {
        console.error('[ОШИБКА] Описание:', e.message);
    }

    // Устанавливаем короткое описание
    try {
        await bot.setMyShortDescription('Доставка АВТОПРОМОЙЛ');
        console.log('[OK] Короткое описание установлено');
    } catch (e) {
        console.error('[ОШИБКА] Короткое описание:', e.message);
    }

    console.log('\nНастройка завершена!');
}

setup().catch(console.error);
