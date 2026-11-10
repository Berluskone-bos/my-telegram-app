# ARCHITECTURE — как собрано (по состоянию на 10.11.2026)

Источник истины — репозиторий `Berluskone-bos/my-telegram-app` (публичный) и сервисы Railway, Neon, GitHub Pages. Раньше в этих документах описывался отдельный сервер на VPS: **он не используется**, его файлы лежат в `archive-vps/` и `to-integrate/`.

## Схема
```
[ Telegram Mini App: index.html + js/ + css/ + data/catalog.json ]   GitHub Pages (публикуется только папка _site)
        │  POST /api/order  (заголовок X-Telegram-Init-Data)
        ▼
[ Railway: bot/bot.js (Express, webhook) ]──► Neon PostgreSQL
        │        ├─ bot/courier-bot.js: маршруты, курьеры, /api/couriers, /api/orders, /api/products (админ)
        ├─ bot/oil-routes.js + partsapi-cache.js + oil-systems.js: подбор жидкостей (PartsAPI, кэш в Neon)
        └─ /api/catalog — публичный каталог с остатками (без закупочных цен)
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
| База | Neon PostgreSQL. Таблицы (создаёт `bot/db.js` при старте): `products`, `orders`, `couriers`, `delivery_routes`, `route_stops`, `delivery_zones`, `promo_codes`, `customer_profiles`, `user_garage`, `product_approvals` и таблицы кэша подбора масла |
| Хостинг | Фронт — GitHub Pages (workflow `deploy-pages.yml`). Бэкенд — Railway (`Procfile`). |
| Секреты (Railway Variables) | `BOT_TOKEN`, `COURIER_BOT_TOKEN`, `ADMIN_BOT_TOKEN`, `ADMIN_CHAT_ID`, `ADMIN_API_KEY`, `WEBHOOK_URL` (база без пути), `WEBHOOK_SECRET`, `DATABASE_URL`, `YANDEX_GEO_KEY`, `PARTSAPI_KEY_VINDECODE`, `PARTSAPI_KEY_GETFILLVOLUMES`, `PARTSAPI_KEY_TODOPUSK`, `PARTSAPI_KEY_GETMAKES`, `PARTSAPI_KEY_GETMODELS`, `PARTSAPI_KEY_GETCARS`; опц. `PARTSAPI_DAILY_LIMIT`, `ADMIN_USER_IDS`, `ALLOWED_ORIGINS`, `DB_SSL_STRICT`, `INIT_DATA_TTL_SEC` |

## Заказ (как работает сейчас)
1. Клиент оформляет заказ в Mini App → `POST /api/order` с `X-Telegram-Init-Data`.
2. Сервер проверяет подпись initData (HMAC по токену бота), лимит запросов, `Idempotency-Key` (повтор вернёт тот же заказ), **берёт цены из БД**, считает доставку по `delivery_zones` (СПб: 300 ₽, бесплатно от 5 000 ₽; ЛО — вручную).
3. Заказ пишется в БД в транзакции; остаток товара списывается (`UPDATE … WHERE stock >= qty`, иначе 409 «нет в наличии»); при отмене остаток возвращается; уведомление уходит в админ-бот. Статусы меняются из `admin.html` и курьерского бота.
4. Оплаты в системе нет (оплата курьеру/наличными, как в коде) — эквайринг в планах.

## Витрина и заглушки
`data/catalog.json` — запасная витрина: 13 товаров первой партии (артикулы ООО «Сан Трип») + 5 «заглушек» (`coming_soon: true`: показываются без цены и кнопки). Основной источник — **Neon** (`products`) через `GET /api/catalog` (цены, остатки, `in_stock`, `stock_left` при ≤5); `catalog.json` — запасной вариант. Товары добавляются и правятся в админке (вкладка «Товары»). Учёт остатков включается автоматически, когда у любого активного товара остаток больше 0.

## Где что лежит в репозитории
```
index.html, admin.html, privacy.html   страницы
js/ css/ img/ data/                    фронтенд и каталог
bot/bot.js                             клиентский бот, /api/order, CORS, лимиты
bot/courier-bot.js                     курьерский бот и админ-API
bot/db.js, db-adapter.js               работа с Neon (миграции при старте)
bot/oil-routes.js, oil-systems.js,
bot/partsapi-cache.js                  подбор жидкостей, кэш и лимит PartsAPI
bot/services/                          geocoder, map-links, route-optimizer, notifier
.github/workflows/deploy-pages.yml     публикация сайта
```

## Подбор жидкостей (работает, обновления 9–10)
Файлы лежат в `bot/`; фронтенд — `js/oil.js`, `css/oil.css`. Таблицы в Neon: `api_cache`, `api_request_log`, `vin_lookup`, `vehicles`, `vehicle_fill_volumes`, `vehicle_approvals`, `vehicle_oil_items`, `product_approvals`, `user_garage`.
```
VIN → VINdecode → car_id ─┐
марка → модель → модификация (getMakes → getModels → getCars) → CAR_ID ─┤
                                                                    ▼
                                GetFillVolumes (объёмы) + toDopusk (допуски, спецификации, артикулы)
                                                                    ▼
   oil-systems.js: разбор по системам (двигатель, коробка [автомат/вариатор/робот/механика],
   редукторы, ГУР, антифриз, тормозная, кондиционер, прочее) + подбор наших товаров
```
Подбор товаров по системе, три уровня: **по допуску** (допуск товара совпал с допуском машины и вязкость подходит) → **по вязкости** → **по типу** (для систем без вязкости: ATF, антифриз, тормозная; не для двигателя). В каждом списке до 6 товаров. Для двух последних уровней в интерфейсе стоит «сверьте допуск с руководством». Если VIN не найден (404), приложение предлагает выбор по марке и модели, марка подставляется по коду производителя (WMI).

Эндпоинты: `GET /api/oil/by-vin`, `/makes`, `/models`, `/cars`, `/by-car`, `/usage` (админ); `GET/PUT /api/products/:id/approvals` (админ). Ограничение — 30 запросов в минуту; клиенту показываются только безопасные сообщения (`userError`). Каждый запрос идёт через кэш (`api_cache`), к PartsAPI — только при промахе и пока не исчерпан `PARTSAPI_DAILY_LIMIT` (45 в сутки на метод); пустые ответы кэшируются на 1 день. Ключи — только переменные Railway `PARTSAPI_KEY_*`.

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
- Корзина, избранное, «потрачено» хранятся в `localStorage`, скидка по обороту не считается на сервере (задача C4). Профиль и гараж частично хранятся на сервере (`customer_profiles`, `user_garage`).
- VINdecode опирается на TecDoc и может не знать VIN российской сборки (Z94, XTA и др.).
- Живая работа ботов в Telegram, Railway и Neon из среды Claude не проверялась; серверные проверки выполнялись на локальной копии с подставными ответами Telegram.
