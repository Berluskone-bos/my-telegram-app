@echo off
chcp 65001 >nul
echo.
echo ═══════════════════════════════════════════════════════════
echo   GULF WESTERN OIL — ЗАПУСК БОТА
echo ═══════════════════════════════════════════════════════════
echo.

cd /d "%~dp0bot"

echo Проверка зависимостей...
if not exist "node_modules" (
    echo Установка зависимостей...
    call npm install
    echo.
)

echo Запуск бота...
echo Для остановки нажмите Ctrl+C
echo.
node bot.js

pause
