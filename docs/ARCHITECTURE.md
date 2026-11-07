# ARCHITECTURE — как собрано (по состоянию на 07.11.2026)

Источник истины — репозиторий `Berluskone-bos/my-telegram-app` (публичный) и сервисы Railway, Neon, GitHub Pages. Раньше в этих документах описывался отдельный сервер на VPS: **он не используется**, его файлы лежат в `archive-vps/` и `to-integrate/`.

## Схема
```
[ Telegram Mini App: index.html + js/ + css/ + data/catalog.json ]   GitHub Pages (публикуется только папка _site)
        │  POST /api/order  (заголовок X-Telegram-Init-Data)
        ▼
[ Railway: bot/bot.js (Express, webhook) ]──► Neon PostgreSQL
        │        └─ bot/courier-bot.js: маршруты, курьеры, /api/couriers, /api/orders (админ)
        ├──► Telegram: клиентский бот, курьерский бот, админ-бот
        ├──► Яндекс.Геокодер (адреса), ссылки на карты, оптимизация маршрута (bot/services/)
        └──► [ ЭКВАЙРИНГ, КАССА 54-ФЗ, «ЧЕСТНЫЙ ЗНАК» ]  — НЕ СДЕЛАНО

[ admin.html на GitHub Pages ] ──► Railway (/api/*, заголовок x-admin-key)
```

## Стек
| Слой | Что используем |
|---|---|
| Фронтенд | HTML5, CSS3, чистый JS (модули `Products`, `Cart`, `Favorites`, `Profile`, `App`), Telegram WebApp API. Каталог: `data/catalog.json` (фолбэк и витрина) |
| Бэкенд | Node.js, Express, `pg`, `node-telegram-bot-api` 0.67 (с `overrides` для безопасных `form-data`, `qs`, `tough-cookie`, `uuid`) |
| База | Neon PostgreSQL. Таблицы (создаёт `bot/db.js`): `products`, `orders`, `couriers`, `delivery_routes`, `route_stops`, `delivery_zones`, `promo_codes` и др. |
| Хостинг | Фронт — GitHub Pages (workflow `deploy-pages.yml`). Бэкенд — Railway (`Procfile`). |
| Секреты (Railway Variables) | `BOT_TOKEN`, `COURIER_BOT_TOKEN`, `ADMIN_BOT_TOKEN`, `ADMIN_CHAT_ID`, `ADMIN_API_KEY`, `WEBHOOK_URL` (база без пути), `WEBHOOK_SECRET`, `DATABASE_URL`, `YANDEX_GEO_KEY`, опц. `ALLOWED_ORIGINS`, `DB_SSL_STRICT` |

## Заказ (как работает сейчас)
1. Клиент оформляет заказ в Mini App → `POST /api/order` с `X-Telegram-Init-Data`.
2. Сервер проверяет подпись initData (HMAC по токену бота), лимит запросов, дедупликацию (60 с), **берёт цены из БД** (`getProductById`), считает доставку по `delivery_zones`.
3. Заказ пишется в БД, уведомление уходит в админ-бот. Статусы меняются из `admin.html` и курьерского бота.
4. Оплаты в системе нет (оплата курьеру/наличными, как в коде) — эквайринг в планах.

## Витрина и заглушки
`data/catalog.json` — 13 товаров первой партии (артикулы ООО «Сан Трип») + 5 «заглушек» (`coming_soon: true`: показываются без цены и кнопки). Цены, по которым идёт оплата, лежат **в Neon** (`products`), а не в `catalog.json`: после смены цен выполнять SQL в Neon.

## Где что лежит в репозитории
```
index.html, admin.html, privacy.html   страницы
js/ css/ img/ data/                    фронтенд и каталог
bot/bot.js                             клиентский бот, /api/order, CORS, лимиты
bot/courier-bot.js                     курьерский бот и админ-API
bot/db.js, db-adapter.js               работа с Neon
bot/services/                          geocoder, map-links, route-optimizer, notifier
.github/workflows/deploy-pages.yml     публикация сайта
```

## Подбор масла (планируется интегрировать)
Цепочка и методы PartsAPI описаны ниже; готовые файлы — в `to-integrate/` (написаны под отдельный сервер, **нужна адаптация** под `bot/` и Neon).
```
VIN → VINdecode → car_id ─┐
марка → модель → модификация (getMakes → getModels → getCars) → CAR_ID ─┤
                                                                    ▼
                                GetFillVolumes (объёмы) + toDopusk (допуски, артикулы)
                                                                    ▼
          допуски машины ∩ допуски наших товаров → «Подходящие товары»
```
Каждый запрос сначала в кэш (`api_cache`), к PartsAPI — только при промахе и пока не исчерпан лимит (по умолчанию 45 в сутки на метод).

| Метод | Назначение | Статус |
|---|---|---|
| `VINdecode` | VIN → авто; ID модификации в `typeNumber`/`carId` | используем |
| `getMakes` / `getModels` / `getCars` | марки (~735, двойники «AUDI (FAW)») → модели → модификации (`CAR_ID`) | используем |
| `GetFillVolumes` (carId) | объёмы заправки; дубли в разных единицах | используем |
| `toDopusk` (typeId) | допуски OEM и артикулы; `volume` = фасовка, не заправка | используем |
| `toOils` | дублирует `oils` из `toDopusk` | не используем |
| `getCarsByOilSpecification` | обратный поиск | не проверен |

⚠ **Не подтверждено:** совпадают ли `CAR_ID` и `typeNumber` с `carId`/`typeId` у `GetFillVolumes`/`toDopusk` (проверять `tools-partsapi/` на реальных ключах — задача A6).

## Известные ограничения
- Лимиты запросов и дедупликация заказов — в памяти процесса (при нескольких копиях сервера не общие).
- Корзина, избранное, «потрачено» хранятся в `localStorage`, скидка по обороту не считается на сервере.
- Живая работа ботов в Telegram, Railway и Neon из среды Claude не проверялась; серверные проверки выполнялись на локальной копии с подставными ответами Telegram.
