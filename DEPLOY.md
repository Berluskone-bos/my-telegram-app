# Деплой Gulf Western Oil

## Архитектура

```
GitHub Pages (бесплатно)          Railway.app (бесплатно)
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

## Шаг 1: Загрузить фронтенд на GitHub Pages

Фронтенд уже на GitHub Pages:
https://berluskone-bos.github.io/my-telegram-app/

## Шаг 2: Деплой бота на Railway.app (бесплатно)

### 2.1. Зарегистрируйтесь на Railway

1. Откройте https://railway.app
2. Нажмите "Login with GitHub"
3. Авторизуйтесь через GitHub

### 2.2. Создайте проект

1. Нажмите "New Project"
2. Выберите "Deploy from GitHub repo"
3. Найдите репозиторий `my-telegram-app`
4. Нажмите "Deploy"

### 2.3. Добавьте переменные окружения

1. В проекте нажмите на сервис
2. Перейдите в "Variables"
3. Добавьте переменные:

```
BOT_TOKEN = 8002826024:AAH7vy9AgUfoIv7j0Y3Wt3zfg7cO3an_z0o
ADMIN_CHAT_ID = 695826264
WEB_APP_URL = https://berluskone-bos.github.io/my-telegram-app/
```

### 2.4. Добавьте Procfile

Railway автоматически найдёт файл `Procfile` в корне проекта.

### 2.5. Проверьте деплой

1. Перейдите в "Deployments"
2. Дождитесь успешного деплоя
3. Проверьте логи — должны видеть:
   ```
   ✅ BOT_TOKEN: задан
   ✅ ADMIN_CHAT_ID: 695826264
   ✅ WEB_APP_URL: https://berluskone-bos.github.io/my-telegram-app/
   🤖 Бот запущен и ожидает сообщения...
   ```

### 2.6. Протестируйте бота

1. Откройте @Gulf_Western_Oil_bot в Telegram
2. Отправьте `/start`
3. Должна появиться кнопка "Открыть магазин"

## Альтернативы Railway

### Render.com (бесплатно)

1. Откройте https://render.com
2. Создайте "New Web Service"
3. Подключите GitHub репозиторий
4. Настройки:
   - Build Command: `npm install`
   - Start Command: `node bot/bot.js`
5. Добавьте переменные окружения
6. Deploy

### Fly.io (бесплатно)

```bash
# Установите flyctl
curl -L https://fly.io/install.sh | sh

# Авторизуйтесь
fly auth login

# Инициализируйте проект
fly launch

# Добавьте переменные
fly secrets set BOT_TOKEN=ваш_токен
fly secrets set ADMIN_CHAT_ID=695826264
fly secrets set WEB_APP_URL=https://berluskone-bos.github.io/my-telegram-app/

# Деплой
fly deploy
```

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

## Проверка работы

### Проверить бота:
Откройте @Gulf_Western_Oil_bot → /start

### Проверить сайт:
Откройте https://berluskone-bos.github.io/my-telegram-app/

### Проверить API бота:
Откройте https://ваш-проект.railway.app/api/health
