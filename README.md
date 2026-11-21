# АВТОПРОМОЙЛ — Telegram Mini App

Магазин автотоваров в Telegram. Коммерческий бренд магазина — **Автопромойл**, Gulf Western Oil — один из брендов продукции.

## Production

| Компонент | Где работает | Назначение |
|---|---|---|
| Mini App и админ-панель | GitHub Pages | Статические страницы, JS, CSS, изображения |
| Backend и Telegram-боты | Railway, service `gulf-bot` | Express API, клиентский, курьерский и административный сценарии |
| База данных | Railway, service `Postgres` | PostgreSQL: товары, заказы, сотрудники, маршруты, уведомления и кэш |

- Mini App: https://berluskone-bos.github.io/my-telegram-app/
- API health: https://gulf-bot-production.up.railway.app/api/health
- Основной бот: @Gulf_Western_Oil_bot
- Railway production: проект `Gulf_Western_Oil_bot`, окружение `production`.

**Не создавайте новый Railway project/service для обычного обновления.** Изменения идут через отдельную Git-ветку и Pull Request в `main`. После успешных проверок и слияния GitHub Actions публикует Pages, а Railway получает обновление из настроенной ветки.

## Разработка и проверки

Требуется Node.js 20 или новее. Установка зависимостей выполняется из корня репозитория, где находится основной `package-lock.json`:

```bash
npm ci
npm test
```

Интеграционные тесты PostgreSQL запускаются только с отдельной тестовой БД через `TEST_DATABASE_URL`. Тестовый набор блокирует использование production DB; не обходите эти проверки и не подставляйте production `DATABASE_URL` в тесты.

Для локального запуска backend нужны корректные переменные окружения (см. `bot/.env.example` и `docs/ARCHITECTURE.md`). Не публикуйте токены, пароли, ключи API, строки подключения и персональные данные. Не копируйте production secrets в репозиторий или тестовые логи.

Windows: `start-bot.bat` запускает основной процесс из корня проекта. Скрипт не завершает посторонние процессы Node.js. Для остановки используйте окно процесса или штатное завершение.

## Каталог

Основной источник товаров, цен и остатков — PostgreSQL (`products`), публичный API — `GET /api/catalog`. Файл `data/catalog.json` — резервный источник для Mini App при недоступности API.

В резервном JSON 18 записей: 13 товаров первой партии и 5 позиций `coming_soon`. Это не означает, что все 18 позиций доступны к заказу. Не редактируйте production-товары, цены или остатки в рамках технической уборки.

## Основные части репозитория

- `index.html`, `admin.html`, `privacy.html` — страницы приложения.
- `js/`, `css/`, `img/`, `data/` — frontend, стили, изображения и резервный каталог.
- `bot/bot.js` — основной Express-сервер, клиентский бот и публичные API.
- `bot/courier-bot.js` — курьерские сценарии и связанные административные API.
- `bot/db.js`, `bot/db-adapter.js` — PostgreSQL, миграции и транзакционные операции.
- `bot/services/`, `bot/oil-*.js`, `bot/partsapi-cache.js` — маршруты, подбор жидкостей и интеграция PartsAPI.
- `test/` — unit и PostgreSQL integration tests.
- `.github/workflows/` — тесты и публикация GitHub Pages.
- `docs/` — архитектура, задачи, память, безопасность, backup и персональные данные.
- `project-files/` — вспомогательные материалы; `archive-vps/` — только исторический архив.

## Важные документы

- `docs/ARCHITECTURE.md` — фактическая схема приложения и сервисов.
- `DEPLOY.md` — порядок публикации и проверки.
- `docs/TASKS.md` — актуальные задачи и технический долг.
- `docs/MEMORY.md` — журнал решений и выполненных изменений.
- `docs/RULES.md` — правила безопасной разработки.
- `docs/BACKUP.md` — резервное копирование и восстановление.
- `docs/PERSONAL_DATA.md` — обработка и размещение персональных данных.

## Правила безопасных изменений

1. Не работать напрямую в `main`; создавать отдельную ветку и PR.
2. Перед изменением проверить вызовы, импорты, workflow, Railway config и тесты.
3. Не удалять файлы только потому, что они не импортируются: проверить скрипты, deploy config и ручные процессы.
4. После изменения обновить `docs/MEMORY.md` и `docs/TASKS.md`; при изменении архитектуры — `docs/ARCHITECTURE.md`.
5. Не менять production DB, товары, цены, остатки, заказы и Railway Variables в рамках уборки без отдельного согласования.
6. Сливать PR только после успешного CI и review diff. После merge проверить GitHub Pages и Railway deployment до статуса SUCCESS.
