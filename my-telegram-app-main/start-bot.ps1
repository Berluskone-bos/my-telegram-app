# Gulf Western Oil — Запуск Telegram бота

Write-Host ""
Write-Host "══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  GULF WESTERN OIL — ЗАПУСК БОТА" -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Переходим в папку бота
Set-Location "$PSScriptRoot\bot"

# Проверяем наличие .env файла
if (-not (Test-Path ".env")) {
    Write-Host "❌ Файл .env не найден!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Создайте файл bot/.env со следующим содержимым:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "BOT_TOKEN=ваш_токен_от_botfather" -ForegroundColor White
    Write-Host "ADMIN_CHAT_ID=ваш_chat_id" -ForegroundColor White
    Write-Host "WEB_APP_URL=https://your-domain.com" -ForegroundColor White
    Write-Host "PORT=3000" -ForegroundColor White
    Write-Host ""
    Read-Host "Нажмите Enter для выхода"
    exit 1
}

# Проверяем наличие node_modules
if (-not (Test-Path "node_modules")) {
    Write-Host "📦 Установка зависимостей..." -ForegroundColor Yellow
    npm install
    Write-Host ""
}

# Запускаем бота
Write-Host "🚀 Запуск бота..." -ForegroundColor Green
Write-Host "   Для остановки нажмите Ctrl+C" -ForegroundColor Gray
Write-Host ""

node bot.js
