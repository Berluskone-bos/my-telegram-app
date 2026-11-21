# Деплой и эксплуатация АВТОПРОМОЙЛ

Актуальная production-схема: **GitHub Pages + Railway + PostgreSQL на Railway**. Render, Vercel и отдельный VPS не являются текущими production-площадками.

## Production architecture

- Frontend: GitHub Pages — https://berluskone-bos.github.io/my-telegram-app/
- Backend: Railway service `gulf-bot` — Express API и Telegram-боты.
- Database: Railway service `Postgres` — PostgreSQL.
- Health endpoint: https://gulf-bot-production.up.railway.app/api/health

Не создавайте новые проекты и сервисы Railway при обычном обновлении кода. Используйте существующие production services и environment.

## Обычный выпуск изменений

1. Создать отдельную ветку от актуального `main`.
2. Внести ограниченные изменения; обновить `docs/MEMORY.md`, `docs/TASKS.md` и при необходимости `docs/ARCHITECTURE.md`.
3. Запустить локальные проверки:
   ```bash
   npm ci
   npm test
   ```
   PostgreSQL integration tests должны использовать отдельную тестовую БД через `TEST_DATABASE_URL`, никогда production `DATABASE_URL`.
4. Создать Pull Request в `main`.
5. Проверить GitHub Actions: Tests и, для frontend, Deploy to GitHub Pages. Не сливать PR с красными или пропущенными обязательными проверками.
6. После merge проверить, что workflow Pages завершился SUCCESS, а Railway deployment сервиса `gulf-bot` завершился SUCCESS.
7. Проверить Railway environment: `gulf-bot` и `Postgres` Online. Затем выполнить согласованный smoke test: health endpoint, Mini App, уведомления и курьерский маршрут. Не создавать реальный заказ без тестового сценария.
8. Если deployment неуспешен, остановить дальнейшие изменения, изучить build/deploy logs и при необходимости откатить приложение на предыдущий успешный deployment. Не исправлять сбой ручным изменением production DB.

## Railway Variables

Секреты хранятся только в Railway Variables. Не записывайте реальные значения в README, PR, GitHub Actions logs или тестовые фикстуры.

Перечень переменных и назначение поддерживаются в `docs/ARCHITECTURE.md` и `bot/.env.example`. Основные группы:
- токены Telegram-ботов;
- URL и секрет webhook;
- `DATABASE_URL`;
- ключи PartsAPI и геокодера;
- настройки CORS, времени жизни Telegram initData и TLS PostgreSQL.

Основной вход в админ-панель — индивидуальная учётная запись сотрудника и серверная сессия. Не включать legacy `ADMIN_API_KEY` в production.

## Локальные проверки

Требуется Node.js 20+. Команды выполняются из корня репозитория:

```bash
npm ci
npm test
```

Для интеграционных тестов подготовить отдельную тестовую PostgreSQL БД и передать URL через `TEST_DATABASE_URL`. Тесты намеренно блокируют production database. Не обходить защиту и не запускать тесты на рабочей базе.

Windows: `start-bot.bat` запускает основной backend-процесс. Старый `restart-bot.bat`, который завершал все процессы `node.exe`, удалён. Для локального запуска используйте собственные тестовые credentials; не копируйте production tokens в файлы, которые могут попасть в Git.

## Проверка после выпуска

- GitHub Actions: последний run нужного commit — conclusion SUCCESS.
- GitHub Pages: сайт открывается и загружает актуальные JS/CSS/изображения.
- Railway: deployment `gulf-bot` — SUCCESS, service Online, без crash/restart loop.
- PostgreSQL: service Online, том подключён.
- API: `/api/health` отвечает штатно; `/api/catalog` возвращает корректный JSON.
- Telegram: отдельно проверить клиентского бота, уведомления админ-бота и курьерский маршрут.

## Резервное копирование и аварийное восстановление

Наличие автоматических backup у текущего Railway production не подтверждено. Скрипты в `backup/` и документ `docs/BACKUP.md` сами по себе не означают, что резервирование выполняется по расписанию.

До настройки собственного автоматического зашифрованного backup и успешного теста восстановления нельзя считать базу защищённой резервными копиями. Не удалять `backup/`; не выполнять restore поверх production без отдельного плана и проверенной копии.

## Запрещённые действия в рамках обычного deploy

- Не удалять и не пересоздавать Railway Postgres service или его volume.
- Не выполнять SQL миграции вручную на production, если миграция не входит в проверенный релиз.
- Не менять цены, остатки, товары, заказы и учётные записи.
- Не ротировать токены без плана обновления всех зависимых сервисов.
- Не отключать branch protection и не обходить CI.
