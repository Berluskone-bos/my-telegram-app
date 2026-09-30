# АВТОПРОМОЙЛ — Telegram Mini App

Магазин автотоваров АВТОПРОМОЙЛ для Telegram.

## Быстрый старт

### 1. Создайте Telegram бота

1. Откройте [@BotFather](https://t.me/BotFather) в Telegram
2. Отправьте `/newbot`
3. Укажите имя: `Gulf Western Oil Shop`
4. Укажите username: `gulf_western_shop_bot` (или любой свободный)
5. Скопируйте полученный токен

### 2. Настройте бота

```bash
cd bot
npm install
```

Создайте файл `bot/.env`:
```env
BOT_TOKEN=ваш_токен_от_botfather
ADMIN_CHAT_ID=ваш_chat_id
WEB_APP_URL=https://your-domain.com
PORT=3000
```

Чтобы узнать свой Chat ID:
1. Откройте [@userinfobot](https://t.me/userinfobot)
2. Отправьте любое сообщение
3. Скопируйте ваш Chat ID

### 3. Запустите локально

**Вариант A: С ngrok (для тестирования в Telegram)**

```bash
# Терминал 1: Запустите веб-сервер
cd gulf-western-shop
python -m http.server 3000

# Терминал 2: Запустите ngrok
ngrok http 3000

# Терминал 3: Запустите бота
cd bot
node bot.js
```

**Вариант B: Только локально (в браузере)**

```bash
cd gulf-western-shop
python -m http.server 3000
```

Откройте http://localhost:3000

### 4. Настройте Mini App в Telegram

1. Скопируйте HTTPS URL из ngrok (например: `https://abc123.ngrok-free.app`)
2. Обновите `WEB_APP_URL` в `bot/.env`
3. Перезапустите бота
4. Откройте вашего бота в Telegram
5. Отправьте `/start`
6. Нажмите кнопку "Открыть магазин"

## Структура проекта

```
gulf-western-shop/
├── index.html              # Главная страница Mini App
├── css/
│   └── styles.css          # Стили
├── js/
│   ├── app.js              # Основная логика
│   ├── products.js         # Каталог товаров
│   ├── cart.js             # Корзина
│   ├── favorites.js        # Избранное
│   ├── profile.js          # Профиль и бонусы
│   └── telegram.js         # Telegram WebApp API
├── img/
│   ├── oils/               # Фото масел
│   ├── filters/            # Фото фильтров
│   ├── additives/          # Фото присадок
│   └── banners/            # Баннеры
├── data/
│   └── catalog.json        # Каталог товаров (50 позиций)
├── bot/
│   ├── bot.js              # Telegram-бот
│   ├── setup-bot.js        # Настройка бота
│   ├── package.json
│   ├── .env                # Конфигурация
│   └── .env.example
├── start-local.bat         # Скрипт запуска (Windows)
└── start-local.ps1         # Скрипт запуска (PowerShell)
```

## Команды бота

| Команда | Описание |
|---------|----------|
| `/start` | Приветствие и кнопка открытия магазина |
| `/shop` | Открыть магазин |
| `/help` | Помощь |
| `/orders` | История заказов |

## Каталог товаров

50 товаров в 6 категориях:

| Категория | Кол-во | Примеры |
|-----------|--------|---------|
| Моторные масла | 17 | Syn-X 3000/5000, Premium Diesel, 0W-20, 5W-50 |
| Трансмиссионные | 5 | ATF Automatic, ATF CVT, Gear Oil |
| Фильтры | 10 | Масляные, воздушные, топливные, салона |
| Присадки | 12 | CleanBoost, Anti-Wear, Engine Flush |
| Антифризы | 3 | Готовый -37°C, концентрат |
| Тормозные жидкости | 3 | DOT 4, DOT 5.1 |

## Функции приложения

- 🛒 Каталог с фильтрацией по категориям
- 🔍 Поиск по названию и характеристикам
- ⭐ Сортировка (цена, рейтинг, популярность)
- 📦 Детальная страница товара
- 🛍 Корзина с изменением количества
- ❤️ Избранное
- 👤 Профиль с бонусной системой
- 🚚 Форма заказа с доставкой
- 📲 Уведомления в Telegram

## Деплой на хостинг

### Vercel (бесплатно)

1. Загрузите проект на GitHub
2. Войдите на [vercel.com](https://vercel.com)
3. Импортируйте репозиторий
4. Деплой автоматически

### Netlify (бесплатно)

1. Загрузите проект на GitHub
2. Войдите на [netlify.com](https://netlify.com)
3. Импортируйте репозиторий
4. Деплой автоматически

### Свой сервер

```bash
# Установите nginx
sudo apt install nginx

# Скопируйте файлы
sudo cp -r * /var/www/html/gulf-western/

# Настройте nginx
sudo nano /etc/nginx/sites-available/gulf-western
```

Конфигурация nginx:
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    root /var/www/html/gulf-western;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://localhost:3000;
    }
}
```

## Добавление фотографий

1. Подготовьте фото товаров (400×400 px, JPG)
2. Положите в соответствующие папки:
   - `img/oils/` — моторные и трансмиссионные масла
   - `img/filters/` — фильтры
   - `img/additives/` — присадки и жидкости
3. Обновите пути в `data/catalog.json`

## Обновление цен

Отредактируйте файл `data/catalog.json`. Формат товара:

```json
{
  "id": 1,
  "name": "Syn-X 3000 5W-40",
  "full_name": "Gulf Western Syn-X 3000 5W-40",
  "category": "motor",
  "viscosity": "5W-40",
  "volume": "4 л",
  "price": 4200,
  "old_price": 4800,
  "image": "img/oils/syn-x-3000-5w40-4l.jpg",
  "description": "Описание товара...",
  "specs": { "SAE": "5W-40", "API": "SN/CF" },
  "in_stock": true,
  "is_new": false,
  "is_bestseller": true,
  "rating": 4.8,
  "reviews_count": 24
}
```

## Лицензия

MIT
