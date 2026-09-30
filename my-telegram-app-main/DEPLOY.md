# Деплой АВТОПРОМОЙЛ

## Архитектура

```
GitHub Pages (бесплатно)          Railway.app / Render.com (бесплатно)
┌─────────────────────┐          ┌─────────────────────┐
│  Фронтенд (сайт)    │          │  Бот (Node.js)      │
│  - index.html        │          │  - Обработка /start │
│  - css/              │          │  - Приём заказов    │
│  - js/               │          │  - Уведомления      │
│  - data/catalog.json │          │  - Express API      │
└─────────────────────┘          └─────────────────────┘
         │                                │
         └────────── Telegram ────────────┘
```

## Шаг 1: Фронтенд на GitHub Pages

Фронтенд автоматически деплоится при push в ветку `main`.
URL: https://berluskone-bos.github.io/my-telegram-app/

Для включения GitHub Pages:
1. Откройте репозиторий на GitHub
2. Settings → Pages
3. Source: "GitHub Actions"
4. Сохраните

## Шаг 2: Деплой бота

### Вариант A: Railway.app (рекомендуется)

1. Откройте https://railway.app → Login with GitHub
2. New Project → Deploy from GitHub repo → `my-telegram-app`
3. Перейдите в Variables и добавьте:

```
BOT_TOKEN = ваш_токен_от_botfather
ADMIN_CHAT_ID = ваш_chat_id
WEB_APP_URL = https://berluskone-bos.github.io/my-telegram-app/
```

4. Railway автоматически найдёт `Procfile` и запустит бота
5. Проверьте логи — должны видеть:
   ```
   ✅ BOT_TOKEN: задан
   ✅ Кнопка меню "Открыть магазин" установлена
   🤖 Бот запущен и ожидает сообщения...
   ```

### Вариант B: Render.com

1. Откройте https://render.com → New Web Service
2. Подключите GitHub репозиторий
3. Настройки:
   - Build Command: `npm install`
   - Start Command: `node bot/bot.js`
4. Добавьте переменные окружения (Environment)
5. Deploy

### Вариант C: Локально (для отладки)

```bash
# Установите зависимости
cd bot && npm install

# Создайте bot/.env файл:
# BOT_TOKEN=ваш_токен
# ADMIN_CHAT_ID=ваш_chat_id
# WEB_APP_URL=https://berluskone-bos.github.io/my-telegram-app/

# Запустите бота
node bot.js
```

## Получение токена и Chat ID

1. **BOT_TOKEN**: Откройте @BotFather → `/newbot` → скопируйте токен
2. **ADMIN_CHAT_ID**: Откройте @userinfobot → отправьте сообщение → скопируйте ID

## Проверка работы

### Бот:
Откройте @Gulf_Western_Oil_bot → `/start` → должна появиться кнопка "Открыть магазин"

### Кнопка меню:
После запуска бота в чате появится кнопка 🛒 внизу экрана

### Сайт:
https://berluskone-bos.github.io/my-telegram-app/

### API:
https://ваш-проект.railway.app/api/health

## Обновление каталога

1. Отредактируйте `data/catalog.json`
2. Загрузите на GitHub:
   ```bash
   git add -A
   git commit -m "Обновление каталога"
   git push
   ```
3. GitHub Pages обновится автоматически
4. Бот на Railway перезапустится автоматически
